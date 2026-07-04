// Typed wrappers around the /api/youtube/* endpoints (+ the podcast reverse-link),
// consolidating the fetch helpers that used to live inline in YoutubePage.

import type { UseQueryOptions } from '@tanstack/react-query'

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string
  url: string
  videoId: string
  snippet: string
  embedUrl: string
  author?: string
  channelId?: string
  channelThumb?: string | null
  durationSec?: number | null
  publishedText?: string | null
  views?: string | null
}

export interface ChannelSearchResult {
  channelId: string
  title: string
  handle: string | null
  thumbnailUrl: string | null
  subscribers: string | null
  url: string
}

export interface Subscription {
  id: string
  kind: 'channel' | 'playlist'
  externalId: string
  title: string
  handle: string | null
  thumbnailUrl: string | null
  description: string | null
  lastFetchedAt: string | null
  // Automation (off by default): auto-save new uploads offline, in this format, keeping
  // only the latest N (null → global default).
  autoSave: boolean
  autoSaveKind: 'audio' | 'video'
  autoSaveKeep: number | null
  addedAt: string
}

export interface FeedVideo {
  id: string
  videoId: string
  title: string
  author: string
  channelId: string | null
  thumbnailUrl: string | null    // the video's own thumbnail
  channelThumb: string | null    // the channel's avatar (from the subscription)
  publishedAt: number | null
  durationSec: number | null
  summary: string | null
  watchState: { positionSec: number; completed: boolean } | null
}

export interface SavedRow {
  id: string
  videoId: string
  title: string
  kind: 'audio' | 'video'
  status: 'pending' | 'downloading' | 'ready' | 'failed'
  sizeBytes: number | null
  maxHeight: number | null
  createdAt: string
  author: string | null
  channelId: string | null
  channelThumb: string | null
  publishedAt: number | null
  durationSec: number | null
  positionSec: number | null
  completed: boolean | null
}

export interface YtFormat {
  formatId: string
  ext: string
  resolution: string
  note: string
  filesize: number | null
  vcodec: string
  acodec: string
}

export interface VideoMeta {
  title?: string | null
  author: string | null
  channelId: string | null
  channelThumb?: string | null
  description: string | null
  summary?: string | null
  positionSec: number
  durationSec: number | null
  subscribed?: boolean
  subscriptionId?: string | null
}

export interface SaveQuality { tiers: number[]; cap: number; pref: number | null }

/** A podcast episode that was generated from a given video (reverse link). */
export interface VideoPodcast {
  episodeId: string
  title: string
  durationSec: number | null
  showId: string
  showName: string
  coverUrl: string
}

// ── Media URLs ───────────────────────────────────────────────────────────────

export const fileUrl = (videoId: string, kind: 'audio' | 'video') => `/api/youtube/file/${videoId}/${kind}`
export const exportFileUrl = (jobId: string) => `/api/youtube/export/${jobId}/file`
export type StreamQuality = 'auto' | '720' | '360'
/** Privacy proxy: stream a video (or its audio) through our server, never Google. */
export const proxyStreamUrl = (videoId: string, kind: 'audio' | 'video' = 'video', quality: StreamQuality = 'auto') =>
  `/api/youtube/stream/${videoId}?kind=${kind}${quality !== 'auto' ? `&q=${quality}` : ''}`

/** Warm the proxy-stream cache so a later hand-off to the mini-player plays instantly.
 *  Best-effort and fire-and-forget — failures are harmless (the stream just resolves cold). */
export const prewarmStream = (videoId: string, kind: 'audio' | 'video' = 'video') =>
  void fetch(`/api/youtube/stream/${videoId}/prewarm${kind === 'audio' ? '?kind=audio' : ''}`, { credentials: 'include' }).catch(() => {})

/** Card hover-preview support: cache hit is free server-side, otherwise the server makes
 *  one InnerTube HTTP call (no subprocess) to see if a preview stream is available. Never
 *  triggers a costly yt-dlp resolve — `false` just means "skip the preview". */
