import type { PodcastTrack } from '@/context/PodcastPlaybackContext'

// ── Types ──────────────────────────────────────────────────────────────────────

export type PodcastStyle = 'recap' | 'in-depth' | 'roundtable' | 'interview' | 'briefing' | 'story'

export interface ShowHost { characterId: string; role: string }
export interface ShowSegment { type: string; label?: string; params?: Record<string, unknown> }

// ── Podcasting 2.0 tags (RSS shows) ────────────────────────────────────────────────
/** A <podcast:person> credit. `role` is null when the feed omitted it (the spec's
 *  default is "host"); the UI applies that default at render time. */
export interface PodcastPerson {
  name: string
  role: string | null
  group: string | null
  img: string | null
  href: string | null
}
/** A <podcast:funding> link: how listeners can support the show. */
export interface PodcastFunding { url: string; label: string | null }
/** A <podcast:soundbite>: a highlight clip within an episode, rendered as a seek. */
export interface PodcastSoundbite { startSec: number; durationSec: number; title: string | null }

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
  source: 'user' | 'suggested' | 'app' | 'rss'
  sourceRef?: string | null
  autoGenerate?: boolean
  targetMinutes?: number | null
  ownerName: string
  isOwn: boolean
  createdAt: string | number
  // RSS subscription shows only:
  feedUrl?: string | null
  artworkUrl?: string | null
  author?: string | null
  link?: string | null
  categories?: string[]
  feedError?: string | null
  /** Podcasting 2.0 channel tags: who makes the show, and how to support it. */
  persons?: PodcastPerson[]
  funding?: PodcastFunding[]
  /** This user's subscription prefs — null unless they subscribe to this show. */
  subscription?: { autoDownload: boolean; autoDownloadKeep: number | null } | null
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
  // RSS episodes only:
  guid?: string | null
  enclosureUrl?: string | null
  publishedAt?: string | number | null
  imageUrl?: string | null
  link?: string | null
  /** Podcasting 2.0 item tags: episode credits and highlight clips. */
  persons?: PodcastPerson[]
  soundbites?: PodcastSoundbite[]
  /** This user's offline copy state — null when not downloaded. */
  download?: { status: 'pending' | 'downloading' | 'ready' | 'failed'; auto: boolean } | null
  /** True when the episode carries a transcript, so study notes can be made from it. */
  hasScript?: boolean
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

/** A real podcast from the directory (iTunes / PodcastIndex). */
export interface DirectoryResult {
  itunesId: number | null
  title: string
  author: string | null
  feedUrl: string | null // null for chart rows — subscribe by itunesId instead
  artworkUrl: string | null
  genre: string | null
  episodeCount: number | null
}

export interface DirectoryGenre { id: number; name: string }

export interface DirectoryCharts {
  results: DirectoryResult[]
  provider: 'itunes' | 'podcastindex'
  genres: DirectoryGenre[]
}

export interface Subscription {
  showId: string
  autoDownload: boolean
  autoDownloadKeep: number | null
  addedAt: string | number
  name: string
  feedUrl: string | null
  artworkUrl: string | null
  author: string | null
}

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
  /** Recurring generation, e.g. { cadence: 'daily', hour: 6 } (Household Daily preset). */
  schedule?: { cadence: 'daily'; hour?: number } | null
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

export interface StudyKit {
  summary: string[]
  flashcards: { q: string; a: string }[]
  keyPoints: { time: string; point: string }[]
}

