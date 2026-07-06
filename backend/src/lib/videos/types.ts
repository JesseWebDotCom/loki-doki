// Normalized cross-source video types for the Videos hub. Every provider maps its
// native shapes (InnerTube, Reddit JSON, yt-dlp dumps, Vimeo API) into these, so the
// hub UI and library layer never see source-specific formats.

export type VideoSource = 'youtube' | 'reddit' | 'tiktok' | 'vimeo'
/** Sources persisted in the generic video_* tables (YouTube keeps its native yt_* tables). */
export type GenericVideoSource = Exclude<VideoSource, 'youtube'>

export interface SourceRef {
  source: VideoSource
  id: string
}

export interface CreatorRef {
  id: string
  name: string
  handle?: string | null
  avatarUrl?: string | null
}

export interface VideoItem {
  source: VideoSource
  /** Provider-native id (yt 11-char, reddit t3_ base36, tiktok 19-digit, vimeo numeric). */
  id: string
  /** Canonical external URL for the item. */
  url: string
  title: string
  creator?: CreatorRef | null
  thumbnailUrl?: string | null
  durationSec?: number | null
  /** Unix ms; providers with only display text leave this null and set publishedText. */
  publishedAt?: number | null
  publishedText?: string | null
  viewsText?: string | null
  isAdult?: boolean
  live?: boolean
  /** Short-form hint (shorts / TikTok / reels) so mixed grids can pick the 9:16 card. */
  vertical?: boolean
  /** Provider extras (v.redd.it urls, permalink, uploader handle, etc.). */
  meta?: Record<string, unknown>
}

export interface Creator extends CreatorRef {
  source: VideoSource
  kind: 'channel' | 'user' | 'subreddit' | 'category'
  bannerUrl?: string | null
  description?: string | null
  subscriberText?: string | null
  isAdult?: boolean
}

/** Cursor-string pager: cursors are provider-opaque (InnerTube continuation, reddit
 *  `after`, index window) and serialize cleanly over HTTP. */
export interface Pager<T> {
  items: T[]
  cursor: string | null
}

export type PlaybackInfo =
  /** YouTube: the frontend routes to the native WatchPage + /api/youtube/stream. */
  | { mode: 'native-app' }
  /** Official first-party embed player, rendered as an <iframe>. Instant (~0.1s, a plain
   *  page load), the browser handles the CDN's auth/fingerprinting, and NO yt-dlp is
   *  involved — yt-dlp is reserved for downloads. Used where the source ships a clean
   *  embed (Vimeo) or where its CDN can't be server-proxied at all (TikTok). */
  | { mode: 'embed'; embedUrl: string }
  /** Progressive proxy: /api/videos/:source/stream/:id forwards Range requests upstream.
   *  Only viable when the CDN accepts a plain server-side fetch (Reddit fallbacks). Vimeo
   *  and TikTok now play through 'embed' instead — Vimeo for simplicity, TikTok because its
   *  CDN 403s a bare fetch even with yt-dlp's exact headers (likely TLS/HTTP2 fingerprinting). */
  | { mode: 'proxy-progressive'; upstreamUrl: string; headers?: Record<string, string> }
  /** Live-piped through a yt-dlp subprocess: no Range/seek support, but works against CDNs
   *  that reject direct fetches. `formatSelector` is yt-dlp's -f argument. Currently unused
   *  by any provider (kept as a capability) — playback avoids yt-dlp; it's for downloads. */
  | { mode: 'ytdlp-pipe'; pageUrl: string; formatSelector?: string }
  /** HLS through the manifest/segment proxy (v.redd.it). */
  | { mode: 'hls'; manifestUrl: string }
  /** Already downloaded: play the blob-store asset. */
  | { mode: 'file'; assetId: string }