export async function checkStreamPreview(videoId: string, kind: 'audio' | 'video' = 'video', signal?: AbortSignal): Promise<boolean> {
  try {
    const r = await fetch(`/api/youtube/stream/${videoId}/preview?kind=${kind}`, { ...opts, signal })
    if (!r.ok) return false
    return !!((await r.json()) as { available?: boolean }).available
  } catch { return false }
}

/** Scrub-preview sprite sheet levels (trickplay), parsed server-side from InnerTube's
 *  storyboard spec. Each level's `urlTemplate` has a literal "{sheet}" placeholder for
 *  the multi-sheet index — see `frameForTime` in `lib/youtube/storyboard.ts`. */
export interface StoryboardLevel {
  width: number; height: number; cols: number; rows: number
  totalCount: number; intervalMs: number; sheetCount: number; urlTemplate: string
}
export async function getStoryboards(videoId: string): Promise<StoryboardLevel[]> {
  try {
    const r = await fetch(`/api/youtube/storyboards/${videoId}`, opts)
    if (!r.ok) return []
    return ((await r.json()) as { levels?: StoryboardLevel[] }).levels ?? []
  } catch { return [] }
}

/** Poll target for the /stream 202 "preparing" fallback: the server couldn't resolve a live
 *  stream and kicked off an offline download instead — this reports its yt_downloads status
 *  so the player knows when to switch to fileUrl(videoId, kind). */
export async function getDownloadStatus(videoId: string, kind: 'audio' | 'video'): Promise<string> {
  const r = await fetch(`/api/youtube/download-status/${videoId}/${kind}`, opts)
  const { status } = await r.json() as { status?: string }
  return status ?? 'none'
}

// ── InnerTube discovery: trending / channel / related ────────────────────────────

/** A video as returned by the InnerTube endpoints (search/trending/channel/related). */
export interface ItVideo {
  videoId: string
  title: string
  author: string | null
  channelId: string | null
  channelThumb: string | null
  thumbnailUrl: string | null
  durationSec: number | null
  publishedText: string | null
  views: string | null
}

export interface ChannelMeta {
  channelId: string
  title: string
  handle: string | null
  description: string | null
  thumbnailUrl: string | null
  bannerUrl: string | null
  subscribers: string | null
  videoCount: string | null
  availableTabs: string[]
}

export interface ChannelPage {
  meta: ChannelMeta | null
  videos: ItVideo[]
  continuation: string | null
}

/** Video-bearing channel tabs (Videos / Shorts / Live) — all return the ChannelPage shape. */
export type ChannelVideoTab = 'videos' | 'shorts' | 'live'

export interface ChannelPlaylistItem {
  playlistId: string
  title: string
  videoCount: number | null
  thumbnailUrl: string | null
  author: string | null
  channelId: string | null
}

export interface ChannelPlaylistsPage {
  meta: ChannelMeta | null
  playlists: ChannelPlaylistItem[]
  continuation: string | null
}

export interface ChannelLink { title: string; url: string }

export interface ChannelAbout {
  description: string | null
  subscribers: string | null
  videoCount: string | null
  viewCount: string | null
  joined: string | null
  country: string | null
  links: ChannelLink[]
}

export async function getTrending(limit = 30): Promise<ItVideo[]> {
  const r = await fetch(`/api/youtube/trending?limit=${limit}`, opts)
  return (await r.json() as { videos: ItVideo[] }).videos ?? []
}

export async function getPopular(limit = 30): Promise<ItVideo[]> {
  const r = await fetch(`/api/youtube/popular?limit=${limit}`, opts)
  return (await r.json() as { videos: ItVideo[] }).videos ?? []
}

