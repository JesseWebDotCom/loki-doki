// Typed wrappers around the /api/youtube/* endpoints (+ the podcast reverse-link),
// consolidating the fetch helpers that used to live inline in YoutubePage.

import type { UseQueryOptions } from '@tanstack/react-query'
import type { SuggestSource } from '@/lib/smartSearch/types'

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
  /** Delete auto-saved copies once fully watched (offline rule, independent of Plex). */
  removeWatched: boolean
  /** Auto-transcribe new uploads (captions first, Whisper only when a video has none). */
  autoTranscribe: boolean
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
  views: string | null
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
  /** Download progress 0..1 for in-flight saves (pending/downloading); null otherwise. */
  progress: number | null
  /** Background enhancement state (video only): 'enhancing' while re-encoding, 'enhanced' when
   *  the crisper rendition is ready and serving; null otherwise. */
  enhance: 'enhancing' | 'enhanced' | null
  /** Enhance re-encode progress 0..1 while `enhance === 'enhancing'`; null otherwise. */
  enhanceProgress?: number | null
  createdAt: string
  author: string | null
  channelId: string | null
  channelThumb: string | null
  publishedAt: number | null
  durationSec: number | null
  views: string | null
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
  subscribers?: string | null
  description: string | null
  descriptionClean?: string | null
  summary?: string | null
  positionSec: number
  durationSec: number | null
  views?: string | null
  /** Upload date, unix ms (from the cached row, InnerTube microformat, or yt-dlp). */
  publishedAt?: number | null
  subscribed?: boolean
  subscriptionId?: string | null
  isLive?: boolean
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
export type StreamQuality = 'auto' | '2160' | '1440' | '1080' | '720' | '360'
/** The proxy tiers served by the server-side remux (split tracks, seek via ?t=). */
export const REMUX_QUALITIES = new Set<StreamQuality>(['2160', '1440', '1080'])
/** Privacy proxy: stream a video (or its audio) through our server, never Google.
 *  `startSec` only applies to the 1080p remux tier, whose piped output isn't
 *  byte-seekable, so the player seeks by re-requesting from an offset instead. */
export const proxyStreamUrl = (videoId: string, kind: 'audio' | 'video' = 'video', quality: StreamQuality = 'auto', startSec?: number) =>
  `/api/youtube/stream/${videoId}?kind=${kind}${quality !== 'auto' ? `&q=${quality}` : ''}${startSec && startSec > 0.25 ? `&t=${startSec.toFixed(3)}` : ''}`

/** Warm the proxy-stream cache so a later hand-off to the mini-player plays instantly.
 *  Best-effort and fire-and-forget — failures are harmless (the stream just resolves cold). */
export const prewarmStream = (videoId: string, kind: 'audio' | 'video' = 'video', quality: StreamQuality = 'auto') =>
  void fetch(`/api/youtube/stream/${videoId}/prewarm?kind=${kind}${quality !== 'auto' ? `&q=${quality}` : ''}`, { credentials: 'include' }).catch(() => {})

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

/** Topic-grouped related shelves: an LLM names the video's concrete subjects from its
 *  title + transcript, each returned with its own search-result videos. Slow on the first
 *  open of a video (transcript fetch + LLM); cached server-side after that. */
export interface RelatedSearchTopic { query: string; videos: ItVideo[] }
export async function getRelatedSearches(videoId: string): Promise<RelatedSearchTopic[]> {
  const r = await fetch(`/api/youtube/related-searches/${videoId}`, opts)
  if (!r.ok) throw new Error('Could not load related videos')
  return (await r.json() as { topics: RelatedSearchTopic[] }).topics ?? []
}

// ── SponsorBlock ─────────────────────────────────────────────────────────────────

/** Per-category behavior the server attached to each segment: 'skip' auto-skips,
 *  'show' only marks the seek bar, 'prompt' offers an on-screen Skip button.
 *  Categories set to 'off' never leave the server. */
export type SegmentMode = 'skip' | 'show' | 'prompt'
export interface SkipSegment { category: string; start: number; end: number; mode: SegmentMode }

