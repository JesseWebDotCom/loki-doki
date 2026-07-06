// API client for the Videos hub endpoints (/api/videos/*). Source-agnostic: these
// shapes mirror backend/src/lib/videos/types.ts. YouTube-specific calls stay in
// lib/youtube/api.ts.

export type VideoSource = 'youtube' | 'reddit' | 'tiktok' | 'vimeo'

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
  isAdult?: boolean
  live?: boolean
  vertical?: boolean
  description?: string | null
}

export interface HubCreator extends HubCreatorRef {
  source: VideoSource
  kind: 'channel' | 'user' | 'subreddit' | 'category'
  bannerUrl?: string | null
  description?: string | null
  subscriberText?: string | null
}

export interface SourceInfo {
  source: VideoSource
  label: string
  capabilities: {
    browse: boolean
    search: boolean
    creators: boolean
    comments: boolean
    live: boolean
    downloadKinds: Array<'audio' | 'video'>
    authConfig: 'none' | 'apiKey' | 'cookies'
  }
  status: { configured: boolean; note?: string }
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

export function getVideoSources(): Promise<{ sources: SourceInfo[] }> {
  return getJson('/api/videos/sources')
}

export function getHubHome(sources?: VideoSource[]): Promise<{ items: HubVideoItem[] }> {
  const qs = sources?.length ? `?sources=${encodeURIComponent(sources.join(','))}` : ''
  return getJson(`/api/videos/home${qs}`)
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
  isAdult: boolean
  autoSave: boolean
  autoSaveKind: 'audio' | 'video'
  autoSaveKeep: number | null
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

export type HubPlayback =
  | { mode: 'native-app' }
  | { mode: 'proxy-progressive'; upstreamUrl: string }
  | { mode: 'hls'; manifestUrl: string }
  | { mode: 'file'; assetId: string }

export function getSourceItem(source: VideoSource, id: string): Promise<{ item: HubVideoItem; playback: HubPlayback }> {
  return getJson(`/api/videos/${source}/item/${encodeURIComponent(id)}`)
}

export function getSourceComments(source: VideoSource, id: string): Promise<{ comments: Array<{ author: string; text: string; likes?: string | null; publishedText?: string | null }> }> {
  return getJson(`/api/videos/${source}/comments/${encodeURIComponent(id)}`)
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
export function patchFollow(id: string, patch: { autoSave?: boolean; autoSaveKind?: 'audio' | 'video'; autoSaveKeep?: number | null }): Promise<{ ok: true }> {
  return sendJson(`/api/videos/follows/${encodeURIComponent(id)}`, 'PATCH', patch)
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

export function putWatchState(source: VideoSource, videoId: string, positionSec: number, completed: boolean): Promise<{ ok: true }> {
  return sendJson('/api/videos/watch-state', 'PUT', { source, videoId, positionSec, completed })
}

export function getRedditConfig(): Promise<{ configured: boolean; clientId: string }> {
  return getJson('/api/videos/config/reddit')
}
export function putRedditConfig(clientId: string): Promise<{ ok: true }> {
  return sendJson('/api/videos/config/reddit', 'PUT', { clientId })
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