// Shared query options for the YouTube home discovery shelves + sidebar subscriptions.
// Consumed by YoutubeHomePage/YoutubeRail and the prefetch warmer so keys never drift.
// `enabled: online` stays at the call site (it's a per-view concern); prefetchQuery
// ignores `enabled`, so warming these is always safe.
export function ytPopularQueryOptions(): UseQueryOptions<ItVideo[]> {
  return { queryKey: ['yt-popular'], queryFn: () => getPopular(24), staleTime: 30 * 60_000 }
}
export function ytTrendingQueryOptions(): UseQueryOptions<ItVideo[]> {
  return { queryKey: ['yt-trending'], queryFn: () => getTrending(24), staleTime: 30 * 60_000 }
}
export function ytSubsQueryOptions(): UseQueryOptions<Subscription[]> {
  return { queryKey: ['yt-subs'], queryFn: getSubscriptions }
}

export async function getChannelPage(channelId: string, cursor?: string | null, tab: ChannelVideoTab = 'videos'): Promise<ChannelPage> {
  const base = `/api/youtube/channel/${encodeURIComponent(channelId)}${tab === 'videos' ? '' : `/${tab}`}`
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  const r = await fetch(`${base}${q}`, opts)
  return r.json() as Promise<ChannelPage>
}

export async function getChannelPlaylists(channelId: string, cursor?: string | null): Promise<ChannelPlaylistsPage> {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  const r = await fetch(`/api/youtube/channel/${encodeURIComponent(channelId)}/playlists${q}`, opts)
  return r.json() as Promise<ChannelPlaylistsPage>
}

export async function getChannelAbout(channelId: string): Promise<ChannelAbout | null> {
  const r = await fetch(`/api/youtube/channel/${encodeURIComponent(channelId)}/about`, opts)
  return (await r.json() as { about: ChannelAbout | null }).about
}

export async function getRelated(videoId: string, limit = 20): Promise<ItVideo[]> {
  const r = await fetch(`/api/youtube/related/${videoId}?limit=${limit}`, opts)
  return (await r.json() as { videos: ItVideo[] }).videos ?? []
}

// ── SponsorBlock ─────────────────────────────────────────────────────────────────

export interface SkipSegment { category: string; start: number; end: number }

export async function getSponsorSegments(videoId: string): Promise<SkipSegment[]> {
  const r = await fetch(`/api/youtube/sponsorblock/${videoId}`, opts)
  if (!r.ok) return []
  return (await r.json() as { segments: SkipSegment[] }).segments ?? []
}

// ── Comments ─────────────────────────────────────────────────────────────────────

export interface YtComment {
  author: string
  authorThumb: string | null
  text: string
  likeCount: string | null
  publishedText: string | null
  replyCount: number | null
  pinned: boolean
}

export async function getComments(videoId: string, limit = 20): Promise<YtComment[]> {
  const r = await fetch(`/api/youtube/comments/${videoId}?limit=${limit}`, opts)
  if (!r.ok) return []
  return (await r.json() as { comments: YtComment[] }).comments ?? []
}

// ── Chapters (authoritative InnerTube source; complements description parsing) ──────

export interface YtChapter { start: number; title: string }

export async function getChapters(videoId: string): Promise<YtChapter[]> {
  const r = await fetch(`/api/youtube/chapters/${videoId}`, opts)
  if (!r.ok) return []
  return (await r.json() as { chapters: YtChapter[] }).chapters ?? []
}

// ── Return YouTube Dislike ─────────────────────────────────────────────────────────

export interface VideoVotes { likes: number; dislikes: number; rating: number; viewCount: number }

export async function getVotes(videoId: string): Promise<VideoVotes | null> {
  const r = await fetch(`/api/youtube/votes/${videoId}`, opts)
  if (!r.ok) return null
  return (await r.json() as { votes: VideoVotes | null }).votes
}

// ── DeArrow (batched de-clickbait titles/thumbnails) ───────────────────────────────

export interface DeArrowItem { title: string | null; thumbnailUrl: string | null }

export async function getDeArrowBatch(videoIds: string[]): Promise<Record<string, DeArrowItem>> {
  if (!videoIds.length) return {}
  const r = await fetch('/api/youtube/dearrow', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ videoIds }) })
  if (!r.ok) return {}
  return (await r.json() as { branding: Record<string, DeArrowItem> }).branding ?? {}
}

