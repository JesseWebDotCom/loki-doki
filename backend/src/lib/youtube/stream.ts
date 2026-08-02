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
import { ffprobeBin } from '@/lib/ffmpeg'
import { innertubePlayerStreams, type ItStreams, type ItStreamFormat } from '@/lib/youtube/innertube'

const execFileAsync = promisify(execFile)

export type StreamKind = 'video' | 'audio'
// Privacy-proxy quality. Progressive (single-file, muxed) MP4 only goes up to 720p on
// YouTube — higher resolutions are split into separate DASH video+audio streams, which
// the '1080' tier serves by remuxing them server-side (see the route's ffmpeg branch and
// resolveSplitStreamUrls below).
export type StreamQuality = 'auto' | '2160' | '1440' | '1080' | '720' | '360'
const QUALITIES: StreamQuality[] = ['auto', '2160', '1440', '1080', '720', '360']
/** The tiers served by the ffmpeg remux branch (split video+audio tracks). */
export const REMUX_QUALITIES = new Set<StreamQuality>(['2160', '1440', '1080'])
export const parseQuality = (q: string | undefined): StreamQuality =>
  (QUALITIES as string[]).includes(q ?? '') ? (q as StreamQuality) : 'auto'

// YouTube video ids are exactly 11 chars of [A-Za-z0-9_-]. Validate before shelling out
// so a crafted id can't waste a subprocess or steer yt-dlp at a non-YouTube extractor.
export const isValidVideoId = (id: string): boolean => /^[A-Za-z0-9_-]{11}$/.test(id)

