// Frontend client for user-created YouTube playlists (/api/youtube/playlists/*) — distinct
// from Watch Later/Liked (./collections.ts) and from viewing someone else's real YouTube
// playlist (getPlaylist in ./api.ts). Thin typed wrappers, mirroring the Music playlist client.

import type { VideoSource } from '@/lib/videos/api'

export type YtVisibility = 'private' | 'shared'
/** Absent/'youtube' for pre-existing rows — playlists predate cross-source entries. */
export type PlaylistVideoSource = VideoSource | 'mine'

export interface YtPlaylist {
  id: string; name: string; description: string | null; visibility: YtVisibility
  owned: boolean; ownerName: string | null; videoCount: number
  /** First few videoIds (by position) — render as a real thumbnail cover instead of a placeholder icon. */
  coverVideoIds: string[]
}
export interface YtPlaylistVideo {
  id: string; playlistId: string; videoId: string; title: string
  author: string | null; channelId: string | null; durationSec: number | null; position: number
  videoSource: PlaylistVideoSource
  thumbnailUrl: string | null
}

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }

// The backend's router is trailing-slash-strict: '/api/youtube/playlists' matches the
// collection root, '/api/youtube/playlists/' (with a bare '/' appended below) does not and
// 404s. Normalizing here protects every caller, not just the two that hit this today.
async function yfetch<T>(path: string, init?: RequestInit): Promise<T> {
  const suffix = path === '/' ? '' : path
  const res = await fetch(`/api/youtube/playlists${suffix}`, { ...opts, ...init })
  if (!res.ok) throw new Error(`yt-playlists ${path} → ${res.status}`)
  return res.json() as Promise<T>
}
const body = (v: unknown) => JSON.stringify(v)

export function listYtPlaylists() { return yfetch<{ mine: YtPlaylist[]; shared: YtPlaylist[] }>('/') }
export function getYtPlaylist(id: string) { return yfetch<{ playlist: YtPlaylist; videos: YtPlaylistVideo[] }>(`/${id}`) }
export function createYtPlaylist(b: { name: string; description?: string; visibility?: YtVisibility }) {
  return yfetch<{ playlist: YtPlaylist }>('/', { method: 'POST', headers: J, body: body(b) })
}
export function updateYtPlaylist(id: string, b: Partial<Pick<YtPlaylist, 'name' | 'description' | 'visibility'>>) {
  return yfetch<{ playlist: YtPlaylist }>(`/${id}`, { method: 'PATCH', headers: J, body: body(b) })
}
export function deleteYtPlaylist(id: string) { return yfetch<{ ok: true }>(`/${id}`, { method: 'DELETE' }) }
export function addYtPlaylistVideo(id: string, v: {
  videoId: string; title: string; author?: string; channelId?: string; durationSec?: number | null
  videoSource?: PlaylistVideoSource; thumbnailUrl?: string | null
}) {
  return yfetch<{ ok: true }>(`/${id}/videos`, { method: 'POST', headers: J, body: body(v) })
}
export function removeYtPlaylistVideo(id: string, rowId: string) {
  return yfetch<{ ok: true }>(`/${id}/videos/${rowId}`, { method: 'DELETE' })
}
export function reorderYtPlaylist(id: string, videoIds: string[]) {
  return yfetch<{ ok: true }>(`/${id}/videos/order`, { method: 'PUT', headers: J, body: body({ videoIds }) })
}
export function shareYtPlaylist(id: string, shared: boolean) {
  return yfetch<{ visibility: YtVisibility }>(`/${id}/share`, { method: 'POST', headers: J, body: body({ shared }) })
}
export function cloneYtPlaylist(id: string) {
  return yfetch<{ playlist: YtPlaylist }>(`/${id}/clone`, { method: 'POST' })
}

export interface YtPlaylistBatchVideoStatus {
  videoId: string; title: string
  status: 'pending' | 'downloading' | 'ready' | 'failed' | 'not-started'
}
export interface YtPlaylistBatchStatus {
  batchId: string; label: string; kind: 'audio' | 'video'; createdAt: number
  total: number; ready: number; downloading: number; pending: number; failed: number
  videos: YtPlaylistBatchVideoStatus[]
}

export function startYtPlaylistDownload(id: string, b: { kind: 'audio' | 'video'; maxHeight?: number | null }) {
  return yfetch<{ batchId: string; videoCount: number }>(`/${id}/download`, { method: 'POST', headers: J, body: body(b) })
}
export function getYtPlaylistDownloadStatus(id: string, batchId: string) {
  return yfetch<YtPlaylistBatchStatus>(`/${id}/download/${batchId}`)
}