// ── Collections (server-backed Watch Later / Liked) ──────────────────────────────

export interface CollectionRow {
  videoId: string
  title: string
  author: string | null
  channelId: string | null
  channelThumb?: string | null
  durationSec: number | null
  addedAt: number
}

export async function getCollections(): Promise<Record<'watch-later' | 'liked', CollectionRow[]>> {
  const r = await fetch('/api/youtube/collections', { ...opts, cache: 'no-store' })
  if (!r.ok) return { 'watch-later': [], liked: [] }
  return r.json() as Promise<Record<'watch-later' | 'liked', CollectionRow[]>>
}

export async function putCollection(key: 'watch-later' | 'liked', videoId: string, meta: Partial<CollectionRow>): Promise<void> {
  await fetch(`/api/youtube/collections/${key}/${videoId}`, { ...opts, method: 'PUT', headers: J, body: JSON.stringify(meta) }).catch(() => {})
}

export async function removeCollection(key: 'watch-later' | 'liked', videoId: string): Promise<void> {
  await fetch(`/api/youtube/collections/${key}/${videoId}`, { ...opts, method: 'DELETE' }).catch(() => {})
}

// ── Browse / search ────────────────────────────────────────────────────────────

export interface PlaylistSearchResult {
  playlistId: string
  title: string
  videoCount: number | null
  thumbnailUrl: string | null
  author: string | null
  channelId: string | null
  url: string
}

export interface SearchResponse {
  results: SearchResult[]
  channels?: ChannelSearchResult[]
  playlists?: PlaylistSearchResult[]
  continuation?: string | null   // pass back as `cursor` to load the next page
  error?: string
}

export type SearchType = 'all' | 'videos' | 'shorts' | 'playlists' | 'channels'

export async function search(q: string, cursor?: string | null, type: SearchType = 'all'): Promise<SearchResponse> {
  const parts = [`q=${encodeURIComponent(q)}`]
  if (cursor) parts.push(`cursor=${encodeURIComponent(cursor)}`)
  if (type && type !== 'all') parts.push(`type=${type}`)
  const r = await fetch(`/api/youtube/search?${parts.join('&')}`, opts)
  return r.json() as Promise<SearchResponse>
}

export interface PlaylistOwner { channelId: string | null; name: string | null; thumbnailUrl: string | null }

/** Videos in a playlist (browse a playlist found via search), plus its owning channel. */
export async function getPlaylist(playlistId: string): Promise<{ title: string | null; description?: string | null; owner?: PlaylistOwner | null; videos: ItVideo[] }> {
  const r = await fetch(`/api/youtube/playlist/${encodeURIComponent(playlistId)}`, opts)
  return r.json() as Promise<{ title: string | null; description?: string | null; owner?: PlaylistOwner | null; videos: ItVideo[] }>
}

/** Personalized recommendations seeded from watch history / subscriptions. */
export async function getRecommended(): Promise<ItVideo[]> {
  const r = await fetch('/api/youtube/recommended', { ...opts, cache: 'no-store' })
  return (await r.json() as { videos: ItVideo[] }).videos ?? []
}

export async function getFeed(limit = 120): Promise<FeedVideo[]> {
  const r = await fetch(`/api/youtube/feed?limit=${limit}`, { ...opts, cache: 'no-store' })
  return (await r.json() as { videos: FeedVideo[] }).videos ?? []
}

// Duration backfill is the one slow YouTube call (yt-dlp hits YouTube once per video),
// so a 40-id request can hold a connection open for ~40s. The browser only allows ~6
// concurrent connections per host, so a few of these — alongside our SSE streams — can
// starve the /api/health probe and falsely trip the "Can't reach the server" banner.
// Guard against that: chunk the work small and run every chunk through a single shared
// queue so at most ONE durations request is ever in flight, briefly, app-wide.
const DUR_CHUNK = 10
let durQueue: Promise<unknown> = Promise.resolve()
function enqueueDur<T>(fn: () => Promise<T>): Promise<T> {
  const run = durQueue.then(fn, fn)
  durQueue = run.catch(() => {})
  return run
}