// Only ever proxy bytes from YouTube's own CDN — never an arbitrary host the resolver
// might return — so the proxy can't be turned into an SSRF gadget.
export function isAllowedUpstream(url: string): boolean {
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

export interface SplitStreamUrls {
  video: string
  audio: string
  /** Format metadata from the InnerTube fast path, for the HLS master playlist's
   *  FRAME-RATE / BANDWIDTH attributes. Null/absent when resolved via yt-dlp. */
  videoFps?: number | null
  videoBitrate?: number | null
  audioBitrate?: number | null
  /** Secondary variant for the HLS ladder: best avc1 at or under 720p. Only resolved on
   *  the avc1-pinned path; null when no distinct lower track exists. */
  lowVideo?: string | null
  lowVideoFps?: number | null
  lowVideoBitrate?: number | null
}
/** Pin the video track to one codec family. Only the HLS tier uses this: AVPlayer decodes
 *  h264 but not VP9/AV1, so "best track" is the wrong answer there. */
export type SplitVideoCodec = 'avc1'
const splitCache = new Map<string, { urls: SplitStreamUrls; expires: number }>()
const splitInflight = new Map<string, Promise<SplitStreamUrls | null>>()
const splitKey = (videoId: string, maxHeight: number, codec?: SplitVideoCodec) => `${videoId}:split:${maxHeight}:${codec ?? 'any'}`

// Best video-only track at or under the height cap. h264 (avc1) exists only up to
// 1080p; above that YouTube publishes VP9/AV1, which also copy cleanly into fragmented
// MP4 for every modern browser we target (Chrome/Edge/Firefox). At equal height prefer
// avc1 > vp9 > av01 for the widest decode support.
function codecRank(mime: string): number {
  if (/avc1/i.test(mime)) return 0
  if (/vp0?9/i.test(mime)) return 1
  if (/av01/i.test(mime)) return 2
  return 3
}
// Among same-height, same-codec-family candidates: highest bitrate, but prefer the
// high-framerate (>= 50fps) encode when one exists: 1080p60 over 1080p30. A high-fps
// pick still wins at a slightly lower bitrate (within 20 percent of the low-fps best),
// since motion smoothness beats a marginal bits-per-pixel edge on a TV.
function pickByFpsAndBitrate(peers: ItStreamFormat[]): ItStreamFormat | null {
  if (!peers.length) return null
  const best = (arr: ItStreamFormat[]) => arr.reduce((a, b) => ((b.bitrate ?? 0) > (a.bitrate ?? 0) ? b : a))
  const hi = peers.filter(f => (f.fps ?? 0) >= 50)
  const lo = peers.filter(f => (f.fps ?? 0) < 50)
  if (!hi.length) return best(lo)
  if (!lo.length) return best(hi)
  const bh = best(hi)
  const bl = best(lo)
  return (bh.bitrate ?? 0) >= (bl.bitrate ?? 0) * 0.8 ? bh : bl
}

function pickSplitVideo(streams: ItStreams, maxHeight: number, codec?: SplitVideoCodec): ItStreamFormat | null {
  // Require a track that actually BEATS the 720p progressive ceiling: InnerTube often
  // exposes only low unciphered adaptive tracks (the high tiers are ciphered), and
  // remuxing a 360p track would silently undercut the plain progressive stream. Passing
  // on those lets the yt-dlp fallback resolve the real high tiers instead.
  const pool = streams.video
    .filter(f => f.url && codecRank(f.mime) < 3 && (f.height ?? 0) > 720 && (f.height ?? 0) <= maxHeight
      && (codec !== 'avc1' || /avc1/i.test(f.mime)))
    .sort((a, b) => ((b.height ?? 0) - (a.height ?? 0))
      || (codecRank(a.mime) - codecRank(b.mime))
      || ((b.bitrate ?? 0) - (a.bitrate ?? 0)))
  const top = pool[0]
  if (!top) return null
  // Best bytes at the winning height + codec family: highest bitrate, fps-preferred.
  const peers = pool.filter(f => (f.height ?? 0) === (top.height ?? 0) && codecRank(f.mime) === codecRank(top.mime))
  return pickByFpsAndBitrate(peers)
}

/** Best avc1 video-only track at or under `maxHeight` (no >720p floor: this picks the
 *  SECONDARY, lower rung of the HLS ladder, so undercutting progressive is the point).
 *  Same highest-bitrate / fps-preferred rule as the primary pick. */
function pickAvc1VideoAtMost(streams: ItStreams, maxHeight: number): ItStreamFormat | null {
  const pool = streams.video
    .filter(f => f.url && /avc1/i.test(f.mime) && (f.height ?? 0) > 0 && (f.height ?? 0) <= maxHeight)
  if (!pool.length) return null
  const top = pool.reduce((a, b) => ((b.height ?? 0) > (a.height ?? 0) ? b : a))
  return pickByFpsAndBitrate(pool.filter(f => (f.height ?? 0) === (top.height ?? 0)))
}

// Strict AAC pick for the HLS byte-range path: AVPlayer muxes these segments natively,
// so opus/webm audio is unusable there (parseTrackHead would reject it anyway; better
// to pass on it here and let the caller fall back than to index-and-fail).
function pickSplitAudio(streams: ItStreams): ItStreamFormat | null {
  const pool = streams.audio.filter(f => f.url && /audio\/mp4|mp4a/i.test(f.mime))
  if (!pool.length) return null
  return pool.reduce((a, b) => ((b.bitrate ?? 0) > (a.bitrate ?? 0) ? b : a))
}

/** Resolve (and cache) a pre-signed video-only + audio-only URL pair for the ffmpeg
 *  remux tier. Fast InnerTube path first, yt-dlp `-g` (two output lines) as fallback.
 *  Returns null when no suitable avc1 track exists — the route then falls back to the
 *  best progressive stream instead of failing. */
export async function resolveSplitStreamUrls(videoId: string, maxHeight = 1080, codec?: SplitVideoCodec): Promise<SplitStreamUrls | null> {
  if (!isValidVideoId(videoId)) return null
  const now = Date.now()
  const key = splitKey(videoId, maxHeight, codec)
  const hit = splitCache.get(key)
  if (hit && hit.expires > now) return hit.urls
  if (hit) splitCache.delete(key)
  const pending = splitInflight.get(key)
  if (pending) return pending
  const p = doResolveSplit(videoId, maxHeight, codec, key, now)
  splitInflight.set(key, p)
  void p.finally(() => { if (splitInflight.get(key) === p) splitInflight.delete(key) })
  return p
}

function cacheSplit(key: string, urls: SplitStreamUrls, now: number): void {
  if (splitCache.size > 200) { for (const [k, v] of splitCache) if (v.expires <= now) splitCache.delete(k) }
  splitCache.set(key, { urls, expires: now + TTL_MS })
}

async function doResolveSplit(videoId: string, maxHeight: number, codec: SplitVideoCodec | undefined, key: string, now: number): Promise<SplitStreamUrls | null> {
  // Fast path: one InnerTube call yields pre-signed video-only + audio-only URLs.
  try {
    const streams = await innertubePlayerStreams(videoId)
    if (streams) {
      const videoFmt = pickSplitVideo(streams, maxHeight, codec)
      // The avc1-pinned (HLS) path needs strict AAC; the ffmpeg remux path keeps the
      // broader pickAudio (m4a-preferred with a fallback).
      const audioFmt = codec === 'avc1' ? pickSplitAudio(streams) : null
      // Lower rung of the HLS variant ladder (avc1 pin only).
      const lowFmt = codec === 'avc1' ? pickAvc1VideoAtMost(streams, 720) : null
      const video = videoFmt?.url ?? null
      const audio = codec === 'avc1' ? (audioFmt?.url ?? null) : pickAudio(streams)
      if (video && audio && isAllowedUpstream(video) && isAllowedUpstream(audio)) {
        const urls: SplitStreamUrls = {
          video, audio,
          videoFps: videoFmt?.fps ?? null,
          videoBitrate: videoFmt?.bitrate ?? null,
          audioBitrate: audioFmt?.bitrate ?? null,
          lowVideo: lowFmt && isAllowedUpstream(lowFmt.url) ? lowFmt.url : null,
          lowVideoFps: lowFmt?.fps ?? null,
          lowVideoBitrate: lowFmt?.bitrate ?? null,
        }
        cacheSplit(key, urls, now)
        return urls
      }
    }
  } catch (err) {
    logger.warn(`[youtube/stream] innertube split-resolve failed for ${videoId}: ${err}`)
  }
  // yt-dlp fallback: a video+audio format spec makes `-g` print two URLs (video, audio).
  // Codec preference mirrors pickSplitVideo: avc1 first (tops out at 1080p), then
  // vp9/av01 for the tiers above it. The >720 floor mirrors pickSplitVideo too - if no
  // track beats the progressive ceiling, failing here lets the route serve progressive.
  // An avc1 pin (HLS tier) never widens to another codec: a VP9/AV1 track there is worse
  // than no answer at all, since the caller can still fall back to progressive.
  const v = (vcodec: string) => `bestvideo[vcodec^=${vcodec}][height<=${maxHeight}][height>720][protocol^=https]`
  const videoSpec = codec === 'avc1'
    ? v('avc1')
    : maxHeight > 1080
      ? `${v('vp09')}/${v('vp9')}/${v('av01')}/${v('avc1')}`
      : `${v('avc1')}/bestvideo[ext=mp4][height<=${maxHeight}][height>720][protocol^=https]`
  // avc1 pin only: a comma-separated third selector makes -g print one more URL, the
  // best avc1 at or under 720p, the lower rung of the HLS variant ladder. The
  // `/videoSpec` alternative keeps the whole -f from failing on the (rare) video with
  // no low avc1 track: it then re-prints the primary itag, which the caller dedupes.
  const lowSelector = codec === 'avc1'
    ? `,bestvideo[vcodec^=avc1][height<=720][protocol^=https]/${videoSpec}`
    : ''
  // Same transient-failure retry as doResolveStreamUrl: a cold burst of resolves can get
  // rate-limited or time out, yet the identical video resolves fine a moment later.
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1200 * attempt))
    try {
      const { stdout } = await withYtDlpSlot(() => execFileAsync(ytDlpBin(), [
        '-f', `(${videoSpec})+bestaudio[ext=m4a][protocol^=https]/(${videoSpec})+bestaudio[protocol^=https]${lowSelector}`,
        '-g', '--no-warnings', '--no-playlist', '--force-ipv4',
        '--extractor-args', `youtube:player_client=${YT_PLAYER_CLIENTS}`,
        `https://www.youtube.com/watch?v=${videoId}`,
      ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }))
      // -g prints URLs in selector order: video, audio, then (avc1 pin) the low variant.
      const [video, audio, low] = stdout.split('\n').map(l => l.trim()).filter(Boolean)
      if (!video || !audio) { lastErr = 'empty output'; continue }   // transient — retry
      if (!isAllowedUpstream(video) || !isAllowedUpstream(audio)) {  // permanent — don't retry
        logger.warn(`[youtube/stream] refusing non-YouTube upstream host for ${videoId} (split)`)
        return null
      }
      const urls: SplitStreamUrls = { video, audio }
      if (codec === 'avc1') urls.lowVideo = low && isAllowedUpstream(low) ? low : null
      cacheSplit(key, urls, now)
      return urls
    } catch (err) {
      // "Requested format is not available" is a permanent answer (no track above the
      // progressive ceiling), not a transient failure — retrying only delays the caller's
      // progressive fallback.
      if (err instanceof Error && /requested format is not available/i.test(`${(err as { stderr?: string }).stderr ?? ''} ${err.message}`)) {
        logger.warn(`[youtube/stream] yt-dlp split-resolve: no suitable track for ${videoId}`)
        return null
      }
      lastErr = err
    }
  }
  logger.warn(`[youtube/stream] yt-dlp split-resolve failed for ${videoId} after retries: ${lastErr}`)
  return null
}

