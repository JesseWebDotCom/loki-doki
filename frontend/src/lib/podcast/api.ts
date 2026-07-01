import type { PodcastTrack } from '@/context/PodcastPlaybackContext'

// ── Types ──────────────────────────────────────────────────────────────────────

export type PodcastStyle = 'recap' | 'in-depth' | 'roundtable' | 'interview' | 'briefing' | 'story'

export interface ShowHost { characterId: string; role: string }
export interface ShowSegment { type: string; label?: string; params?: Record<string, unknown> }

export interface Show {
  id: string
  ownerUserId: string
  name: string
  description?: string | null
  coverRelPath?: string | null
  style: PodcastStyle
  hosts: ShowHost[]
  segments: ShowSegment[]
  visibility: 'personal' | 'shared'
  source: 'user' | 'suggested' | 'app'
  sourceRef?: string | null
  autoGenerate?: boolean
  targetMinutes?: number | null
  ownerName: string
  isOwn: boolean
  createdAt: string | number
}

export interface Episode {
  id: string
  showId: string
  title: string
  description?: string | null
  audioRelPath?: string | null
  durationSec?: number | null
  chapters: { title: string; startSec: number }[]
  status: 'pending' | 'generating' | 'ready' | 'failed'
  error?: string | null
  generatedAt?: string | number | null
  createdAt?: string | number | null
  watchState?: { positionSec: number; completed: boolean } | null
}

export interface EpisodeSource {
  sourceType: 'youtube' | 'tvshow' | 'movie'
  sourceId: string
  title: string | null
}

export interface EpisodeDetail extends Episode {
  transcript: { speaker: string; text: string }[]
  sources: EpisodeSource[]
}

export interface Suggestion {
  id: string
  templateKey: string
  title: string
  description?: string | null
  style: string
  segments: ShowSegment[]
}

export interface HostCharacter { id: string; name: string; avatarRef?: string | null }

// ── Endpoints ──────────────────────────────────────────────────────────────────

const J = { 'Content-Type': 'application/json' }
const opts: RequestInit = { credentials: 'include' }

export const coverUrl = (showId: string) => `/api/podcasts/shows/${showId}/cover`

export async function getShows(): Promise<Show[]> {
  const r = await fetch('/api/podcasts/shows', opts)
  if (!r.ok) throw new Error('shows')
  return (await r.json() as { shows: Show[] }).shows ?? []
}

export async function getEpisodes(showId: string): Promise<Episode[]> {
  const r = await fetch(`/api/podcasts/shows/${showId}/episodes`, opts)
  if (!r.ok) throw new Error('episodes')
  return (await r.json() as { episodes: Episode[] }).episodes ?? []
}

// Shows + their episodes in one request (replaces getShows + per-show getEpisodes).
export async function getFeed(): Promise<{ shows: Show[]; episodesByShow: Record<string, Episode[]> }> {
  const r = await fetch('/api/podcasts/feed', opts)
  if (!r.ok) throw new Error('feed')
  const d = await r.json() as { shows?: Show[]; episodesByShow?: Record<string, Episode[]> }
  return { shows: d.shows ?? [], episodesByShow: d.episodesByShow ?? {} }
}

export async function getEpisodeDetail(episodeId: string): Promise<EpisodeDetail> {
  const r = await fetch(`/api/podcasts/episodes/${episodeId}`, opts)
  if (!r.ok) throw new Error('episode')
  return (await r.json() as { episode: EpisodeDetail }).episode
}

export interface ShowInput {
  name: string
  description?: string | null
  style?: PodcastStyle
  hosts?: ShowHost[]
  segments?: ShowSegment[]
  visibility?: 'personal' | 'shared'
  sourceRef?: string
  autoGenerate?: boolean
  targetMinutes?: number | null
}

export async function createShow(input: ShowInput): Promise<Show> {
  const r = await fetch('/api/podcasts/shows', { ...opts, method: 'POST', headers: J, body: JSON.stringify(input) })
  if (!r.ok) throw new Error('create')
  return (await r.json() as { show: Show }).show
}