export async function backfillDurations(
  videoIds: string[],
  onChunk?: (durations: Record<string, number>) => void,
): Promise<Record<string, number>> {
  if (!videoIds.length) return {}
  const out: Record<string, number> = {}
  for (let i = 0; i < videoIds.length; i += DUR_CHUNK) {
    const chunk = videoIds.slice(i, i + DUR_CHUNK)
    const part = await enqueueDur(async () => {
      const r = await fetch('/api/youtube/durations', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ videoIds: chunk }) })
      return (await r.json() as { durations: Record<string, number> }).durations ?? {}
    })
    Object.assign(out, part)
    if (Object.keys(part).length) onChunk?.(part)
  }
  return out
}

// ── Subscriptions ────────────────────────────────────────────────────────────

export async function getSubscriptions(): Promise<Subscription[]> {
  const r = await fetch('/api/youtube/subscriptions', opts)
  return (await r.json() as { subscriptions: Subscription[] }).subscriptions ?? []
}

export async function addSubscription(input: string): Promise<{ ok?: boolean; error?: string; subscription?: { id: string } }> {
  const r = await fetch('/api/youtube/subscriptions', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ input }) })
  return r.json() as Promise<{ ok?: boolean; error?: string; subscription?: { id: string } }>
}

export async function importSubscriptions(csv: string): Promise<{ error?: string }> {
  const r = await fetch('/api/youtube/subscriptions/import', { ...opts, method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: csv })
  return r.json() as Promise<{ error?: string }>
}

export async function deleteSubscription(id: string): Promise<void> {
  await fetch(`/api/youtube/subscriptions/${id}`, { ...opts, method: 'DELETE' })
}

export async function updateSubscription(
  id: string,
  patch: { autoSave?: boolean; autoSaveKind?: 'audio' | 'video'; autoSaveKeep?: number | null },
): Promise<void> {
  await fetch(`/api/youtube/subscriptions/${id}`, { ...opts, method: 'PATCH', headers: J, body: JSON.stringify(patch) })
}

export async function refreshAllSubscriptions(): Promise<void> {
  await fetch('/api/youtube/subscriptions/refresh-all', { ...opts, method: 'POST' })
}

// ── Automation master switch ───────────────────────────────────────────────────

export interface AutomationState { paused: boolean; keepDefault: number; isAdmin: boolean }

export async function getAutomation(): Promise<AutomationState> {
  const r = await fetch('/api/youtube/automation', { ...opts, cache: 'no-store' })
  return r.json() as Promise<AutomationState>
}

export async function setAutomation(patch: { paused?: boolean; keepDefault?: number }): Promise<void> {
  await fetch('/api/youtube/automation', { ...opts, method: 'PUT', headers: J, body: JSON.stringify(patch) })
}

// ── Offline library ──────────────────────────────────────────────────────────

export async function getDownloads(): Promise<SavedRow[]> {
  const r = await fetch('/api/youtube/downloads', { ...opts, cache: 'no-store' })
  return (await r.json() as { downloads: SavedRow[] }).downloads ?? []
}

export async function deleteDownloads(ids: string[]): Promise<void> {
  const r = await fetch('/api/youtube/downloads/delete', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ ids }) })
  if (!r.ok) throw new Error('delete')
}

export async function saveOffline(body: { videoId: string; title: string; kind: 'audio' | 'video'; maxHeight?: number; audioFormat?: 'm4a' | 'mp3' }): Promise<{ status?: string; error?: string }> {
  const r = await fetch('/api/youtube/save', { ...opts, method: 'POST', headers: J, body: JSON.stringify(body) })
  return r.json() as Promise<{ status?: string; error?: string }>
}

