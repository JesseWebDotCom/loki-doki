// VideoProvider: the per-source plugin interface (Grayjay's source shape in TypeScript).
// Providers are in-process modules registered in registry.ts; capability flags let the
// UI degrade honestly (e.g. TikTok ships without a trending browse, Vimeo browse only
// unlocks once an API token is configured).

import type { Creator, Pager, PlaybackInfo, VideoItem, VideoSource } from '@/lib/videos/types'

export interface ProviderCapabilities {
  /** Has a home/trending browse surface (may be config-dependent; see status()). */
  browse: boolean
  search: boolean
  /** Creator pages + follows. */
  creators: boolean
  comments: boolean
  live: boolean
  downloadKinds: Array<'audio' | 'video'>
  /** What admin setup unlocks or improves the source. */
  authConfig: 'none' | 'apiKey' | 'cookies'
}

export interface UrlMatch {
  kind: 'video' | 'creator'
  id: string
}

export interface BrowseOpts {
  userId: string
  /** Provider-defined feed key (e.g. reddit multi, yt trending); default when omitted. */
  feed?: string
  cursor?: string | null
  allowAdult: boolean
}

export interface SearchOpts {
  cursor?: string | null
  allowAdult: boolean
}

export interface DownloadSpec {
  /** How the video-media job fetches the bytes: yt-dlp on a page URL, or a direct
   *  ffmpeg remux of an HLS manifest (reddit's v.redd.it, where yt-dlp needs auth
   *  but the media CDN itself doesn't). */
  method: 'ytdlp' | 'hls'
  /** ytdlp: canonical watch/permalink URL. hls: the manifest URL. */
  url: string
  /** Extra yt-dlp args (format preferences, e.g. TikTok watermark-free h264). */
  ytdlpArgs?: string[]
}

export interface ProviderStatus {
  configured: boolean
  /** Short user-facing nudge when not (fully) configured, e.g. "Add a Vimeo token". */
  note?: string
}

export interface VideoProvider {
  source: VideoSource
  label: string
  capabilities: ProviderCapabilities

  /** Fast URL sniffing for the universal clipper / deep links. No network. */
  matchUrl(url: URL): UrlMatch | null

  /** Config/health for /api/videos/sources (drives rail + settings nudges). */
  status?(): Promise<ProviderStatus>

  browse?(opts: BrowseOpts): Promise<Pager<VideoItem>>
  search?(q: string, opts: SearchOpts): Promise<Pager<VideoItem>>
  getCreator?(id: string, cursor?: string | null): Promise<{ creator: Creator; videos: Pager<VideoItem> }>
  getItem(id: string): Promise<(VideoItem & { description?: string | null }) | null>
  getPlayback(id: string, kind?: 'audio' | 'video'): Promise<PlaybackInfo>
  getComments?(id: string): Promise<Array<{ author: string; text: string; likes?: string | null; publishedText?: string | null }>>

  /** Poll new uploads for a followed creator (drives video_items). */
  fetchCreatorFeed?(externalId: string): Promise<VideoItem[]>

  /** How the download job invokes yt-dlp for this item. */
  downloadSpec(id: string, kind: 'audio' | 'video', maxHeight?: number | null): Promise<DownloadSpec>
}
