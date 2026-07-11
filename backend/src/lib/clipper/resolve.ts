// Clipper metadata resolver: given any yt-dlp-supported URL (TikTok, Instagram, X/Twitter,
// Reddit, Vimeo, etc.), dump its metadata (no download) for a preview card. Mirrors the
// `-J` (metadata-only JSON dump) pattern used by lib/youtube/summarize.ts's
// ensureSavedVideoMeta and routes/youtube.ts's GET /formats/:videoId.

import { spawn } from 'node:child_process'
import { ytDlpBin, withYtDlpSlot } from '@/lib/ytdlp'
import { assertPublicUrl } from '@/lib/ssrfGuard'

// A wedged yt-dlp holds one of only 6 global slots forever; a hard timeout releases it.
const YTDLP_TIMEOUT_MS = 30_000

export interface ClipFormat {
  formatId: string
  ext: string
  resolution: string
  note: string
  protocol: string
  vcodec: string
  acodec: string
  filesize: number | null
}

export interface ClipMeta {
  title: string
  thumbnailUrl: string | null
  durationSeconds: number | null
  extractor: string | null
  formats: ClipFormat[]
}

interface YtDlpFormatRaw {
  format_id?: string | number
  ext?: string
  resolution?: string
  height?: number
  format_note?: string
  protocol?: string
  vcodec?: string
  acodec?: string
  filesize?: number
  filesize_approx?: number
}

interface YtDlpMetaRaw {
  title?: string
  thumbnail?: string
  duration?: number
  extractor?: string
  extractor_key?: string
  formats?: YtDlpFormatRaw[]
}

function runYtDlpJson(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Trailing `--` terminates option parsing so a URL starting with `-`/`--` can't be read
    // as a yt-dlp flag (e.g. --config-location → arbitrary options incl. --exec).
    const proc = spawn(ytDlpBin(), ['-J', '--no-playlist', '--no-warnings', '--', url], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let errTail = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, YTDLP_TIMEOUT_MS)
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { errTail = (errTail + d.toString()).slice(-2048) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error(`yt-dlp timed out after ${YTDLP_TIMEOUT_MS}ms`))
      else if (code === 0) resolve(out)
      else reject(new Error(errTail.trim().split('\n').filter(Boolean).slice(-2).join(' | ') || `yt-dlp exited ${code}`))
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

/** Basic scheme/host sanity check before we ever shell out to yt-dlp with user input. */
function isPlausibleUrl(input: string): boolean {
  try {
    const u = new URL(input)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Resolve preview metadata for a pasted URL: title, thumbnail, duration, extractor name, and
 * a shortlist of available formats. Throws a clean, user-facing error when the site isn't
 * supported, the content is private/unavailable, or the URL is malformed.
 */
export async function resolveClip(url: string): Promise<ClipMeta> {
  const trimmed = url.trim()
  if (!isPlausibleUrl(trimmed)) throw new Error('That doesn\'t look like a valid URL.')
  // Refuse internal targets: yt-dlp's generic extractor would otherwise fetch localhost /
  // metadata / LAN services on our behalf (blind SSRF).
  await assertPublicUrl(trimmed)

  let json: string
  try {
    json = await withYtDlpSlot(() => runYtDlpJson(trimmed))
  } catch (err) {
    // yt-dlp's own error text is developer-facing (extractor names, tracebacks) — surface a
    // friendly message instead, matching the sentinel convention used by stream.ts.
    throw new Error('Couldn\'t read that link — the site may not be supported, or the content is private or unavailable.')
  }

  let meta: YtDlpMetaRaw
  try {
    meta = JSON.parse(json) as YtDlpMetaRaw
  } catch {
    throw new Error('Couldn\'t read that link — the site returned something we didn\'t understand.')
  }

  const formats: ClipFormat[] = (meta.formats ?? [])
    .filter((f) => f.format_id != null && (f.vcodec !== 'none' || f.acodec !== 'none'))
    .map((f) => ({
      formatId: String(f.format_id),
      ext: f.ext ?? '',
      resolution: f.resolution ?? (f.height ? `${f.height}p` : 'audio'),
      note: f.format_note ?? '',
      protocol: f.protocol ?? '',
      vcodec: f.vcodec ?? 'none',
      acodec: f.acodec ?? 'none',
      filesize: f.filesize ?? f.filesize_approx ?? null,
    }))

  return {
    title: meta.title ?? '',
    thumbnailUrl: meta.thumbnail ?? null,
    durationSeconds: typeof meta.duration === 'number' ? Math.round(meta.duration) : null,
    extractor: meta.extractor_key ?? meta.extractor ?? null,
    formats,
  }
}
