// Cover-art helpers for Music Studio tracks. Two sources, one output
// (music/studio/<id>/cover.jpg):
//   • catalog picks  → Cover Art Archive front image (from the release-group MBID)
//   • uploads        → the file's own embedded art, via ffmpeg
// Both are best-effort: a track with no art just shows a placeholder in the UI.

import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { ensureFfmpeg } from '@/lib/ffmpeg'
import { itunesAlbumCover } from '@/lib/music/catalog'
import { searxngImageSearch } from '@/lib/searxng'
import { logger } from '@/lib/logger'

const CAA_BASE = 'https://coverartarchive.org'

/** Fetch a remote image URL to `outPath`. Validates http(s) + image content + a sane size.
 *  Returns true on success. Never throws. */
async function downloadImage(url: string, outPath: string, signal?: AbortSignal): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return false
  try {
    const res = await fetch(url, { redirect: 'follow', signal: signal ?? AbortSignal.timeout(15_000) })
    if (!res.ok) return false
    const ct = res.headers.get('content-type') ?? ''
    if (ct && !ct.startsWith('image/')) return false
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength < 1024) return false
    await writeFile(outPath, buf)
    return true
  } catch { return false }
}

/** Download the Cover Art Archive front image for a release-group MBID to `outPath`.
 *  CAA 302s to the real asset or 404s when there's no art. Returns true on success. */
export async function downloadCaaCover(releaseGroupMbid: string, outPath: string, signal?: AbortSignal): Promise<boolean> {
  if (!releaseGroupMbid) return false
  return downloadImage(`${CAA_BASE}/release-group/${releaseGroupMbid}/front-500`, outPath, signal)
}

/**
 * Resolve the best available cover for a track, server-side (once), through the same fallback
 * chain the rest of the Music app uses: Cover Art Archive → iTunes → SearXNG web image search.
 * Writes the winner to `outPath`. Returns true if any source produced an image; false leaves
 * the client to render a deterministic generated cover. Never throws.
 */
export async function fetchBestCover(
  opts: { albumMbid?: string | null; artist?: string | null; album?: string | null; title?: string | null },
  outPath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const artist = (opts.artist ?? '').trim()
  const album = (opts.album ?? '').trim()
  const title = (opts.title ?? '').trim()

  // 1. Cover Art Archive (exact release-group match).
  if (opts.albumMbid && await downloadCaaCover(opts.albumMbid, outPath, signal)) return true

  // 2. iTunes album art (keyless, needs artist + album name).
  if (artist && (album || title)) {
    try {
      const url = await itunesAlbumCover(artist, album || title)
      if (url && await downloadImage(url, outPath, signal)) return true
    } catch { /* keep going */ }
  }

  // 3. Web image search via the local SearXNG (returns [] when not installed).
  if (artist && (title || album)) {
    try {
      const q = `${artist} ${album || title} album cover`.trim()
      const imgs = await searxngImageSearch(q, 4)
      for (const img of imgs) {
        if (await downloadImage(img.imageUrl, outPath, signal)) return true
        if (img.thumbnailUrl && await downloadImage(img.thumbnailUrl, outPath, signal)) return true
      }
    } catch { /* fall through */ }
  }

  logger.debug(`[studio] no cover found for "${artist} - ${title || album}"`)
  return false
}

/** Extract embedded cover art (ID3 APIC / FLAC picture / MP4 covr) from `input` to `outPath`
 *  as JPEG. Returns true if a non-empty image was written. */
export async function extractEmbeddedCover(input: string, outPath: string, signal?: AbortSignal): Promise<boolean> {
  const ff = await ensureFfmpeg()
  const ok = await new Promise<boolean>((resolve) => {
    // -map 0:v grabs the attached-picture stream (the only video stream in an audio file);
    // -frames:v 1 writes a single JPEG. Exits non-zero when there's no embedded art.
    const child = spawn(ff, ['-y', '-i', input, '-map', '0:v', '-frames:v', '1', '-c:v', 'mjpeg', outPath], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', () => { signal?.removeEventListener('abort', onAbort); resolve(false) })
    child.on('close', (code) => { signal?.removeEventListener('abort', onAbort); resolve(code === 0) })
  })
  if (!ok) return false
  try { return statSync(outPath).size > 512 } catch { return false }
}
