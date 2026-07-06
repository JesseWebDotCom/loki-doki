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
}

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

export const startStudioExport = (projectId: string, preset: string) =>
  sendJson<{ ok: true; exportId: string }>(`/api/videos/studio/projects/${encodeURIComponent(projectId)}/export`, 'POST', { preset })
export const getStudioExport = (exportId: string) =>
  getJson<StudioExportStatus>(`/api/videos/studio/exports/${encodeURIComponent(exportId)}`)
