// Direct-stream resolver for the privacy proxy. yt-dlp does the hard part — solving
// YouTube's signature cipher and `n`-parameter throttling — and hands us a direct
// googlevideo.com URL. The route then streams those bytes through our own server, so
// the browser talks only to us, never to Google (no embed, no cookies, no
// tracking). googlevideo URLs are IP-locked to whoever fetched them and expire after a
// few hours, so resolution and the byte-proxy must both happen here on the backend.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { logger } from '@/lib/logger'
import { ytDlpBin, withYtDlpSlot } from '@/lib/youtube/ytdlp'
import { innertubePlayerStreams, type ItStreams } from '@/lib/youtube/innertube'

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
//
// `[protocol^=https]` is critical: YouTube also exposes muxed MP4 as HLS (itags 91–96,
// protocol m3u8), and a bare `best[ext=mp4][acodec!=none][vcodec!=none]` happily picks one
// of those because they're higher-res — but a plain <video> can't play an HLS manifest
// outside Safari, and our byte-proxy can't segment it. So pin to the real progressive
// itags (22/18) first, then only ever fall back to a direct-https muxed MP4.
function formatFor(kind: StreamKind, quality: StreamQuality): string {
  if (kind === 'audio') return 'bestaudio[ext=m4a]/bestaudio'
  // Direct-https muxed MP4 (excludes HLS) at a height ceiling, used as the fallback.
  const mux = (cap = '') => `best[ext=mp4]${cap}[acodec!=none][vcodec!=none][protocol^=https]`
  switch (quality) {
    case '360': return `18/${mux('[height<=360]')}/18`
    case '720': return `22/18/${mux('[height<=720]')}`
    default:    return `22/18/${mux()}`
  }
}

interface CachedUrl { url: string; expires: number }
// googlevideo URLs carry their own `expire` epoch; we re-resolve well before that.
const TTL_MS = 4 * 60 * 60 * 1000
const cache = new Map<string, CachedUrl>()
// In-flight resolves keyed the same as the cache, so a prewarm and the real stream
// request for the same video share ONE yt-dlp run instead of spawning two (which would
// serialize behind the yt-dlp slot and double the wait).
const inflight = new Map<string, Promise<string | null>>()

function cacheKey(videoId: string, kind: StreamKind, quality: StreamQuality) { return `${videoId}:${kind}:${quality}` }

// Pick the best progressive (muxed) URL the ANDROID client offered for this quality.
// Progressive tops out at 720p (itag 22) — and often only 360p (itag 18) survives — so
// this gives the same ceiling yt-dlp would for a single-file stream, just faster.
function pickProgressive(streams: ItStreams, quality: StreamQuality): string | null {
  const prog = streams.progressive
    .filter(f => f.url && (f.height ?? 0) > 0)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
  if (!prog.length) return null
  const chosen = quality === '360'
    ? (prog.find(f => (f.height ?? 0) <= 360) ?? prog[prog.length - 1])
    : (prog.find(f => (f.height ?? 0) <= 720) ?? prog[0])   // auto / 720 → best ≤720
  return chosen?.url ?? null
}

/**
 * Resolve (and cache) a directly-playable URL for a video. Video streams try the fast
 * InnerTube/ANDROID path first (no subprocess) and fall back to yt-dlp; audio always uses
 * yt-dlp. `forceYtDlp` skips the fast path (used when an InnerTube URL has just 403'd).
 */
export async function resolveStreamUrl(videoId: string, kind: StreamKind, quality: StreamQuality = 'auto', forceYtDlp = false): Promise<string | null> {
  if (!isValidVideoId(videoId)) return null
  const now = Date.now()
  const key = cacheKey(videoId, kind, quality)
  const hit = cache.get(key)
  if (hit && hit.expires > now) return hit.url
  if (hit) cache.delete(key) // expired

  // Coalesce concurrent resolves (e.g. prewarm + the real stream request) onto one run.
  // `forceYtDlp` is a deliberate post-403 re-resolve, so it always runs fresh.
  if (!forceYtDlp) {
    const pending = inflight.get(key)
    if (pending) return pending
  }
  const p = doResolveStreamUrl(videoId, kind, quality, forceYtDlp, key, now)
  if (!forceYtDlp) {
    inflight.set(key, p)
    void p.finally(() => { if (inflight.get(key) === p) inflight.delete(key) })
  }
  return p
}

async function doResolveStreamUrl(videoId: string, kind: StreamKind, quality: StreamQuality, forceYtDlp: boolean, key: string, now: number): Promise<string | null> {
  // Fast path (video only): one JSON call to the ANDROID client beats spawning yt-dlp.
  if (kind === 'video' && !forceYtDlp) {
    try {
      const streams = await innertubePlayerStreams(videoId)
      const url = streams ? pickProgressive(streams, quality) : null
      if (url && isAllowedUpstream(url)) {
        if (cache.size > 500) sweepExpired()
        cache.set(key, { url, expires: now + TTL_MS })
        return url
      }
    } catch (err) {
      logger.warn(`[youtube/stream] innertube fast-resolve failed for ${videoId}: ${err}`)
    }
  }

  try {
    const { stdout } = await withYtDlpSlot(() => execFileAsync(ytDlpBin(), [
      '-f', formatFor(kind, quality),
      '-g', '--no-warnings', '--no-playlist',
      // Speedups: IPv6 paths to googlevideo often stall here; and probing every player
      // client is wasteful — ANDROID_VR returns pre-signed progressive URLs (no n-sig /
      // player-JS step) and the web clients cover anything it misses.
      '--force-ipv4',
      '--extractor-args', 'youtube:player_client=android_vr,web_safari,web',
      `https://www.youtube.com/watch?v=${videoId}`,
    ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }))

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
