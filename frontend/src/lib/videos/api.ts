// API client for the Videos hub endpoints (/api/videos/*). Source-agnostic: these
// shapes mirror backend/src/lib/videos/types.ts. YouTube-specific calls stay in
// lib/youtube/api.ts.

// 'link' = the universal paste-any-URL source (yt-dlp-backed). No discovery surface; the
// search bar routes a pasted URL to its watch page, where it plays like any hub item.
export type VideoSource = 'youtube' | 'reddit' | 'tiktok' | 'vimeo' | 'link'

export interface HubCreatorRef {
  id: string
  name: string
  handle?: string | null
  avatarUrl?: string | null
}

export interface HubVideoItem {
  source: VideoSource
  id: string
  url: string
  title: string
  creator?: HubCreatorRef | null
  thumbnailUrl?: string | null
  durationSec?: number | null
  publishedAt?: number | null
  publishedText?: string | null
  viewsText?: string | null
  /** Pre-formatted like count, e.g. "4.4K likes" (getItem only — not populated on list/browse cards). */
  likesText?: string | null
  /** Compact comment count, e.g. "149" or "1.2K" (getItem only) — feeds the watch page's "Comments (N)" tab label. */
  commentsCount?: string | null
  isAdult?: boolean
  live?: boolean
  vertical?: boolean
  description?: string | null
  /** Resume position, set on Continue-watching items so cards can show a progress bar. */
  watch?: { positionSec: number; completed: boolean } | null
}

export interface HubCreator extends HubCreatorRef {
  source: VideoSource
  kind: 'channel' | 'user' | 'subreddit' | 'category'
  bannerUrl?: string | null
  description?: string | null
  subscriberText?: string | null
  followingText?: string | null
  likesText?: string | null
  /** Pre-formatted display count, e.g. "1.2K videos" — shown in the header meta line. */
  videoCount?: string | null
}

export interface HubPlaylist {
  id: string
  title: string
  thumbnailUrl?: string | null
  videoCount?: number | null
}

export interface SourceInfo {
  source: VideoSource
  label: string
  browseFeeds: Array<{ id: string; label: string }>
  /** Discovery shelves this source can serve (Popular/Trending); subset per platform. */
  discovery: Array<'popular' | 'trending'>
  capabilities: {
    browse: boolean
    search: boolean
    creators: boolean
    comments: boolean
    live: boolean
    downloadKinds: Array<'audio' | 'video'>
    authConfig: 'none' | 'apiKey' | 'cookies'
    playlists?: boolean
    /** Watch page has a "Related videos" shelf. */
    related?: boolean
    /** Watch page shows Transcript + AI Summary tabs (absent = true). */
    transcript?: boolean
  }
  status: { configured: boolean; note?: string }
  /** Admin-controlled: whether this source shows up on discovery surfaces (rail, home
   *  feed, browse pages). Already-followed/saved items and direct playback are unaffected. */
  enabled: boolean
}

export type ResolveResult =
  | { ok: true; kind: 'provider'; match: 'video'; source: VideoSource; item: HubVideoItem }
  | { ok: true; kind: 'provider'; match: 'creator'; source: VideoSource; creator: HubCreator }
  | {
      ok: true; kind: 'clip'
      title: string; thumbnailUrl: string | null; durationSeconds: number | null; extractor: string | null
      formats: Array<{ formatId: string; ext: string; resolution: string; note: string; protocol: string; vcodec: string; acodec: string; filesize: number | null }>
    }

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'include' })
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return res.json() as Promise<T>
}

export function getVideoSources(): Promise<{ sources: SourceInfo[]; allowlistOnly?: boolean }> {
  return getJson('/api/videos/sources')
}

export function getHubHome(sources?: VideoSource[], cursor?: string | null): Promise<{ items: HubVideoItem[]; cursor: string | null }> {
  const params = new URLSearchParams()
  if (sources?.length) params.set('sources', sources.join(','))
  if (cursor) params.set('cursor', cursor)
  const qs = params.toString()
  return getJson(`/api/videos/home${qs ? `?${qs}` : ''}`)
}

/** Cross-source "Suggested for you" from the interest engine. `building` = the first
 *  pool build is still running (caller polls; the shelf stays hidden until items land). */
export function getSuggested(): Promise<{ items: HubVideoItem[]; building: boolean }> {
  return getJson('/api/videos/suggested')
}

export interface HubPager {
  items: HubVideoItem[]
  cursor: string | null
}

export interface VideoFollow {
  id: string
  source: VideoSource
  kind: 'creator' | 'subreddit' | 'channel'
  externalId: string
  title: string
  handle?: string | null
  thumbnailUrl?: string | null
  description?: string | null
  isAdult: boolean
  autoSave: boolean
  autoSaveKind: 'audio' | 'video'
  autoSaveKeep: number | null
  /** Delete auto-saved copies once fully watched (offline rule, independent of Plex). */
  removeWatched: boolean
  /** Last time the poller pulled new uploads; used to sort the unified subscriptions list. */
  lastFetchedAt?: string | null
  addedAt?: string | null
}

