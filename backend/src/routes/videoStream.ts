// On-demand real-video stream for any hub source, used by the watch page for Picture-in-
// Picture and the mini-player. TikTok/Vimeo normally play through their cross-origin embed
// iframe (instant, no yt-dlp), but PiP and a same-origin <video> mini-player both require a
// real <video> element that an embed can't provide. When the user asks for PiP/minimize we
// swap to this endpoint, which extracts + pipes a progressive MP4 on demand (~a few seconds),
// mirroring YouTube's private-proxy PiP handoff. Mounted at /api/vstream (kept out of the
// hub's main /api/videos route to stay a small, self-contained addition).

import { Hono } from 'hono'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { requireAuth } from '@/middleware/auth'
import { getProvider } from '@/lib/videos/registry'
import { ytDlpBin } from '@/lib/ytdlp'
import type { AppEnv } from '@/types'

export const videoStreamRoute = new Hono<AppEnv>()

videoStreamRoute.get('/:source/:id', requireAuth, async (c) => {
  const provider = getProvider(c.req.param('source'))
  if (!provider) return c.json({ error: 'unknown source' }, 404)

  // The provider's downloadSpec gives the canonical page URL; we override its format with a
  // single progressive MP4 so the muxed stream pipes to stdout cleanly (merged separate
  // audio+video can't stream — mp4 muxing needs a seekable output).
  let spec: Awaited<ReturnType<typeof provider.downloadSpec>>
  try { spec = await provider.downloadSpec(c.req.param('id'), 'video') } catch { return c.json({ error: 'not streamable' }, 404) }
  if (spec.method !== 'ytdlp') return c.json({ error: 'not streamable' }, 404)

  const args = ['-f', 'mp4/best[ext=mp4]/best/b', '--no-playlist', '--no-warnings', '-o', '-', spec.url]
  const proc = spawn(ytDlpBin(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let errTail = ''
  proc.stderr.on('data', (d: Buffer) => { errTail = (errTail + d.toString()).slice(-2048) })
  c.req.raw.signal.addEventListener('abort', () => { try { proc.kill('SIGTERM') } catch { /* already gone */ } }, { once: true })
  proc.on('error', () => {})
  proc.stdout.once('error', () => {})

  // First-byte guard: surface a real error if yt-dlp dies immediately, instead of a 200 that
  // carries zero bytes. Pulled through the async iterator so no early chunk is dropped.
  let exitCode: number | null = null
  const closed = new Promise<void>((resolve) => proc.once('close', (code) => { exitCode = code; resolve() }))
  const iter = proc.stdout[Symbol.asyncIterator]() as AsyncIterator<Buffer>
  const first = await iter.next()
  if (first.done) {
    await closed
    if (exitCode !== 0) {
      return c.json({ error: `stream failed: ${errTail.trim().split('\n').slice(-2).join(' | ').slice(-300) || 'yt-dlp exited early'}` }, 502)
    }
  }
  const prefixed = (async function* () {
    if (!first.done) yield first.value
    while (true) {
      const next = await iter.next()
      if (next.done) return
      yield next.value
    }
  })()
  const body = Readable.toWeb(Readable.from(prefixed)) as unknown as ReadableStream
  return new Response(body, { headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'private, max-age=0' } })
})
