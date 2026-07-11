// Direct-stream resolver for the privacy proxy. yt-dlp does the hard part — solving
// YouTube's signature cipher and `n`-parameter throttling — and hands us a direct
// googlevideo.com URL. The route then streams those bytes through our own server, so
// the browser talks only to us, never to Google (no embed, no cookies, no
// tracking). googlevideo URLs are IP-locked to whoever fetched them and expire after a
// few hours, so resolution and the byte-proxy must both happen here on the backend.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { logger } from '@/lib/logger'
import { ytDlpBin, withYtDlpSlot, YT_PLAYER_CLIENTS } from '@/lib/ytdlp'
import { innertubePlayerStreams, type ItStreams } from '@/lib/youtube/innertube'

const execFileAsync = promisify(execFile)

export type StreamKind = 'video' | 'audio'
// Privacy-proxy quality. Progressive (single-file, muxed) MP4 only goes up to 720p on
// YouTube — higher resolutions are split into separate DASH video+audio streams, which
// the '1080' tier serves by remuxing them server-side (see the route's ffmpeg branch and
// resolveSplitStreamUrls below).
export type StreamQuality = 'auto' | '1080' | '720' | '360'
const QUALITIES: StreamQuality[] = ['auto', '1080', '720', '360']
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
// Videos InnerTube won't cooperate with (age/region/login-gated) fail resolveStreamPreviewUrl's
// fast path every time — without this, every hover pays the full ~11s worst case (cold
// visitorData + player call) again. Short TTL since gating can lift/change.
const MISS_TTL_MS = 10 * 60 * 1000
const previewMisses = new Map<string, number>()
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

// Pick the best adaptive audio-only URL the ANDROID_VR client offered: highest bitrate,
// preferring m4a/mp4 (which a plain <audio> plays everywhere). These are pre-signed, so we
// avoid a cold yt-dlp spawn entirely — this is what lets AI-Radio's instrumental bed and
// songs resolve in well under a second instead of waiting seconds for the first subprocess.
function pickAudio(streams: ItStreams): string | null {
  const audio = streams.audio.filter(f => f.url)
  if (!audio.length) return null
  const m4a = audio.filter(f => /audio\/mp4|mp4a/i.test(f.mime))
  const pool = m4a.length ? m4a : audio
  const best = pool.reduce((a, b) => ((b.bitrate ?? 0) > (a.bitrate ?? 0) ? b : a))
  return best?.url ?? null
}