export interface VideoSave {
  id: string
  source: VideoSource
  videoId: string
  title: string
  kind: 'audio' | 'video'
  status: 'pending' | 'downloading' | 'ready' | 'failed'
  thumbnailUrl?: string | null
  creatorName?: string | null
  durationSec?: number | null
  sizeBytes?: number | null
  error?: string | null
}

export function browseSource(source: VideoSource, opts?: { feed?: string; cursor?: string | null }): Promise<HubPager> {
  const p = new URLSearchParams()
  if (opts?.feed) p.set('feed', opts.feed)
  if (opts?.cursor) p.set('cursor', opts.cursor)
  const qs = p.toString()
  return getJson(`/api/videos/${source}/browse${qs ? `?${qs}` : ''}`)
}

export function searchSource(source: VideoSource, q: string, cursor?: string | null): Promise<HubPager> {
  const p = new URLSearchParams({ q })
  if (cursor) p.set('cursor', cursor)
  return getJson(`/api/videos/${source}/search?${p}`)
}

export function getSourceCreator(source: VideoSource, id: string, cursor?: string | null): Promise<{ creator: HubCreator; videos: HubPager }> {
  return getJson(`/api/videos/${source}/creator/${encodeURIComponent(id)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
}

export function getCreatorPlaylists(source: VideoSource, id: string, cursor?: string | null): Promise<{ items: HubPlaylist[]; cursor: string | null }> {
  return getJson(`/api/videos/${source}/creator/${encodeURIComponent(id)}/playlists${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
}

export function getSourcePlaylist(source: VideoSource, id: string, cursor?: string | null): Promise<HubPager> {
  return getJson(`/api/videos/${source}/playlist/${encodeURIComponent(id)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
}

export interface SubscriptionPlaylistGroup {
  source: VideoSource
  externalId: string
  title: string
  thumbnailUrl: string | null
  playlists: HubPlaylist[]
}

/** Playlists published by every channel/creator you follow (YouTube subs + generic
 *  follows), aggregated server-side from a warmed per-channel cache. `warming` is how
 *  many channels are still being checked in the background — poll while it's nonzero. */
export function getSubscriptionPlaylists(): Promise<{ groups: SubscriptionPlaylistGroup[]; warming: number }> {
  return getJson('/api/videos/subscriptions/playlists')
}

export type HubPlayback =
  | { mode: 'native-app' }
  | { mode: 'stream'; streamUrl: string }
  | { mode: 'hls'; manifestUrl: string }
  // Official first-party embed player (TikTok/Vimeo): rendered as an <iframe>, no yt-dlp.
  | { mode: 'embed'; embedUrl: string }
  | { mode: 'file'; assetId: string }

export function getSourceItem(source: VideoSource, id: string): Promise<{ item: HubVideoItem; playback: HubPlayback }> {
  return getJson(`/api/videos/${source}/item/${encodeURIComponent(id)}`)
}

export function getSourceComments(source: VideoSource, id: string): Promise<{ comments: Array<{ author: string; text: string; likes?: string | null; publishedText?: string | null }> }> {
  return getJson(`/api/videos/${source}/comments/${encodeURIComponent(id)}`)
}

export function getSourceRelated(source: VideoSource, id: string): Promise<{ items: HubVideoItem[] }> {
  return getJson(`/api/videos/${source}/related/${encodeURIComponent(id)}`)
}

/** Raw WebVTT for the transcript tab; '' when the video has no captions. */
export async function getSourceTranscript(source: VideoSource, id: string): Promise<string> {
  const res = await fetch(`/api/videos/${source}/transcript/${encodeURIComponent(id)}`, { credentials: 'include' })
  return res.ok ? res.text() : ''
}

/** Transcript-based AI summary (generated + cached server-side); null = no captions. */
export function getSourceSummary(source: VideoSource, id: string): Promise<{ summary: string | null }> {
  return getJson(`/api/videos/${source}/summary/${encodeURIComponent(id)}`)
}

async function sendJson<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => null) as (T & { error?: string }) | null
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? `${path} → ${res.status}`)
  return data as T
}

export function listFollows(): Promise<{ follows: VideoFollow[] }> {
  return getJson('/api/videos/follows')
}
export function addFollow(source: VideoSource, externalId: string): Promise<{ ok: true; id: string }> {
  return sendJson('/api/videos/follows', 'POST', { source, externalId })
}
export function removeFollow(id: string): Promise<{ ok: true }> {
  return sendJson(`/api/videos/follows/${encodeURIComponent(id)}`, 'DELETE')
}
export function patchFollow(id: string, patch: { autoSave?: boolean; autoSaveKind?: 'audio' | 'video'; autoSaveKeep?: number | null; removeWatched?: boolean }): Promise<{ ok: true }> {
  return sendJson(`/api/videos/follows/${encodeURIComponent(id)}`, 'PATCH', patch)
}

/** Back-catalogue grab for a creator. auto:true = the "Configure for offline" backfill
 *  (rows join the rolling keep-N window); auto:false = explicit saves the prune never touches. */
export function saveCreatorNow(source: VideoSource, creatorId: string, body: { kind: 'audio' | 'video'; count: number; auto: boolean }): Promise<{ ok?: boolean; queued?: number; total?: number; error?: string }> {
  return sendJson(`/api/videos/${source}/creator/${encodeURIComponent(creatorId)}/save-now`, 'POST', body)
}

export function listSaves(source?: VideoSource): Promise<{ saves: VideoSave[] }> {
  return getJson(`/api/videos/saves${source ? `?source=${source}` : ''}`)
}
export function saveVideo(source: VideoSource, videoId: string, kind: 'audio' | 'video' = 'video'): Promise<{ ok: true; id: string }> {
  return sendJson(`/api/videos/${source}/save`, 'POST', { videoId, kind })
}
export function deleteSave(id: string): Promise<{ ok: true }> {
  return sendJson(`/api/videos/saves/${encodeURIComponent(id)}`, 'DELETE')
}
export function savedFileUrl(source: VideoSource, videoId: string, kind: 'audio' | 'video'): string {
  return `/api/videos/${source}/file/${encodeURIComponent(videoId)}/${kind}`
}

export interface WatchStateSnapshot {
  title: string
  thumbnailUrl?: string | null
  creatorId?: string | null
  creatorName?: string | null
  durationSec?: number | null
  isAdult?: boolean
}

/** `snapshot` lets "Continue watching" show a real title/thumbnail even for videos that
 *  aren't in a followed creator's feed cache (direct links, search, browsing without
 *  following): pass the item you already have in hand rather than making history depend
 *  on a separate cache table that only the followed-feed poller populates. */
export function putWatchState(
  source: VideoSource, videoId: string, positionSec: number, completed: boolean, snapshot?: WatchStateSnapshot,
): Promise<{ ok: true }> {
  return sendJson('/api/videos/watch-state', 'PUT', { source, videoId, positionSec, completed, ...snapshot })
}

export interface HubHistoryRow {
  source: VideoSource
  videoId: string
  title: string
  creatorId: string | null
  creatorName: string | null
  /** Only set for followed creators (cached at follow time); otherwise the card falls back
   *  to a letter avatar. */
  creatorAvatarUrl: string | null
  thumbnailUrl: string | null
  durationSec: number | null
  positionSec: number
  completed: boolean
  updatedAt: number
}

/** Watch history for non-YouTube sources (YouTube keeps its own richer endpoint). */
export function getHubHistory(): Promise<{ history: HubHistoryRow[] }> {
  return getJson('/api/videos/history')
}

export function getFollowingFeed(source?: VideoSource): Promise<{ items: HubVideoItem[] }> {
  return getJson(`/api/videos/following-feed${source ? `?source=${source}` : ''}`)
}

export function getRedditConfig(): Promise<{ configured: boolean; clientId: string }> {
  return getJson('/api/videos/config/reddit')
}
export function putRedditConfig(clientId: string): Promise<{ ok: true }> {
  return sendJson('/api/videos/config/reddit', 'PUT', { clientId })
}

export function getVimeoConfig(): Promise<{ configured: boolean; token: string }> {
  return getJson('/api/videos/config/vimeo')
}
export function putVimeoConfig(token: string): Promise<{ ok: true }> {
  return sendJson('/api/videos/config/vimeo', 'PUT', { token })
}

/** Admin-only: which sources show up on discovery surfaces (rail, home feed, browse). */
export function putEnabledSources(sources: VideoSource[]): Promise<{ ok: true }> {
  return sendJson('/api/videos/config/sources', 'PUT', { sources })
}

/** Fast URL router for the search bar: provider match (no yt-dlp) or the 'link' fallback.
 *  Returns where to navigate; the watch page does the actual metadata resolve. */
export async function routeVideoUrl(url: string): Promise<{ source: VideoSource; kind: 'video' | 'creator'; id: string }> {
  const res = await fetch('/api/videos/route', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  const data = await res.json().catch(() => null) as { source?: VideoSource; kind?: 'video' | 'creator'; id?: string; error?: string } | null
  if (!res.ok || !data?.source || !data.id) throw new Error(data?.error ?? 'Could not open that link')
  return { source: data.source, kind: data.kind ?? 'video', id: data.id }
}

export async function resolveVideoUrl(url: string): Promise<ResolveResult> {
  const res = await fetch('/api/videos/resolve', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  const data = await res.json().catch(() => null) as (ResolveResult & { error?: string }) | null
  if (!res.ok || !data || ('error' in (data ?? {}) && data?.error)) {
    throw new Error((data as { error?: string } | null)?.error ?? 'Could not resolve that link')
  }
  return data
}
