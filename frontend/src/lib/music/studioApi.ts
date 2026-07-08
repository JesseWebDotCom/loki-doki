// Music Studio API client. Plain fetch + credentials, mirroring lib/music/api.ts.

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }

export interface StudioBeat { time: number; downbeat?: boolean }
export interface StudioChord { startTime: number; endTime: number; label: string }
export interface StudioStem { name: string; url: string }

export type AnalysisStatus = 'none' | 'pending' | 'analyzing' | 'ready' | 'failed'
export type StemStatus = 'none' | 'pending' | 'separating' | 'ready' | 'failed'
export type SourceStatus = 'ready' | 'fetching' | 'failed'
export type StemModel = '2-stem' | '4-stem' | '6-stem'

export interface StudioTrack {
  id: string
  title: string
  artist: string | null
  durationSec: number | null
  sourceStatus: SourceStatus
  sourceError: string | null
  analysisStatus: AnalysisStatus
  analysisError: string | null
  bpm: number | null
  keyLabel: string | null
  beats: StudioBeat[]
  chords: StudioChord[]
  stemStatus: StemStatus
  stemModel: StemModel | null
  stemError: string | null
  stems: StudioStem[]
  coverUrl: string | null
  createdAt: number
  updatedAt: number
  // Live percent for the in-flight job (only present on the single-track GET).
  stemProgress?: { pct: number; note?: string } | null
  sourceProgress?: { pct: number; note?: string } | null
}

export async function listStudioTracks(): Promise<{ installed: boolean; guitarEnhanced?: boolean; tracks: StudioTrack[] }> {
  const r = await fetch('/api/music/studio', opts)
  if (!r.ok) throw new Error('list')
  return await r.json() as { installed: boolean; guitarEnhanced?: boolean; tracks: StudioTrack[] }
}

export async function getStudioTrack(id: string): Promise<{ installed: boolean; guitarEnhanced?: boolean; track: StudioTrack }> {
  const r = await fetch(`/api/music/studio/${id}`, opts)
  if (!r.ok) throw new Error('get')
  return await r.json() as { installed: boolean; guitarEnhanced?: boolean; track: StudioTrack }
}

export async function uploadStudioTrack(file: File, meta: { title?: string; artist?: string } = {}): Promise<string> {
  const fd = new FormData()
  fd.append('audio', file, file.name)
  if (meta.title) fd.append('title', meta.title)
  if (meta.artist) fd.append('artist', meta.artist)
  const r = await fetch('/api/music/studio/upload', { ...opts, method: 'POST', body: fd })
  if (!r.ok) throw new Error((await r.json().catch(() => ({})) as { error?: string }).error ?? 'upload')
  return (await r.json() as { id: string }).id
}

export async function createStudioFromCatalog(pick: { mbid?: string; videoId?: string; albumMbid?: string | null; albumTitle?: string | null; title: string; artist?: string; durationSec?: number | null }): Promise<string> {
  const r = await fetch('/api/music/studio/from-catalog', { ...opts, method: 'POST', headers: J, body: JSON.stringify(pick) })
  if (!r.ok) throw new Error((await r.json().catch(() => ({})) as { error?: string }).error ?? 'add')
  return (await r.json() as { id: string }).id
}

export async function reanalyzeStudioTrack(id: string): Promise<void> {
  const r = await fetch(`/api/music/studio/${id}/analyze`, { ...opts, method: 'POST' })
  if (!r.ok) throw new Error('analyze')
}

export type CustomStem = 'vocals' | 'drums' | 'bass' | 'guitar' | 'piano' | 'other'

export async function generateStems(id: string, req: { model?: StemModel; stems?: CustomStem[]; enhancedGuitar?: boolean }): Promise<void> {
  const r = await fetch(`/api/music/studio/${id}/stems`, { ...opts, method: 'POST', headers: J, body: JSON.stringify(req) })
  if (!r.ok) throw new Error('stems')
}

export async function deleteStudioTrack(id: string): Promise<void> {
  const r = await fetch(`/api/music/studio/${id}`, { ...opts, method: 'DELETE' })
  if (!r.ok) throw new Error('delete')
}