export async function getSponsorSegments(videoId: string): Promise<SkipSegment[]> {
  // modes=1: ask for ALL non-off segments with their mode (not just the auto-skip ones).
  const r = await fetch(`/api/youtube/sponsorblock/${videoId}?modes=1`, opts)
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

/** Full /chapters response: `ai` marks AI-built chapters (from the caption track), and
 *  `aiPending` means a background build was kicked, so a refetch ~30-90s later may
 *  return chapters for a video that had none. */
export interface YtChaptersResult { chapters: YtChapter[]; ai?: boolean; aiPending?: boolean }

export async function getChaptersWithStatus(videoId: string): Promise<YtChaptersResult> {
  const r = await fetch(`/api/youtube/chapters/${videoId}`, opts)
  if (!r.ok) return { chapters: [] }
  const data = await r.json() as YtChaptersResult
  return { chapters: data.chapters ?? [], ai: data.ai, aiPending: data.aiPending }
}

export async function getChapters(videoId: string): Promise<YtChapter[]> {
  return (await getChaptersWithStatus(videoId)).chapters
}

// ── "Previously..." resume recap ──────────────────────────────────────────────────

/** Recap of everything before `atSec` (the server returns null under 5 minutes in).
 *  `pending` means a background build was kicked; poll again a few seconds later. */
export interface YtRecap { recap: string | null; pending?: boolean }

export async function getRecap(videoId: string, atSec: number): Promise<YtRecap> {
  const r = await fetch(`/api/youtube/recap/${videoId}?atSec=${Math.floor(atSec)}`, opts)
  if (!r.ok) return { recap: null }
  const data = await r.json() as YtRecap
  return { recap: data.recap ?? null, pending: data.pending }
}

/** One "most replayed" heat marker: rewatch intensity (0-1) over a time slice. */
export interface YtHeatMarker { startMs: number; durationMs: number; intensity: number }

export async function getHeatmap(videoId: string): Promise<YtHeatMarker[]> {
  const r = await fetch(`/api/youtube/heatmap/${videoId}`, opts)
  if (!r.ok) return []
  return (await r.json() as { markers: YtHeatMarker[] }).markers ?? []
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
  /** Video thumbnail snapshot — carried for non-YouTube sources (yt derives from videoId). */
  thumbnailUrl?: string | null
  durationSec: number | null
  addedAt: number
  /** Which video source this entry belongs to — absent/'youtube' for pre-existing rows. */
  videoSource?: 'youtube' | 'reddit' | 'tiktok' | 'vimeo' | 'link' | 'mine'
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

// ── Linked YouTube account ─────────────────────────────────────────────────────
// Sign in with the TV-style device flow (code on screen, approve on your phone); the
// backend mirrors subscriptions / Watch Later / Liked while linked.

export interface YtAccountInfo {
  channelTitle: string | null
  channelHandle: string | null
  channelAvatarUrl: string | null
  status: 'active' | 'expired'
  syncSubscriptions: boolean
  syncWatchLater: boolean
  syncLiked: boolean
  pushEnabled: boolean
  lastSyncAt: number | null
  lastSyncError: string | null
  connectedAt: number
}

export interface YtLinkFlow {
  status: 'pending' | 'success' | 'error'
  userCode: string
  verificationUrl: string
  expiresAt: number
  error?: string
}

export interface YtAccountState {
  linked: boolean
  account: YtAccountInfo | null
  flow: YtLinkFlow | null
}

export async function getAccount(): Promise<YtAccountState> {
  const r = await fetch('/api/youtube/account', { ...opts, cache: 'no-store' })
  if (!r.ok) throw new Error('account state failed')
  return r.json() as Promise<YtAccountState>
}

export async function startAccountLink(): Promise<YtLinkFlow> {
  const r = await fetch('/api/youtube/account/link', { ...opts, method: 'POST' })
  const data = await r.json().catch(() => ({}))
  if (!r.ok || data.error) throw new Error(data.error ?? 'Could not start sign-in')
  return data.flow as YtLinkFlow
}

export async function cancelAccountLink(): Promise<void> {
  await fetch('/api/youtube/account/link', { ...opts, method: 'DELETE' }).catch(() => {})
}

export async function patchAccount(patch: Partial<Pick<YtAccountInfo, 'syncSubscriptions' | 'syncWatchLater' | 'syncLiked' | 'pushEnabled'>>): Promise<YtAccountState> {
  const r = await fetch('/api/youtube/account', { ...opts, method: 'PATCH', headers: J, body: JSON.stringify(patch) })
  if (!r.ok) throw new Error('save failed')
  return r.json() as Promise<YtAccountState>
}

export async function syncAccountNow(): Promise<void> {
  const r = await fetch('/api/youtube/account/sync', { ...opts, method: 'POST' })
  const data = await r.json().catch(() => ({}))
  if (!r.ok || data.error) throw new Error(data.error ?? 'Sync failed to start')
}

export async function unlinkAccount(): Promise<void> {
  const r = await fetch('/api/youtube/account', { ...opts, method: 'DELETE' })
  if (!r.ok) throw new Error('disconnect failed')
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

/** Query-autosuggest source for SmartSearchInput, backed by YouTube's own suggest endpoint. */
export const youtubeSuggestSource: SuggestSource = async (query, signal) => {
  const r = await fetch(`/api/youtube/suggest?q=${encodeURIComponent(query)}`, { ...opts, signal })
  const d = await r.json() as { suggestions?: string[] }
  return (d.suggestions ?? []).map((label, i) => ({ id: String(i), label }))
}

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

/** Personalized recommendations from the interest engine (watch-history profile).
 *  `building` = the engine's first pool build is still running and this response is the
 *  legacy fallback chain; callers poll until it flips false. */
export async function getRecommended(): Promise<{ videos: ItVideo[]; building: boolean }> {
  const r = await fetch('/api/youtube/recommended', { ...opts, cache: 'no-store' })
  const data = await r.json() as { videos?: ItVideo[]; building?: boolean }
  return { videos: data.videos ?? [], building: data.building === true }
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
  patch: { autoSave?: boolean; autoSaveKind?: 'audio' | 'video'; autoSaveKeep?: number | null; removeWatched?: boolean; autoTranscribe?: boolean },
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

/** Cancel in-flight saves (queued/downloading). Aborts the underlying download when nothing
 *  else references the shared asset; ready/failed rows are left untouched (use delete for those). */
export async function cancelDownloads(ids: string[]): Promise<void> {
  const r = await fetch('/api/youtube/downloads/cancel', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ ids }) })
  if (!r.ok) throw new Error('cancel')
}

export async function saveOffline(body: { videoId: string; title: string; kind: 'audio' | 'video'; maxHeight?: number; audioFormat?: 'm4a' | 'mp3' }): Promise<{ status?: string; error?: string }> {
  const r = await fetch('/api/youtube/save', { ...opts, method: 'POST', headers: J, body: JSON.stringify(body) })
  return r.json() as Promise<{ status?: string; error?: string }>
}

export async function getSaveQuality(): Promise<SaveQuality> {
  const r = await fetch('/api/youtube/save-quality', opts)
  return r.json() as Promise<SaveQuality>
}

/** Save a channel's current back-catalogue (latest `count` uploads) to the Offline library now.
 *  auto:true = the "Configure for offline" backfill (rows join the rolling keep-N window). */
export async function saveChannelNow(channelId: string, body: { kind: 'audio' | 'video'; count: number; auto?: boolean }): Promise<{ ok?: boolean; queued?: number; total?: number; error?: string }> {
  const r = await fetch(`/api/youtube/channel/${encodeURIComponent(channelId)}/save-now`, { ...opts, method: 'POST', headers: J, body: JSON.stringify(body) })
  return r.json() as Promise<{ ok?: boolean; queued?: number; total?: number; error?: string }>
}

// ── Live-from-start DVR ──────────────────────────────────────────────────────────

export async function startLiveRecord(videoId: string, title: string): Promise<{ status?: string; error?: string }> {
  const r = await fetch(`/api/youtube/live/${videoId}/record`, { ...opts, method: 'POST', headers: J, body: JSON.stringify({ title }) })
  return r.json() as Promise<{ status?: string; error?: string }>
}

export async function stopLiveRecord(videoId: string): Promise<{ ok: boolean }> {
  const r = await fetch(`/api/youtube/live/${videoId}/stop`, { ...opts, method: 'POST' })
  return r.json() as Promise<{ ok: boolean }>
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

export interface WatchMeta { title?: string; author?: string | null; channelId?: string | null; durationSec?: number | null; origin?: 'youtube' | 'music' }

export interface WatchTimeGate {
  allowed: boolean
  reason?: 'budget' | 'hours'
  remainingSec: number | null
}

export async function saveWatchState(videoId: string, positionSec: number, completed: boolean, meta?: WatchMeta): Promise<WatchTimeGate | null> {
  try {
    const r = await fetch('/api/youtube/watch-state', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ videoId, positionSec, completed, ...meta }) })
    if (!r.ok) return null
    const data = await r.json() as { timeLimit?: WatchTimeGate }
    return data.timeLimit ?? null
  } catch { return null }
}

