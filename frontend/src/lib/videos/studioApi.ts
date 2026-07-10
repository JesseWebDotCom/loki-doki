// API client for the Create studio (/api/videos/studio/*).

import type { StudioEdl } from '@/components/videostudio/edl'

export interface StudioProjectSummary {
  id: string
  name: string
  durationSec: number
  createdAt: string
  updatedAt: string
}

export interface StudioProject extends StudioProjectSummary {
  edl: StudioEdl
}

export interface StudioBinItem {
  assetId: string
  title: string
  kind: 'video' | 'audio' | 'image'
  durationSec: number | null
  origin: string
  thumbUrl: string | null
  createdAt: number
  /** Studio-owned items only: the studio_media row id (share toggle target). */
  mediaId?: string
  /** Studio-owned videos only: epoch ms when shared with the household, null = private. */
  sharedAt?: number | null
  /** Source container format (e.g. 'mp4', 'webm'), when known. Drives format-aware export. */
  format?: string | null
  /** User-set description; null/absent when unset. */
  description?: string | null
}

// The bin also holds source clips pulled in from other providers as raw editing material —
// those aren't "yours," they're someone else's video you're editing with. This is what
// "Mine" means everywhere outside the Studio itself: exports, uploads, recordings, and AI
// generations (and, later, videos shared with you by family). Named list (not every
// non-source origin) so a future origin defaults to excluded, not silently included.
const MINE_ORIGINS = new Set(['export', 'upload', 'recording', 'generated'])
export const isMineBinItem = (i: StudioBinItem): boolean => i.kind === 'video' && MINE_ORIGINS.has(i.origin)

export interface StudioExportStatus {
  export: { id: string; status: 'pending' | 'processing' | 'ready' | 'failed'; error: string | null; assetId: string | null; title: string }
  progress: { completed?: number; total?: number; note?: string } | null
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'include' })
  const data = await res.json().catch(() => null) as (T & { error?: string }) | null
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? `${path} → ${res.status}`)
  return data as T
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

export const listStudioProjects = () => getJson<{ projects: StudioProjectSummary[] }>('/api/videos/studio/projects')
export const createStudioProject = (name?: string) => sendJson<{ ok: true; id: string }>('/api/videos/studio/projects', 'POST', { name })
export const getStudioProject = (id: string) => getJson<{ project: StudioProject }>(`/api/videos/studio/projects/${encodeURIComponent(id)}`)
export const saveStudioProject = (id: string, patch: { name?: string; edl?: StudioEdl }) =>
  sendJson<{ ok: true }>(`/api/videos/studio/projects/${encodeURIComponent(id)}`, 'PUT', patch)
export const deleteStudioProject = (id: string) => sendJson<{ ok: true }>(`/api/videos/studio/projects/${encodeURIComponent(id)}`, 'DELETE')

export const listStudioBin = () => getJson<{ items: StudioBinItem[] }>('/api/videos/studio/media')
/** Share/unshare a Studio-owned video with the household (other members' My Videos Plex libraries). */
export const setStudioMediaShared = (mediaId: string, shared: boolean) =>
  sendJson<{ ok: true; sharedAt: number | null }>(`/api/videos/studio/media/${encodeURIComponent(mediaId)}`, 'PATCH', { shared })
export const studioStreamUrl = (assetId: string) => `/api/videos/studio/media/${encodeURIComponent(assetId)}/stream`
export const studioThumbUrl = (assetId: string) => `/api/videos/studio/media/${encodeURIComponent(assetId)}/thumb`

export async function uploadStudioMedia(file: File): Promise<{ ok: true; id: string }> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/videos/studio/media/upload', { method: 'POST', credentials: 'include', body: form })
  const data = await res.json().catch(() => null) as { ok?: true; id?: string; error?: string } | null
  if (!res.ok || !data?.id) throw new Error(data?.error ?? 'upload failed')
  return { ok: true, id: data.id }
}

/** Convert a Mine video to another format (animated webp / gif / a video container) via the
 *  shared converter. Returns converter ids; poll /api/converter/stream/:jobId and download
 *  from /api/converter/artifacts/:conversionId (see lib/converter/api). */
export const exportBinItemAs = (assetId: string, format: string, name: string) =>
  sendJson<{ conversionId: string; jobId: string }>(
    `/api/videos/studio/media/${encodeURIComponent(assetId)}/export-as`, 'POST', { format, name })

/** Rename / describe a Mine item. Generated clips (origin 'generated') live in the image
 *  store; everything else studio-owned lives in studio_media, so route accordingly. */
export const updateBinItemMeta = (item: StudioBinItem, meta: { title?: string; description?: string }) =>
  item.origin === 'generated'
    ? sendJson<{ ok: true }>(`/api/image/artifacts/${encodeURIComponent(item.assetId)}/meta`, 'PATCH', meta)
    : sendJson<{ ok: true }>(`/api/videos/studio/media/${encodeURIComponent(item.mediaId ?? '')}`, 'PATCH', meta)

/** Delete a Mine item (generated clip or studio-owned upload/export/recording). */
export const deleteBinItem = (item: StudioBinItem) =>
  item.origin === 'generated'
    ? sendJson<{ ok: true }>(`/api/image/artifacts/${encodeURIComponent(item.assetId)}`, 'DELETE')
    : sendJson<{ ok: true }>(`/api/videos/studio/media/${encodeURIComponent(item.mediaId ?? '')}`, 'DELETE')

export const startStudioExport = (projectId: string, preset: string) =>
  sendJson<{ ok: true; exportId: string }>(`/api/videos/studio/projects/${encodeURIComponent(projectId)}/export`, 'POST', { preset })
export const getStudioExport = (exportId: string) =>
  getJson<StudioExportStatus>(`/api/videos/studio/exports/${encodeURIComponent(exportId)}`)
