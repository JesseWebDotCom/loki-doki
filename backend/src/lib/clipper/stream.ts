// Clipper direct-play resolver: given any yt-dlp-supported source URL, resolve a directly
// playable (progressive — non-HLS, non-fragmented) file URL for the route to proxy with
// Range support, mirroring routes/youtube.ts's stream proxy. Unlike YouTube's stream.ts,
// there's no InnerTube fast-path here — arbitrary sites always go through yt-dlp.

import { spawn } from 'node:child_process'
import { ytDlpBin, withYtDlpSlot } from '@/lib/ytdlp'

/** Sentinel: the source only offers HLS/fragmented formats we can't byte-range proxy.
 *  The route turns this into a friendly "direct play isn't available, save it instead". */
export const NO_DIRECT_PLAY = 'no-direct-play' as const

interface YtDlpFormatRaw {
  format_id?: string | number
  protocol?: string
  vcodec?: string
  acodec?: string
  height?: number
  tbr?: number
  fragments?: unknown[]
  url?: string
}

interface YtDlpMetaRaw { formats?: YtDlpFormatRaw[] }

function runYtDlp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlpBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let errTail = ''
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { errTail = (errTail + d.toString()).slice(-2048) })
    proc.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(errTail.trim().split('\n').filter(Boolean).slice(-2).join(' | ') || `yt-dlp exited ${code}`))
    })
    proc.on('error', reject)
  })
}

// A format is "progressive" (single file, byte-range-able) when it isn't HLS/DASH and has
// no fragment list — i.e. yt-dlp -g against it returns one plain HTTP(S) URL for the whole
// file, exactly what our Range-passthrough proxy needs.
function isProgressive(f: YtDlpFormatRaw): boolean {
  const proto = (f.protocol ?? '').toLowerCase()
  if (proto.includes('m3u8') || proto.includes('dash')) return false
  if (f.fragments && f.fragments.length) return false
  return true
}

/**
 * Resolve a direct-play URL for a source URL: picks the best progressive format available,
 * then resolves it to a real (possibly signed) URL via `yt-dlp -g -f <format>`. Returns
 * NO_DIRECT_PLAY when only HLS/fragmented formats exist (out of scope — no transcoding).
 */
export async function resolveDirectPlayUrl(sourceUrl: string): Promise<string | typeof NO_DIRECT_PLAY> {
  const json = await withYtDlpSlot(() => runYtDlp(['-J', '--no-playlist', '--no-warnings', sourceUrl]))
  let meta: YtDlpMetaRaw
  try { meta = JSON.parse(json) as YtDlpMetaRaw } catch { throw new Error('Could not read video info') }

  const candidates = (meta.formats ?? []).filter(isProgressive)
  if (!candidates.length) return NO_DIRECT_PLAY

  const best = candidates.slice().sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.tbr ?? 0) - (a.tbr ?? 0))[0]!
  const formatId = String(best.format_id)

  const out = await withYtDlpSlot(() => runYtDlp(['-g', '-f', formatId, '--no-playlist', '--no-warnings', sourceUrl]))
  const url = out.split('\n').map((l) => l.trim()).find(Boolean) ?? null
  if (!url) return NO_DIRECT_PLAY
  return url
}