/**
 * Resolve (and cache) a directly-playable URL for a video. Both video (progressive) and
 * audio (best adaptive audio) try the fast InnerTube/ANDROID_VR path first (no subprocess)
 * and fall back to yt-dlp. `forceYtDlp` skips the fast path (used when an InnerTube URL has
 * just 403'd, since re-fetching it the same way would likely 403 again).
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

// Fast path: one JSON call to the ANDROID_VR client (pre-signed, cipher-free URLs) beats
// spawning yt-dlp — for BOTH video (progressive) and audio (best adaptive audio). No
// subprocess involved, so this is safe to call far more liberally than yt-dlp (which is
// capped at 3 concurrent slots server-wide) — shared by the main resolver below (which
// falls back to yt-dlp on failure) and resolveStreamPreviewUrl (which does not).
async function fastPathResolve(videoId: string, kind: StreamKind, quality: StreamQuality): Promise<string | null> {
  try {
    const streams = await innertubePlayerStreams(videoId)
    let url = streams ? (kind === 'audio' ? pickAudio(streams) : pickProgressive(streams, quality)) : null
    // Audio fast-path fallback: if no adaptive audio URL came back (ANDROID_VR often only offers
    // ciphered audio formats, which we skip), use the pre-signed PROGRESSIVE (muxed) stream — an
    // <audio> element plays its audio track fine. This resolves instantly here instead of spawning
    // a cold yt-dlp (~10s), which is exactly the first-song / skip stall. Bandwidth cost (it
    // carries video too) only applies when audio-only wasn't available.
    if (!url && kind === 'audio' && streams) url = pickProgressive(streams, '360')   // smallest muxed = lightest audio
    return url && isAllowedUpstream(url) ? url : null
  } catch (err) {
    logger.warn(`[youtube/stream] innertube fast-resolve failed for ${videoId}: ${err}`)
    return null
  }
}

function cacheUrl(key: string, url: string, now: number): void {
  if (cache.size > 500) sweepExpired()
  cache.set(key, { url, expires: now + TTL_MS })
}

async function doResolveStreamUrl(videoId: string, kind: StreamKind, quality: StreamQuality, forceYtDlp: boolean, key: string, now: number): Promise<string | null> {
  if (!forceYtDlp) {
    const url = await fastPathResolve(videoId, kind, quality)
    if (url) { cacheUrl(key, url, now); return url }
  }

  // yt-dlp failures are often transient — a cold burst of resolves from one IP can get rate-
  // limited or time out under load, yet the very same video resolves fine a moment later. So
  // retry a couple of times with backoff before giving up (this fixes the AI-Radio startup
  // where the first song + bed resolve at once and one 502s).
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1200 * attempt))
    try {
      const { stdout } = await withYtDlpSlot(() => execFileAsync(ytDlpBin(), [
        '-f', formatFor(kind, quality),
        '-g', '--no-warnings', '--no-playlist',
        // Speedups: IPv6 paths to googlevideo often stall here; and probing every player
        // client is wasteful — ANDROID_VR returns pre-signed progressive URLs (no n-sig /
        // player-JS step) and the web clients cover anything it misses.
        '--force-ipv4',
        '--extractor-args', `youtube:player_client=${YT_PLAYER_CLIENTS}`,
        `https://www.youtube.com/watch?v=${videoId}`,
      ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }))

      // -g prints one URL per selected stream; the first line is our progressive/audio URL.
      const url = stdout.split('\n').map(l => l.trim()).find(Boolean) ?? null
      if (!url) { lastErr = 'empty output'; continue }       // transient — retry
      if (!isAllowedUpstream(url)) {                          // permanent — don't retry
        logger.warn(`[youtube/stream] refusing non-YouTube upstream host for ${videoId}`)
        return null
      }
      cacheUrl(key, url, now)
      return url
    } catch (err) {
      lastErr = err
    }
  }
  logger.warn(`[youtube/stream] resolve failed for ${videoId} (${kind}) after retries: ${lastErr}`)
  return null
}

function sweepExpired(): void {
  const now = Date.now()
  for (const [k, v] of cache) if (v.expires <= now) cache.delete(k)
}

/** Drop a cached URL (e.g. after an upstream 403 — the signature likely rotated). */
export function invalidateStreamUrl(videoId: string, kind: StreamKind, quality: StreamQuality = 'auto'): void {
  cache.delete(cacheKey(videoId, kind, quality))
}

// ── Split (video-only + audio-only) resolution for the 1080p remux tier ─────────

export interface SplitStreamUrls { video: string; audio: string }
const splitCache = new Map<string, { urls: SplitStreamUrls; expires: number }>()
const splitInflight = new Map<string, Promise<SplitStreamUrls | null>>()
const splitKey = (videoId: string, maxHeight: number) => `${videoId}:split:${maxHeight}`

// Best h264 (avc1) video-only track at or under the height cap: stream-copies cleanly
// into fragmented MP4 that every browser decodes. VP9/AV1 tracks are skipped — copying
// them into MP4 is a compatibility minefield and re-encoding is off the table.
function pickSplitVideo(streams: ItStreams, maxHeight: number): string | null {
  const pool = streams.video
    .filter(f => f.url && /avc1/i.test(f.mime) && (f.height ?? 0) > 0 && (f.height ?? 0) <= maxHeight)
    .sort((a, b) => ((b.height ?? 0) - (a.height ?? 0)) || ((b.bitrate ?? 0) - (a.bitrate ?? 0)))
  return pool[0]?.url ?? null
}

/** Resolve (and cache) a pre-signed video-only + audio-only URL pair for the ffmpeg
 *  remux tier. Fast InnerTube path first, yt-dlp `-g` (two output lines) as fallback.
 *  Returns null when no suitable avc1 track exists — the route then falls back to the
 *  best progressive stream instead of failing. */