/** Drop a cached split pair (e.g. after ffmpeg dies on a rotated/expired URL). */
export function invalidateSplitStreamUrls(videoId: string, maxHeight = 1080, codec?: SplitVideoCodec): void {
  splitCache.delete(splitKey(videoId, maxHeight, codec))
}

/** The video keyframe at-or-before `t` seconds. Remux seeks MUST start both tracks on
 *  this exact timestamp: a bare input-side -ss snaps the video to the previous keyframe
 *  while the audio seeks (near-)exactly, leaving them out of sync by up to a whole GOP.
 *  ffprobe range-reads just the index + one GOP, so this is a sub-second probe. */
export async function probeKeyframeBefore(url: string, t: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(ffprobeBin(), [
      '-v', 'error',
      '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '-select_streams', 'v:0',
      '-skip_frame', 'nokey',
      '-read_intervals', `${Math.max(0, t).toFixed(3)}%+#1`,
      '-show_entries', 'frame=pts_time',
      '-of', 'csv=p=0',
      url,
    ], { timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true })
    const v = Number.parseFloat(stdout.trim().split('\n').find(Boolean) ?? '')
    return Number.isFinite(v) && v >= 0 ? v : null
  } catch (err) {
    logger.warn(`[youtube/stream] keyframe probe failed: ${err}`)
    return null
  }
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
