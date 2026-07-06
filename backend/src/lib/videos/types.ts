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
  /** Progressive proxy: /api/videos/:source/stream/:id forwards Range requests upstream. */
  | { mode: 'proxy-progressive'; upstreamUrl: string; headers?: Record<string, string> }
  /** HLS through the manifest/segment proxy (v.redd.it). */
  | { mode: 'hls'; manifestUrl: string }
  /** Already downloaded: play the blob-store asset. */
  | { mode: 'file'; assetId: string }
