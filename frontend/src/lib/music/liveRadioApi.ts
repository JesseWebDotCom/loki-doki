// Live internet radio API — radio-browser search proxy, the saved-station library,
// and timed recordings. All under /api/music/radio(/live), cookie-authed.

/** A radio-browser search result (id = stationuuid). */
export interface LiveSearchStation {
  id: string
  name: string
  url: string
  homepage: string | null
  favicon: string | null
  tags: string
  country: string
  language: string
  codec: string
  bitrate: number
  votes: number
  hls: boolean
}

/** A station saved to the user's library. */
export interface LiveLibraryStation {
  id: string
  userId: string
  source: 'radio-browser' | 'manual'
  stationUuid: string | null
  name: string
  streamUrl: string
  homepage: string | null
  favicon: string | null
  tags: string | null
  country: string | null
  language: string | null
  codec: string | null
  bitrate: number | null
  createdAt: string
}

export type LiveRecordingStatus = 'pending' | 'recording' | 'ready' | 'failed'

export interface LiveRecording {
  id: string
  stationId: string
  stationName: string | null
  title: string
  requestedSec: number
  durationSec: number | null
  relPath: string | null
  sizeBytes: number | null
  status: LiveRecordingStatus
  error: string | null
  createdAt: string
}

export interface LiveGenre { id: string; label: string }

/** Live audio proxy for a saved station row id, or 'rb:<stationuuid>' to preview a search
 *  result before adding. Infinite same-origin stream, no Range. */
export function liveStreamUrl(key: string): string {
  return `/api/music/radio/live/stream/${key}`
}

/** Seekable mp3 of a finished (or in-progress) recording. */
export function recordingAudioUrl(id: string): string {
  return `/api/music/radio/live/recordings/${id}/audio`
}

export async function searchLiveStations(params: {
  genre?: string
  name?: string
  country?: string
  limit?: number
}): Promise<LiveSearchStation[]> {
  const qs = new URLSearchParams()
  if (params.genre) qs.set('genre', params.genre)
  if (params.name) qs.set('name', params.name)
  if (params.country) qs.set('country', params.country)
  if (params.limit) qs.set('limit', String(params.limit))
  const res = await fetch(`/api/music/radio/stations?${qs}`, { credentials: 'include' })
  if (!res.ok) throw new Error('Failed to fetch stations')
  const data = await res.json() as { stations: LiveSearchStation[] }
  return data.stations
}

export async function fetchLiveGenres(): Promise<LiveGenre[]> {
  const res = await fetch('/api/music/radio/genres', { credentials: 'include' })
  if (!res.ok) return []
  const data = await res.json() as { genres: LiveGenre[] }
  return data.genres
}

export async function fetchLiveLibrary(): Promise<LiveLibraryStation[]> {
  const res = await fetch('/api/music/radio/live/library', { credentials: 'include' })
  if (!res.ok) throw new Error('Failed to fetch stations')
  const data = await res.json() as { stations: LiveLibraryStation[] }
  return data.stations
}

/** Save a radio-browser search result to the library. Throws with the server's message
 *  (e.g. an unreachable/invalid stream) on failure. */
export async function addLiveStation(station: LiveSearchStation): Promise<LiveLibraryStation> {
  const res = await fetch('/api/music/radio/live/library', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      source: 'radio-browser',
      station: {
        stationuuid: station.id, name: station.name, url: station.url,
        homepage: station.homepage, favicon: station.favicon, tags: station.tags,
        country: station.country, language: station.language,
        codec: station.codec, bitrate: station.bitrate,
      },
    }),
  })
  const data = await res.json() as { station?: LiveLibraryStation; error?: string }
  if (!res.ok || !data.station) throw new Error(data.error ?? 'Could not add station')
  return data.station
}

/** Save a manual stream URL. Throws with the server's message on an invalid stream. */
export async function addManualStation(body: { name: string; streamUrl: string }): Promise<LiveLibraryStation> {
  const res = await fetch('/api/music/radio/live/library', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ source: 'manual', ...body }),
  })
  const data = await res.json() as { station?: LiveLibraryStation; error?: string }
  if (!res.ok || !data.station) throw new Error(data.error ?? 'Could not add station')
  return data.station
}

export async function removeLiveStation(id: string): Promise<void> {
  const res = await fetch(`/api/music/radio/live/library/${id}`, { method: 'DELETE', credentials: 'include' })
  if (!res.ok) throw new Error('Could not remove station')
}

export async function startRecording(stationId: string, minutes: number): Promise<LiveRecording> {
  const res = await fetch('/api/music/radio/live/recordings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ stationId, minutes }),
  })
  const data = await res.json() as { recording?: LiveRecording; error?: string }
  if (!res.ok || !data.recording) throw new Error(data.error ?? 'Could not start recording')
  return data.recording
}

export async function listRecordings(): Promise<LiveRecording[]> {
  const res = await fetch('/api/music/radio/live/recordings', { credentials: 'include' })
  if (!res.ok) throw new Error('Failed to fetch recordings')
  const data = await res.json() as { recordings: LiveRecording[] }
  return data.recordings
}

/** Stop an in-progress recording early, keeping what was captured so far. */
export async function stopRecording(id: string): Promise<void> {
  const res = await fetch(`/api/music/radio/live/recordings/${id}/stop`, { method: 'POST', credentials: 'include' })
  if (!res.ok) throw new Error('Could not stop recording')
}

export async function deleteRecording(id: string): Promise<void> {
  const res = await fetch(`/api/music/radio/live/recordings/${id}`, { method: 'DELETE', credentials: 'include' })
  if (!res.ok) throw new Error('Could not delete recording')
}
