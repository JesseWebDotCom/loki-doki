// Direct-stream resolver for the privacy proxy. yt-dlp does the hard part — solving
// YouTube's signature cipher and `n`-parameter throttling — and hands us a direct
// googlevideo.com URL. The route then streams those bytes through our own server, so
// the browser talks only to us, never to Google (no embed, no cookies, no tracking,
// no ads). googlevideo URLs are IP-locked to whoever fetched them and expire after a
// few hours, so resolution and the byte-proxy must both happen here on the backend.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { logger } from '@/lib/logger'
import { ytDlpBin, withYtDlpSlot } from '@/lib/youtube/ytdlp'

const execFileAsync = promisify(execFile)

export type StreamKind = 'video' | 'audio'
// Privacy-proxy quality. Progressive (single-file, muxed) MP4 only goes up to 720p on
// YouTube — higher resolutions are split into separate DASH video+audio streams that a
// plain <video> can't play without muxing — so these are the meaningful choices.
export type StreamQuality = 'auto' | '720' | '360'
const QUALITIES: StreamQuality[] = ['auto', '720', '360']
export const parseQuality = (q: string | undefined): StreamQuality =>
  (QUALITIES as string[]).includes(q ?? '') ? (q as StreamQuality) : 'auto'

// YouTube video ids are exactly 11 chars of [A-Za-z0-9_-]. Validate before shelling out
// so a crafted id can't waste a subprocess or steer yt-dlp at a non-YouTube extractor.
export const isValidVideoId = (id: string): boolean => /^[A-Za-z0-9_-]{11}$/.test(id)

// Only ever proxy bytes from YouTube's own CDN — never an arbitrary host the resolver
// might return — so the proxy can't be turned into an SSRF gadget.
function isAllowedUpstream(url: string): boolean {
  try {
    const h = new URL(url).hostname
    return h === 'youtube.com' || h.endsWith('.youtube.com') || h.endsWith('.googlevideo.com')
  } catch { return false }
}

// Progressive (muxed audio+video) MP4 for video — a single file the browser can play
// directly without us muxing DASH streams. itag 22 = 720p, itag 18 = 360p. Audio mode
// pulls the best m4a-compatible audio-only stream.
function formatFor(kind: StreamKind, quality: StreamQuality): string {
  if (kind === 'audio') return 'bestaudio[ext=m4a]/bestaudio'
  switch (quality) {
    case '360': return '18/best[ext=mp4][height<=360][acodec!=none][vcodec!=none]/worst[acodec!=none][vcodec!=none]'
    case '720': return '22/best[ext=mp4][height<=720][acodec!=none][vcodec!=none]/18'
    default:    return 'best[ext=mp4][acodec!=none][vcodec!=none]/22/18/best[acodec!=none][vcodec!=none]'
  }
}

interface CachedUrl { url: string; expires: number }
// googlevideo URLs carry their own `expire` epoch; we re-resolve well before that.
const TTL_MS = 4 * 60 * 60 * 1000
const cache = new Map<string, CachedUrl>()

function cacheKey(videoId: string, kind: StreamKind, quality: StreamQuality) { return `${videoId}:${kind}:${quality}` }

/** Resolve (and cache) a directly-playable URL for a video, via yt-dlp. */
export async function resolveStreamUrl(videoId: string, kind: StreamKind, quality: StreamQuality = 'auto'): Promise<string | null> {
  if (!isValidVideoId(videoId)) return null
  const now = Date.now()
  const key = cacheKey(videoId, kind, quality)
  const hit = cache.get(key)
  if (hit && hit.expires > now) return hit.url
  if (hit) cache.delete(key) // expired

  try {
    const { stdout } = await withYtDlpSlot(() => execFileAsync(ytDlpBin(), [
      '-f', formatFor(kind, quality),
      '-g', '--no-warnings', '--no-playlist',
      `https://www.youtube.com/watch?v=${videoId}`,
    ], { timeout: 25_000, maxBuffer: 4 * 1024 * 1024 }))

    // -g prints one URL per selected stream; the first line is our progressive/audio URL.
    const url = stdout.split('\n').map(l => l.trim()).find(Boolean) ?? null
    if (!url || !isAllowedUpstream(url)) {
      if (url) logger.warn(`[youtube/stream] refusing non-YouTube upstream host for ${videoId}`)
      return null
    }
    if (cache.size > 500) sweepExpired() // keep the cache from growing unbounded
    cache.set(key, { url, expires: now + TTL_MS })
    return url
  } catch (err) {
    logger.warn(`[youtube/stream] resolve failed for ${videoId} (${kind}): ${err}`)
    return null
  }
}

function sweepExpired(): void {
  const now = Date.now()
  for (const [k, v] of cache) if (v.expires <= now) cache.delete(k)
}

/** Drop a cached URL (e.g. after an upstream 403 — the signature likely rotated). */
export function invalidateStreamUrl(videoId: string, kind: StreamKind, quality: StreamQuality = 'auto'): void {
  cache.delete(cacheKey(videoId, kind, quality))
}