/** Homework mode: build a study kit from the episode's transcript and save it as a note. */
export async function makeStudyKit(episodeId: string): Promise<{ noteId: string; kit: StudyKit }> {
  const r = await fetch(`/api/podcasts/episodes/${episodeId}/study-kit`, { ...opts, method: 'POST' })
  const data = await r.json().catch(() => null) as { noteId?: string; kit?: StudyKit; error?: string } | null
  if (!r.ok || !data?.noteId || !data.kit) throw new Error(data?.error ?? 'Could not make study notes')
  return { noteId: data.noteId, kit: data.kit }
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

// ── Real podcast subscriptions (RSS) ───────────────────────────────────────────

/** Parse the body and throw the server's error message when the request failed. */
async function jsonOrError<T>(r: Response, fallback: string): Promise<T> {
  const d = await r.json().catch(() => null) as (T & { error?: string }) | null
  if (!r.ok) throw new Error(d?.error || fallback)
  return d as T
}

export interface DirectoryPreview {
  feedUrl: string
  title: string | null
  author: string | null
  description: string | null
  imageUrl: string | null
  link: string | null
  categories: string[]
  episodeCount: number
  episodes: Array<{ title: string; description: string | null; durationSec: number | null; publishedAt: number | null }>
}

/** Pre-subscribe show details (description, categories, recent episodes) straight from
 *  the feed — what a directory card opens into before any commitment. */
export async function previewDirectory(input: { feedUrl?: string | null; itunesId?: number | null }): Promise<DirectoryPreview> {
  const params = new URLSearchParams()
  if (input.feedUrl) params.set('feedUrl', input.feedUrl)
  else if (input.itunesId) params.set('itunesId', String(input.itunesId))
  const r = await fetch(`/api/podcasts/directory/preview?${params}`, opts)
  const d = await jsonOrError<{ preview?: DirectoryPreview }>(r, 'Could not load show details.')
  if (!d.preview) throw new Error('Could not load show details.')
  return d.preview
}

export async function searchDirectory(q: string, limit = 25): Promise<DirectoryResult[]> {
  const r = await fetch(`/api/podcasts/directory/search?q=${encodeURIComponent(q)}&limit=${limit}`, opts)
  if (!r.ok) throw new Error('directory-search')
  return (await r.json() as { results: DirectoryResult[] }).results ?? []
}

/** "Suggested for you" from the interest engine: real directory shows matched to your
 *  listening. `ref` is the dismiss key; `building` = first pool build still running
 *  (callers poll until it flips false). */
export async function getSuggestedPodcasts(): Promise<{ items: Array<DirectoryResult & { ref: string }>; building: boolean }> {
  const r = await fetch('/api/podcasts/suggested', opts)
  if (!r.ok) throw new Error('podcasts-suggested')
  const d = await r.json() as { items?: Array<DirectoryResult & { ref: string }>; building?: boolean }
  return { items: d.items ?? [], building: d.building === true }
}

/** Top charts, optionally per Apple genre id. Also carries the genre list for chips. */
export async function getCharts(genreId?: number | null): Promise<DirectoryCharts> {
  const r = await fetch(`/api/podcasts/directory/charts${genreId ? `?genre=${genreId}` : ''}`, opts)
  if (!r.ok) throw new Error('directory-charts')
  const d = await r.json() as Partial<DirectoryCharts>
  return { results: d.results ?? [], provider: d.provider ?? 'itunes', genres: d.genres ?? [] }
}

export interface SubscribeInput {
  feedUrl?: string
  itunesId?: number
  seed?: { title?: string; artworkUrl?: string; author?: string; genre?: string }
}

export async function subscribePodcast(input: SubscribeInput): Promise<Show> {
  const r = await fetch('/api/podcasts/subscriptions', { ...opts, method: 'POST', headers: J, body: JSON.stringify(input) })
  const d = await jsonOrError<{ show?: Show }>(r, 'Could not subscribe to this podcast.')
  if (!d.show) throw new Error('Could not subscribe to this podcast.')
  return d.show
}

export async function getSubscriptions(): Promise<Subscription[]> {
  const r = await fetch('/api/podcasts/subscriptions', opts)
  if (!r.ok) throw new Error('subscriptions')
  return (await r.json() as { subscriptions: Subscription[] }).subscriptions ?? []
}

export async function updateSubscription(showId: string, prefs: { autoDownload?: boolean; autoDownloadKeep?: number | null }): Promise<void> {
  const r = await fetch(`/api/podcasts/subscriptions/${showId}`, { ...opts, method: 'PUT', headers: J, body: JSON.stringify(prefs) })
  await jsonOrError(r, 'Could not update subscription.')
}

export async function unsubscribePodcast(showId: string): Promise<void> {
  const r = await fetch(`/api/podcasts/subscriptions/${showId}`, { ...opts, method: 'DELETE' })
  await jsonOrError(r, 'Could not unsubscribe.')
}

/** Re-poll the feed now. Resolves to the number of newly discovered episodes. */
export async function refreshSubscription(showId: string): Promise<number> {
  const r = await fetch(`/api/podcasts/subscriptions/${showId}/refresh`, { ...opts, method: 'POST' })
  const d = await jsonOrError<{ added?: number }>(r, 'Could not refresh the feed.')
  return d.added ?? 0
}

export async function downloadEpisode(episodeId: string): Promise<void> {
  const r = await fetch(`/api/podcasts/episodes/${episodeId}/download`, { ...opts, method: 'POST' })
  await jsonOrError(r, 'Could not download the episode.')
}

export async function removeEpisodeDownload(episodeId: string): Promise<void> {
  const r = await fetch(`/api/podcasts/episodes/${episodeId}/download`, { ...opts, method: 'DELETE' })
  await jsonOrError(r, 'Could not remove the download.')
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Loose feed-URL identity: the backend normalizes URLs on subscribe, so compare
 *  without protocol/trailing-slash noise. */
export function feedKey(url: string | null | undefined): string {
  if (!url) return ''
  return url.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

/** Find this user's subscription for a directory row. The feed URL is the identity;
 *  only chart rows (which omit it) fall back to a title+author match — and that
 *  fallback requires BOTH title and author to line up. A looser match here doesn't
 *  just mislabel a card "Subscribed": the preview page redirects on it, silently
 *  landing the user on a different show than the one they clicked. */
export function matchSubscription(
  result: Pick<DirectoryResult, 'feedUrl' | 'title' | 'author'>,
  subs: Subscription[],
): Subscription | null {
  const key = feedKey(result.feedUrl)
  if (key) return subs.find(s => feedKey(s.feedUrl) === key) ?? null
  const title = result.title.trim().toLowerCase()
  const author = result.author?.trim().toLowerCase()
  if (!title || !author) return null
  return subs.find(s =>
    s.name.trim().toLowerCase() === title &&
    s.author?.trim().toLowerCase() === author,
  ) ?? null
}

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
