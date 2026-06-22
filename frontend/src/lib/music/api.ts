// Music app API client — track storage CRUD. Generation/remix happen client-side
// (see ./engine and ./remix); this only persists the finished WAV + metadata.

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }

export type TrackKind = 'track' | 'intro' | 'outro' | 'loop' | 'bed'

export interface MusicTrack {
  id: string
  title: string
  kind: TrackKind
  engine: string
  styleId: string | null
  bpm: number | null
  keyName: string | null
  sourceName: string | null
  durationSec: number | null
  state: 'building' | 'ready' | 'failed' | 'cancelled'
  createdAt: number
}

export const trackAudioUrl = (id: string) => `/api/music/tracks/${id}/audio`

export interface SaveTrackMeta {
  title: string
  kind?: TrackKind
  engine?: string
  styleId?: string | null
  bpm?: number | null
  keyName?: string | null
  sourceName?: string | null
  prompt?: string | null
  durationSec?: number | null
}

export async function saveTrack(blob: Blob, meta: SaveTrackMeta): Promise<string> {
  const fd = new FormData()
  fd.append('audio', blob, 'main.wav')
  fd.append('title', meta.title)
  if (meta.kind) fd.append('kind', meta.kind)
  if (meta.engine) fd.append('engine', meta.engine)
  if (meta.styleId) fd.append('styleId', meta.styleId)
  if (meta.bpm != null) fd.append('bpm', String(Math.round(meta.bpm)))
  if (meta.keyName) fd.append('keyName', meta.keyName)
  if (meta.sourceName) fd.append('sourceName', meta.sourceName)
  if (meta.prompt) fd.append('prompt', meta.prompt)
  if (meta.durationSec != null) fd.append('durationSec', String(meta.durationSec))
  const r = await fetch('/api/music/tracks', { ...opts, method: 'POST', body: fd })
  if (!r.ok) throw new Error('save')
  return (await r.json() as { id: string }).id
}

export async function listTracks(kind?: TrackKind): Promise<MusicTrack[]> {
  const q = kind ? `?kind=${encodeURIComponent(kind)}` : ''
  const r = await fetch(`/api/music/tracks${q}`, opts)
  if (!r.ok) throw new Error('list')
  return (await r.json() as { tracks: MusicTrack[] }).tracks ?? []
}

export async function renameTrack(id: string, title: string): Promise<void> {
  const r = await fetch(`/api/music/tracks/${id}`, { ...opts, method: 'PATCH', headers: J, body: JSON.stringify({ title }) })
  if (!r.ok) throw new Error('rename')
}

export async function deleteTrack(id: string): Promise<void> {
  const r = await fetch(`/api/music/tracks/${id}`, { ...opts, method: 'DELETE' })
  if (!r.ok) throw new Error('delete')
}

/** Fetch a stored track's audio as a Blob (used when reusing a Library track as a
 *  podcast intro/outro). */
export async function fetchTrackBlob(id: string): Promise<Blob> {
  const r = await fetch(trackAudioUrl(id), opts)
  if (!r.ok) throw new Error('fetch-blob')
  return r.blob()
}