export async function updateShow(id: string, input: Partial<ShowInput>): Promise<void> {
  const r = await fetch(`/api/podcasts/shows/${id}`, { ...opts, method: 'PUT', headers: J, body: JSON.stringify(input) })
  if (!r.ok) throw new Error('update')
}

export async function deleteShow(id: string): Promise<void> {
  await fetch(`/api/podcasts/shows/${id}`, { ...opts, method: 'DELETE' })
}

export async function generateEpisode(showId: string): Promise<{ episodeId: string }> {
  const r = await fetch(`/api/podcasts/shows/${showId}/generate`, { ...opts, method: 'POST' })
  if (!r.ok) throw new Error('generate')
  return r.json() as Promise<{ episodeId: string }>
}

export async function regenerateEpisode(episodeId: string): Promise<void> {
  const r = await fetch(`/api/podcasts/episodes/${episodeId}/regenerate`, { ...opts, method: 'POST' })
  if (!r.ok) throw new Error('regenerate')
}

export async function deleteEpisode(episodeId: string): Promise<void> {
  const r = await fetch(`/api/podcasts/episodes/${episodeId}`, { ...opts, method: 'DELETE' })
  if (!r.ok) throw new Error('delete-episode')
}

export async function saveCover(showId: string, png: Blob): Promise<void> {
  const r = await fetch(`/api/podcasts/shows/${showId}/cover`, {
    ...opts, method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: png,
  })
  if (!r.ok) throw new Error('cover')
}

/** Ask the model to write a show description from the selection. Throws on failure
 *  (offline / model missing) so the caller can fall back to a local template. */
export async function generateShowDescription(input: {
  hosts?: string[]
  showName?: string
  sourceName?: string
  sourceKind?: 'channel' | 'playlist'
  sourceDescription?: string
  style?: string
  sampleTitles?: string[]
}): Promise<string> {
  const r = await fetch('/api/podcasts/describe', { ...opts, method: 'POST', headers: J, body: JSON.stringify(input) })
  if (!r.ok) throw new Error('describe')
  const d = await r.json() as { description?: string }
  if (!d.description) throw new Error('empty')
  return d.description
}

export const stingerUrl = (showId: string, part: 'intro' | 'outro') =>
  `/api/podcasts/shows/${showId}/stinger/${part}`

/** Upload a show's intro + outro stinger clips (24 kHz mono WAV). */
export async function saveStinger(showId: string, intro: Blob, outro: Blob): Promise<void> {
  const fd = new FormData()
  fd.append('intro', intro, 'intro.wav')
  fd.append('outro', outro, 'outro.wav')
  const r = await fetch(`/api/podcasts/shows/${showId}/stinger`, { ...opts, method: 'PUT', body: fd })
  if (!r.ok) throw new Error('stinger')
}

export async function getSuggestions(): Promise<Suggestion[]> {
  const r = await fetch('/api/podcasts/suggestions', opts)
  if (!r.ok) throw new Error('suggestions')
  return (await r.json() as { suggestions: Suggestion[] }).suggestions ?? []
}

export async function acceptSuggestion(id: string): Promise<void> {
  await fetch(`/api/podcasts/suggestions/${id}/accept`, { ...opts, method: 'POST' })
}
export async function dismissSuggestion(id: string): Promise<void> {
  await fetch(`/api/podcasts/suggestions/${id}/dismiss`, { ...opts, method: 'POST' })
}

export async function getHostCharacters(): Promise<HostCharacter[]> {
  const r = await fetch('/api/companions', opts)
  if (!r.ok) return []
  const data = await r.json() as { companions?: HostCharacter[] } | HostCharacter[]
  return Array.isArray(data) ? data : (data.companions ?? [])
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Build a playback track from an episode + its show. */
export function toTrack(ep: Episode, show: Pick<Show, 'id' | 'name'>, extra?: Partial<PodcastTrack>): PodcastTrack {
  return {
    episodeId: ep.id,
    showId: show.id,
    showName: show.name,
    title: ep.title,
    description: ep.description ?? undefined,
    durationSec: ep.durationSec ?? undefined,
    chapters: ep.chapters,
    coverUrl: coverUrl(show.id),
    ...extra,
  }
}