export async function getSaveQuality(): Promise<SaveQuality> {
  const r = await fetch('/api/youtube/save-quality', opts)
  return r.json() as Promise<SaveQuality>
}

// ── Export to device ───────────────────────────────────────────────────────────

export async function getFormats(videoId: string): Promise<YtFormat[]> {
  const r = await fetch(`/api/youtube/formats/${videoId}`, opts)
  return (await r.json() as { formats: YtFormat[] }).formats ?? []
}

export async function startExport(body: { videoId: string; title: string; format?: string; audioFormat?: string }): Promise<{ jobId?: string; error?: string }> {
  const r = await fetch('/api/youtube/export', { ...opts, method: 'POST', headers: J, body: JSON.stringify(body) })
  return r.json() as Promise<{ jobId?: string; error?: string }>
}

export async function getExport(jobId: string): Promise<{ state: string; progress: { completed: number } | null }> {
  const r = await fetch(`/api/youtube/export/${jobId}`, opts)
  return r.json() as Promise<{ state: string; progress: { completed: number } | null }>
}

// ── Video metadata / AI ────────────────────────────────────────────────────────

export async function getVideoMeta(videoId: string): Promise<VideoMeta> {
  const r = await fetch(`/api/youtube/video/${videoId}`, { ...opts, cache: 'no-store' })
  return r.json() as Promise<VideoMeta>
}

export async function summarize(videoId: string): Promise<string> {
  const r = await fetch(`/api/youtube/summarize/${videoId}`, { ...opts, method: 'POST' })
  const d = await r.json() as { summary?: string }
  return d.summary ?? ''
}

export async function getTranscriptText(videoId: string): Promise<string | null> {
  const r = await fetch(`/api/youtube/transcript-text/${videoId}`, opts)
  const d = await r.json() as { text?: string }
  return d.text ?? null
}

export interface WatchMeta { title?: string; author?: string | null; channelId?: string | null; durationSec?: number | null }

export async function saveWatchState(videoId: string, positionSec: number, completed: boolean, meta?: WatchMeta): Promise<void> {
  await fetch('/api/youtube/watch-state', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ videoId, positionSec, completed, ...meta }) }).catch(() => {})
}

export interface HistoryRow {
  videoId: string
  title: string
  author: string | null
  channelId: string | null
  channelThumb: string | null
  durationSec: number | null
  positionSec: number
  completed: boolean
  updatedAt: number
}

export async function getHistory(): Promise<HistoryRow[]> {
  const r = await fetch('/api/youtube/history', { ...opts, cache: 'no-store' })
  return (await r.json() as { history: HistoryRow[] }).history ?? []
}

/** Same-origin proxy for a YouTube image (avatar/thumbnail) — canvas-safe, no Google hit. */
export const ytImageProxy = (url: string) => `/api/youtube/img?u=${encodeURIComponent(url)}`

// ── Podcast bridge ─────────────────────────────────────────────────────────────

/**
 * Kick off an AI podcast episode from YouTube videos. Target a `showId` to add to an
 * existing show, pass `newShowName` to create one, or neither to use "YouTube Digest".
 */
export async function createPodcast(
  videos: { videoId: string; title?: string; author?: string }[],
  options?: { label?: string; showId?: string; newShowName?: string; limit?: number; sourceRef?: string },
): Promise<{ ok?: boolean; showId?: string; episodeCount?: number; remaining?: number; error?: string }> {
  const r = await fetch('/api/youtube/podcast', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ videos, ...options }) })
  return r.json() as Promise<{ ok?: boolean; showId?: string; episodeCount?: number; remaining?: number; error?: string }>
}

/** Reverse link: podcast episodes that were generated using this video. */
export async function getPodcastsForVideo(videoId: string): Promise<VideoPodcast[]> {
  const r = await fetch(`/api/podcasts/by-video/${videoId}`, opts)
  if (!r.ok) return []
  return (await r.json() as { episodes: VideoPodcast[] }).episodes ?? []
}