export interface HistoryRow {
  videoId: string
  title: string
  author: string | null
  channelId: string | null
  channelThumb: string | null
  durationSec: number | null
  views: string | null
  positionSec: number
  completed: boolean
  updatedAt: number
}

export async function getHistory(): Promise<HistoryRow[]> {
  const r = await fetch('/api/youtube/history', { ...opts, cache: 'no-store' })
  return (await r.json() as { history: HistoryRow[] }).history ?? []
}

export interface AccountHistoryRow { videoId: string; title: string; author: string | null; channelId: string | null; durationSec: number | null; channelThumb: string | null }

/** Local history + the linked YouTube account's history (deduped server-side). */
export async function getHistoryFull(): Promise<{ history: HistoryRow[]; accountHistory: AccountHistoryRow[] }> {
  const r = await fetch('/api/youtube/history', { ...opts, cache: 'no-store' })
  const data = await r.json() as { history: HistoryRow[]; accountHistory?: AccountHistoryRow[] }
  return { history: data.history ?? [], accountHistory: data.accountHistory ?? [] }
}

/** Remove one video from watch history. */
export async function removeHistoryItem(videoId: string): Promise<void> {
  await fetch(`/api/youtube/history/${encodeURIComponent(videoId)}`, { ...opts, method: 'DELETE' })
}

/** Clear the entire watch history. */
export async function clearHistory(): Promise<void> {
  await fetch('/api/youtube/history', { ...opts, method: 'DELETE' })
}

/** Same-origin proxy for a YouTube image (avatar/thumbnail) — canvas-safe, no Google hit. */
export const ytImageProxy = (url: string) => `/api/youtube/img?u=${encodeURIComponent(url)}`

// ── Podcast bridge ─────────────────────────────────────────────────────────────

/**
 * Kick off an AI podcast episode from YouTube videos. Target a `showId` to add to an
 * existing show, pass `newShowName` to create one, or neither to use "YouTube Digest".
 */
export async function createPodcast(
  videos: { videoId: string; title?: string; author?: string; source?: string; url?: string }[],
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
