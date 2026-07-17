// Client for the Music portability endpoints: scrobbling out (ListenBrainz), playlist
// import, and the all-time stats explorer.

const J = { 'Content-Type': 'application/json' }
const opts: RequestInit = { credentials: 'include' }

async function jsonOrError<T>(r: Response, fallback: string): Promise<T> {
  const d = await r.json().catch(() => null) as (T & { error?: string }) | null
  if (!r.ok) throw new Error(d?.error || fallback)
  return d as T
}

// ── Scrobbling ──────────────────────────────────────────────────────────────────────

export interface ScrobbleSettings {
  enabled: boolean
  tokenSet: boolean
  tokenHint: string | null
  queue: { pending: number; failed: number; lastError: string | null }
}

export async function getScrobbleSettings(): Promise<ScrobbleSettings> {
  return jsonOrError(await fetch('/api/music/scrobble/settings', opts), 'Could not load scrobble settings')
}

export async function saveScrobbleSettings(patch: { token?: string | null; enabled?: boolean }): Promise<{ listenBrainzUser?: string }> {
  return jsonOrError(
    await fetch('/api/music/scrobble/settings', { ...opts, method: 'PUT', headers: J, body: JSON.stringify(patch) }),
    'Could not save scrobble settings',
  )
}

export async function backfillScrobbles(): Promise<{ queued: number }> {
  return jsonOrError(await fetch('/api/music/scrobble/backfill', { ...opts, method: 'POST' }), 'Could not start the backfill')
}

export async function retryFailedScrobbles(): Promise<void> {
  await jsonOrError(await fetch('/api/music/scrobble/retry-failed', { ...opts, method: 'POST' }), 'Could not retry')
}

// ── Playlist import ─────────────────────────────────────────────────────────────────

export interface ImportEntry { title: string; artist: string; durationSec?: number | null }

export interface ResolvedImportEntry {
  index: number
  status: 'matched' | 'ambiguous' | 'unmatched'
  track: { videoId: string; title: string; artist: string; durationSec: number | null } | null
  score: number | null
  source: 'local' | 'plex' | 'youtube' | null
}

export async function resolveImportEntries(entries: ImportEntry[]): Promise<ResolvedImportEntry[]> {
  const d = await jsonOrError<{ results: ResolvedImportEntry[] }>(
    await fetch('/api/music/import/resolve', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ entries }) }),
    'Could not resolve the track list',
  )
  return d.results
}

export async function createImportedPlaylist(name: string, tracks: Array<{
  videoId: string; title: string; artist?: string | null; durationSec?: number | null
}>): Promise<{ id: string; name: string; trackCount: number }> {
  const d = await jsonOrError<{ playlist: { id: string; name: string; trackCount: number } }>(
    await fetch('/api/music/import/create', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ name, tracks }) }),
    'Could not create the playlist',
  )
  return d.playlist
}

// ── Stats ───────────────────────────────────────────────────────────────────────────

export interface MusicStatsOverview {
  totals: { plays: number; minutes: number; distinctTracks: number; distinctArtists: number; firstPlayAtMs: number | null }
  years: Array<{ year: number; plays: number; minutes: number }>
  monthsYear: number
  months: Array<{ month: number; plays: number; minutes: number }>
}

export interface TopArtistRow { artist: string; plays: number; minutes: number; lastPlayedAtMs: number }
export interface TopTrackRow { videoId: string; title: string; artist: string; plays: number; minutes: number; lastPlayedAtMs: number }

export async function getMusicStatsOverview(year?: number): Promise<MusicStatsOverview> {
  return jsonOrError(await fetch(`/api/music/stats/overview${year ? `?year=${year}` : ''}`, opts), 'Could not load stats')
}

export async function getTopArtists(params: { q?: string; year?: number | null; limit?: number } = {}): Promise<TopArtistRow[]> {
  const qs = new URLSearchParams({ kind: 'artists' })
  if (params.q) qs.set('q', params.q)
  if (params.year) qs.set('year', String(params.year))
  if (params.limit) qs.set('limit', String(params.limit))
  const d = await jsonOrError<{ rows: TopArtistRow[] }>(await fetch(`/api/music/stats/top?${qs}`, opts), 'Could not load top artists')
  return d.rows
}

export async function getTopTracks(params: { q?: string; year?: number | null; limit?: number } = {}): Promise<TopTrackRow[]> {
  const qs = new URLSearchParams({ kind: 'tracks' })
  if (params.q) qs.set('q', params.q)
  if (params.year) qs.set('year', String(params.year))
  if (params.limit) qs.set('limit', String(params.limit))
  const d = await jsonOrError<{ rows: TopTrackRow[] }>(await fetch(`/api/music/stats/top?${qs}`, opts), 'Could not load top tracks')
  return d.rows
}
