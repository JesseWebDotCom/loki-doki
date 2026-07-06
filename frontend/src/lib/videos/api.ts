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
