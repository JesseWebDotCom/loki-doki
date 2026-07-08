// On-demand real-video stream for any hub source, used by the watch page for Picture-in-
// Picture and the mini-player. TikTok/Vimeo normally play through their cross-origin embed
// iframe (instant, no yt-dlp), but PiP and a same-origin <video> mini-player both require a
// real <video>. We can't proxy the CDN URL directly (TikTok signs it to yt-dlp's exact
// session and 403s anyone else) and we can't pipe `yt-dlp -o -` (the muxed MP4's moov atom
// lands at the end, so the browser never starts playing and just spins). So the clip is
// downloaded to a cache file once (yt-dlp, or ffmpeg-remuxed for HLS sources like Reddit's
// v.redd.it) and we serve THAT with Range support — a complete file plays regardless of
// moov position, seeks, and is instant on repeat. Mounted at /api/vstream, kept out of the
// main /api/videos route.

import { Hono } from 'hono'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { requireAuth } from '@/middleware/auth'
import { getProvider } from '@/lib/videos/registry'
import { ytDlpBin } from '@/lib/ytdlp'
import { ensureFfmpeg, ffmpegBin } from '@/lib/ffmpeg'
import type { AppEnv } from '@/types'

const CACHE_DIR = join(process.cwd(), 'data', 'cache', 'vstream')
// One in-flight download per file, so concurrent PiP + minimize on the same video don't race
// two yt-dlp processes onto the same path.
const inFlight = new Map<string, Promise<boolean>>()

function download(path: string, url: string, method: 'ytdlp' | 'hls'): Promise<boolean> {
  const existing = inFlight.get(path)
  if (existing) return existing
  const p = (async () => {
    let bin: string
    let args: string[]
    if (method === 'hls') {
      // Reddit's v.redd.it: yt-dlp needs account auth on the page, but the HLS manifest on
      // the media CDN doesn't — same ffmpeg remux the offline-save path uses (download.ts).
      // v.redd.it is already h264/aac, so -c copy stays browser-playable.
      await ensureFfmpeg()
      bin = ffmpegBin()
      args = ['-y', '-loglevel', 'error', '-i', url,
        '-c', 'copy', '-movflags', '+faststart', '-bsf:a', 'aac_adtstoasc', path]
    } else {
      bin = ytDlpBin()
      args = [
        // Prefer H.264 (avc1) so every browser can play it — yt-dlp's "best" often picks HEVC
        // (bytevc1) which Chrome refuses in <video>. Downloading to a file lets us merge
        // separate A/V tracks, so a merged avc1+aac wins before any progressive HEVC.
        '-f', 'best[ext=mp4][vcodec^=avc1][acodec!=none]/best[ext=mp4][vcodec^=h264][acodec!=none]/bestvideo[vcodec^=avc1]+bestaudio/best[ext=mp4][acodec!=none]/mp4/best',
        '--no-playlist', '--no-warnings', '--merge-output-format', 'mp4',
        '--force-overwrites', '-o', path, url,
      ]
    }
    const ok = await new Promise<boolean>((resolve) => {
      const proc = spawn(bin, args, { stdio: 'ignore', windowsHide: true })
      proc.on('close', (code) => resolve(code === 0 && existsSync(path)))
      proc.on('error', () => resolve(false))
    })
    // A failed ffmpeg run can leave a partial mp4 behind, which existsSync would treat as
    // a valid cache hit on the next request — remove it so retries start clean.
    if (!ok) await rm(path, { force: true }).catch(() => {})
    return ok
  })().finally(() => inFlight.delete(path))
  inFlight.set(path, p)
  return p
}

export const videoStreamRoute = new Hono<AppEnv>()

videoStreamRoute.get('/:source/:id', requireAuth, async (c) => {
  const source = c.req.param('source')
  const id = c.req.param('id')
  const provider = getProvider(source)
  if (!provider) return c.json({ error: 'unknown source' }, 404)

  let spec: Awaited<ReturnType<typeof provider.downloadSpec>>
  try { spec = await provider.downloadSpec(id, 'video') } catch { return c.json({ error: 'not streamable' }, 404) }
  if (spec.method !== 'ytdlp' && spec.method !== 'hls') return c.json({ error: 'not streamable' }, 404)

  await mkdir(CACHE_DIR, { recursive: true })
  const path = join(CACHE_DIR, `${source}-${id.replace(/[^\w.-]/g, '_')}.mp4`)
  if (!existsSync(path)) {
    const ok = await download(path, spec.url, spec.method)
    if (!ok) return c.json({ error: 'could not prepare this video for streaming' }, 502)
  }

  const size = (await stat(path)).size
  const range = c.req.header('range')
  const commonHeaders = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=0' }
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range)
    const start = m ? parseInt(m[1], 10) : 0
    const end = m && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1
    if (start >= size || start > end) return c.json({ error: 'range not satisfiable' }, 416)
    const body = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream
    return new Response(body, { status: 206, headers: { ...commonHeaders, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } })
  }
  const body = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream
  return new Response(body, { headers: { ...commonHeaders, 'Content-Length': String(size) } })
})
