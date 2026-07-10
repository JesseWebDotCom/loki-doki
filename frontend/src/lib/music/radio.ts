export interface RadioStation {
  id: string
  name: string
  url: string
  favicon: string | null
  tags: string
  country: string
  language: string
  codec: string
  bitrate: number
  votes: number
}

export interface RadioGenre {
  id: string
  label: string
}

export async function searchStations(params: {
  genre?: string
  name?: string
  country?: string
  limit?: number
}): Promise<RadioStation[]> {
  const qs = new URLSearchParams()
  if (params.genre) qs.set('genre', params.genre)
  if (params.name) qs.set('name', params.name)
  if (params.country) qs.set('country', params.country)
  if (params.limit) qs.set('limit', String(params.limit))
  const res = await fetch(`/api/music/radio/stations?${qs}`, { credentials: 'include' })
  if (!res.ok) throw new Error('Failed to fetch stations')
  const data = await res.json() as { stations: RadioStation[] }
  return data.stations
}

export async function fetchGenres(): Promise<RadioGenre[]> {
  const res = await fetch('/api/music/radio/genres', { credentials: 'include' })
  if (!res.ok) return []
  const data = await res.json() as { genres: RadioGenre[] }
  return data.genres
}

export interface RadioQueueTrack { videoId: string; title: string; author: string | null }

/** Build a station queue from a YouTube Music radio mix (varied, genre-appropriate),
 *  falling back server-side to plain search. `source` is 'ytmusic' | 'search'. */
export async function fetchRadioQueue(q: string): Promise<{ tracks: RadioQueueTrack[]; source: string }> {
  try {
    const res = await fetch(`/api/music/radio/queue?q=${encodeURIComponent(q)}`, { credentials: 'include' })
    if (!res.ok) return { tracks: [], source: 'none' }
    const data = await res.json() as { tracks?: RadioQueueTrack[]; source?: string }
    return { tracks: data.tracks ?? [], source: data.source ?? 'none' }
  } catch { return { tracks: [], source: 'none' } }
}

/** Build a queue for an AI station (saved station id, or an inline prompt / artist-song seed)
 *  via the station engine. The backend returns ResolvedTrack[]; we map artist→author to match
 *  the radio engine's track shape. */
export async function fetchStationQueue(body: {
  stationId?: string
  aiPrompt?: string
  seedType?: 'prompt' | 'genre' | 'artist' | 'song'
  seedValue?: string
  seedVideoId?: string
  /** Plexamp-style personal station seeded by the listener's history/favorites. */
  personal?: 'library' | 'deep-cuts' | 'time-travel'
  name?: string
  count?: number
  excludeVideoIds?: string[]
  /** Fast first-track build: resolve just enough to start playing (caller fills the rest). */
  fast?: boolean
}): Promise<{ tracks: RadioQueueTrack[]; source: string }> {
  try {
    const res = await fetch('/api/music/stations/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    })
    if (!res.ok) return { tracks: [], source: 'none' }
    const data = await res.json() as { tracks?: Array<{ videoId: string; title: string; artist?: string | null }>; source?: string }
    return {
      tracks: (data.tracks ?? []).map(t => ({ videoId: t.videoId, title: t.title, author: t.artist ?? null })),
      source: data.source ?? 'none',
    }
  } catch { return { tracks: [], source: 'none' } }
}

export interface DjSegmentResult {
  text: string
  audio: string | null  // base64 WAV
  audioMime: string
}

export async function fetchDjSegment(params: {
  genre?: string
  stationName?: string
  sayStation?: boolean
  trackName?: string
  artistName?: string
  nextTrackName?: string
  nextArtistName?: string
  weather?: string
  newsHeadline?: string
  position?: 'intro' | 'transition' | 'outro'
  style?: 'full' | 'minimal'
}): Promise<DjSegmentResult | null> {
  try {
    const res = await fetch('/api/music/radio/dj-segment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(params),
    })
    if (!res.ok) return null
    return await res.json() as DjSegmentResult
  } catch {
    return null
  }
}

export function base64WavToBlob(b64: string, mime = 'audio/wav'): Blob {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}
