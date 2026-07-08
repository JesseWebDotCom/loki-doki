// Client for /api/music/collection - the owned-library index (local folders + uploads now,
// Plex music next phase). Tracks are identified by unified refs (`local:<id>`, …) that flow
// through the same videoId-shaped fields the rest of the music app already uses.

export interface CollectionTrack {
  ref: string
  source: 'local' | 'plex'
  title: string
  artist: string | null
  album: string | null
  albumArtist: string | null
  trackNo: number | null
  discNo: number | null
  year: number | null
  genre: string | null
  durationSec: number | null
  codec: string | null
  bitrate: number | null       // kbps
  sampleRate: number | null
  bitDepth: number | null
  browserPlayable: boolean
  artUrl: string | null
}

export interface CollectionArtist {
  name: string
  trackCount: number
  albumCount: number
  source: 'local' | 'plex'
  artUrl: string | null
}

export interface CollectionAlbum {
  album: string
  albumArtist: string
  year: number | null
  trackCount: number
  durationSec: number
  source: 'local' | 'plex'
  artUrl: string | null
}

export interface CollectionSummary {
  local: { tracks: number; artists: number; albums: number }
  plex: { tracks: number; artists: number; albums: number }
  total: number
}

async function cfetch<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/music/collection${path}`, { credentials: 'include', ...init })
  if (!r.ok) throw new Error(`collection ${path} → ${r.status}`)
  return r.json() as Promise<T>
}

export const getCollectionSummary = () => cfetch<CollectionSummary>('/summary')

export const getCollectionArtists = (opts?: { q?: string; letter?: string }) => {
  const p = new URLSearchParams()
  if (opts?.q) p.set('q', opts.q)
  if (opts?.letter) p.set('letter', opts.letter)
  return cfetch<{ artists: CollectionArtist[] }>(`/artists?${p}`)
}

export const getCollectionAlbums = (opts?: { artist?: string; q?: string }) => {
  const p = new URLSearchParams()
  if (opts?.artist) p.set('artist', opts.artist)
  if (opts?.q) p.set('q', opts.q)
  return cfetch<{ albums: CollectionAlbum[] }>(`/albums?${p}`)
}

export const getCollectionAlbum = (albumArtist: string, album: string) =>
  cfetch<{ tracks: CollectionTrack[] }>(`/album?artist=${encodeURIComponent(albumArtist)}&album=${encodeURIComponent(album)}`)

export const getCollectionSongs = (opts?: { q?: string; artist?: string; limit?: number; offset?: number }) => {
  const p = new URLSearchParams()
  if (opts?.q) p.set('q', opts.q)
  if (opts?.artist) p.set('artist', opts.artist)
  if (opts?.limit) p.set('limit', String(opts.limit))
  if (opts?.offset) p.set('offset', String(opts.offset))
  return cfetch<{ songs: CollectionTrack[] }>(`/songs?${p}`)
}

export async function uploadCollectionFile(file: File): Promise<CollectionTrack | null> {
  const form = new FormData()
  form.append('audio', file)
  const r = await fetch('/api/music/collection/upload', { method: 'POST', credentials: 'include', body: form })
  const body = await r.json().catch(() => ({})) as { track?: CollectionTrack | null; error?: string }
  if (!r.ok) throw new Error(body.error ?? `Upload failed (${r.status})`)
  return body.track ?? null
}