export async function resolveSplitStreamUrls(videoId: string, maxHeight = 1080): Promise<SplitStreamUrls | null> {
  if (!isValidVideoId(videoId)) return null
  const now = Date.now()
  const key = splitKey(videoId, maxHeight)
  const hit = splitCache.get(key)
  if (hit && hit.expires > now) return hit.urls
  if (hit) splitCache.delete(key)
  const pending = splitInflight.get(key)
  if (pending) return pending
  const p = doResolveSplit(videoId, maxHeight, key, now)
  splitInflight.set(key, p)
  void p.finally(() => { if (splitInflight.get(key) === p) splitInflight.delete(key) })
  return p
}

function cacheSplit(key: string, urls: SplitStreamUrls, now: number): void {
  if (splitCache.size > 200) { for (const [k, v] of splitCache) if (v.expires <= now) splitCache.delete(k) }
  splitCache.set(key, { urls, expires: now + TTL_MS })
}

async function doResolveSplit(videoId: string, maxHeight: number, key: string, now: number): Promise<SplitStreamUrls | null> {
  // Fast path: one InnerTube call yields pre-signed video-only + audio-only URLs.
  try {
    const streams = await innertubePlayerStreams(videoId)
    if (streams) {
      const video = pickSplitVideo(streams, maxHeight)
      const audio = pickAudio(streams)
      if (video && audio && isAllowedUpstream(video) && isAllowedUpstream(audio)) {
        const urls = { video, audio }
        cacheSplit(key, urls, now)
        return urls
      }
    }
  } catch (err) {
    logger.warn(`[youtube/stream] innertube split-resolve failed for ${videoId}: ${err}`)
  }
  // yt-dlp fallback: a video+audio format spec makes `-g` print two URLs (video, audio).
  try {
    const { stdout } = await withYtDlpSlot(() => execFileAsync(ytDlpBin(), [
      '-f', `bestvideo[vcodec^=avc1][height<=${maxHeight}][protocol^=https]+bestaudio[ext=m4a][protocol^=https]/bestvideo[ext=mp4][height<=${maxHeight}][protocol^=https]+bestaudio[protocol^=https]`,
      '-g', '--no-warnings', '--no-playlist', '--force-ipv4',
      '--extractor-args', `youtube:player_client=${YT_PLAYER_CLIENTS}`,
      `https://www.youtube.com/watch?v=${videoId}`,
    ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }))
    const [video, audio] = stdout.split('\n').map(l => l.trim()).filter(Boolean)
    if (video && audio && isAllowedUpstream(video) && isAllowedUpstream(audio)) {
      const urls = { video, audio }
      cacheSplit(key, urls, now)
      return urls
    }
  } catch (err) {
    logger.warn(`[youtube/stream] yt-dlp split-resolve failed for ${videoId}: ${err}`)
  }
  return null
}

/** Drop a cached split pair (e.g. after ffmpeg dies on a rotated/expired URL). */
export function invalidateSplitStreamUrls(videoId: string, maxHeight = 1080): void {
  splitCache.delete(splitKey(videoId, maxHeight))
}

/** Cache-or-fast-path resolve for card hover-preview: a cache hit is free, otherwise this
 *  makes ONE InnerTube HTTP call (no subprocess) and caches the result on success. It
 *  deliberately never falls back to yt-dlp — a hover sweeping many cards must never
 *  contend for the tiny global yt-dlp concurrency pool the real player also depends on.
 *  Returns null (meaning "skip the preview") when InnerTube doesn't cooperate. */
export async function resolveStreamPreviewUrl(videoId: string, kind: StreamKind, quality: StreamQuality = 'auto'): Promise<string | null> {
  if (!isValidVideoId(videoId)) return null
  const now = Date.now()
  const key = cacheKey(videoId, kind, quality)
  const hit = cache.get(key)
  if (hit && hit.expires > now) return hit.url
  if (hit) cache.delete(key)
  const missUntil = previewMisses.get(key)
  if (missUntil !== undefined) {
    if (missUntil > now) return null
    previewMisses.delete(key)
  }
  const url = await fastPathResolve(videoId, kind, quality)
  if (url) cacheUrl(key, url, now)
  else previewMisses.set(key, now + MISS_TTL_MS)
  return url
}
