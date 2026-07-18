// Typed wrappers around the /api/shows/* endpoints, plus the shared media-image proxy
// helper used by both the Shows and Movies apps.

import type { UseQueryOptions } from '@tanstack/react-query'

const opts: RequestInit = { credentials: 'include' }

// Route external art through our cached proxy for known hosts; load anything else (e.g.
// image-search backdrops from arbitrary CDNs) directly. The proxy 404s non-allowlisted
// hosts, so the allowlist here must match the backend's.
const PROXY_HOSTS = /(^|\.)(tvmaze\.com|justwatch\.com|wikimedia\.org|wikipedia\.org|fandango\.com|ytimg\.com|ggpht\.com)$/i

/** Optional `w` = device-pixel render width for cards/grids: the proxy serves a
 *  bucketed webp downscale (240/480/960). Omit for heroes/backdrops/lightboxes. */
export function mediaImg(url: string | null | undefined, w?: number): string {
  if (!url) return ''
  try {
    const host = new URL(url).hostname
    if (PROXY_HOSTS.test(host)) return `/api/media/img?u=${encodeURIComponent(url)}${w ? `&w=${Math.round(w)}` : ''}`
  } catch {
    /* not an absolute URL — return as-is */
  }
  return url
}

// ── Types (mirror backend/src/lib/shows + lib/titles shapes) ──────────────────────

export interface StreamProvider {
  name: string
  offerType: string
  label: string
  url: string
  // Rental/purchase price like "$3.99" and the leaving-soon date (ISO), when JustWatch reports them.
  price?: string | null
  availableTo?: string | null
}

/** Real aggregate scores relayed by JustWatch (IMDb, TMDB, Rotten Tomatoes). */
export interface TitleScoring {
  imdbScore: number | null
  imdbVotes: number | null
  tmdbScore: number | null
  tomatoMeter: number | null
  certifiedFresh: boolean
}

export interface VideoLink {
  videoId: string
  title: string
  author: string | null
  channelThumb: string | null
  thumbnailUrl: string | null
  durationSec: number | null
  kind: 'trailer' | 'clip' | 'theme' | 'soundtrack' | 'interview'
}

export interface PlatformLink {
  platform: string
  url: string
}

export interface SoundtrackAlbum {
  name: string
  artist: string
  artworkUrl: string | null
  links: PlatformLink[]
}

export interface TitleMedia {
  trailer: VideoLink | null
  clips: VideoLink[]
  music: VideoLink[]
  soundtrackAlbums: SoundtrackAlbum[]
}

export interface ReviewScore {
  source: string
  value: string
}

export interface ReviewDigest {
  summary: string
  pros: string[]
  cons: string[]
  scores: ReviewScore[]
  sources: { title: string; url: string }[]
}

export interface ContentCategory {
  label: string
  rating?: number
  detail?: string
}

export interface ParentsGuide {
  title: string
  url: string
  ageRating?: string
  parentsNeedToKnow?: string
  categories: ContentCategory[]
  fallback: boolean
}

export interface ShowSummary {
  id: number
  name: string
  year: string | null
  poster: string | null
  network: string | null
  status: string | null
  rating: number | null
  genres: string[]
}

export interface ShowEpisode {
  id: number
  season: number
  number: number | null
  name: string
  airdate: string | null
  runtime: number | null
  summary: string
  image: string | null
  rating: number | null
}

export interface ShowCastMember {
  name: string
  character: string
  image: string | null
}

export interface ShowDetails {
  id: number
  name: string
  summary: string
  premiered: string | null
  ended: string | null
  year: string | null
  status: string | null
  network: string | null
  language: string | null
  genres: string[]
  rating: number | null
  runtime: number | null
  officialSite: string | null
  poster: string | null
  background: string | null
  url: string | null
  scheduleDays: string[]
  externals: { imdb: string | null; thetvdb: number | null; tvrage: number | null }
}

export interface SeasonGroup {
  season: number
  episodes: ShowEpisode[]
}

export interface WebProvider {
  name: string
  searchUrl: string
}

export interface StreamingInfo {
  providers: StreamProvider[]
  theaters: StreamProvider[]
  justwatchUrl: string | null
  webProviders?: WebProvider[]
  scoring?: TitleScoring | null
  imdbId?: string | null
}

// Fast TVMaze core — renders the page immediately. Enrichments load via their own calls.
export interface ShowCore {
  details: ShowDetails
  backdrop: string | null
  seasons: SeasonGroup[]
  seasonCount: number
  episodeCount: number
  cast: ShowCastMember[]
}

export interface ShowShelf {
  key: string
  title: string
  items: ShowSummary[]
}

export interface ScheduleEntry {
  show: ShowSummary
  airtime: string | null
  airtimeLabel: string | null
  episode: string | null
  season: number | null
  number: number | null
  streaming: boolean
}

export interface OnTvToday {
  date: string
  entries: ScheduleEntry[]
}

// ── Calls ─────────────────────────────────────────────────────────────────────────

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, opts)
  if (!res.ok) throw new Error(`Request failed: ${res.status}`)
  return (await res.json()) as T
}

export async function getShowsHome(): Promise<ShowShelf[]> {
  const data = await getJson<{ shelves: ShowShelf[] }>('/api/shows/home')
  return data.shelves
}

// Shared query options for the Shows home shelves — consumed by both ShowsHomePage and
// the prefetch warmer so the warmed cache key never drifts from what the page reads.
export function showsHomeQueryOptions(): UseQueryOptions<ShowShelf[]> {
  return { queryKey: ['shows-home'], queryFn: getShowsHome, staleTime: 30 * 60_000 }
}

export async function searchShowsApi(q: string): Promise<ShowSummary[]> {
  const data = await getJson<{ results: ShowSummary[] }>(`/api/shows/search?q=${encodeURIComponent(q)}`)
  return data.results
}

/** "Suggested for you" from the interest engine. `ref` is the dismiss key; `building`
 *  = the first pool build is still running (callers poll until it flips false). */
export function getSuggestedShows(): Promise<{ items: Array<ShowSummary & { ref: string }>; building: boolean }> {
  return getJson('/api/shows/suggested')
}

export async function getOnTvToday(): Promise<OnTvToday> {
  return getJson<OnTvToday>('/api/shows/on-tv')
}

export async function getShowsForAge(age: number): Promise<ShowSummary[]> {
  return (await getJson<{ items: ShowSummary[] }>(`/api/shows/for-age?age=${age}`)).items
}

export async function getTopRatedShows(): Promise<ShowSummary[]> {
  return (await getJson<{ items: ShowSummary[] }>('/api/shows/top-rated')).items
}

export interface UpcomingEpisode {
  show: ShowSummary
  name: string | null
  season: number | null
  number: number | null
  airdate: string | null
  airtime: string | null
  airstamp: string | null
}

export async function getShowsCalendar(): Promise<UpcomingEpisode[]> {
  return (await getJson<{ entries: UpcomingEpisode[] }>('/api/shows/calendar')).entries
}

export async function getShow(id: number | string): Promise<ShowCore> {
  return getJson<ShowCore>(`/api/shows/${id}`)
}

export async function getShowStreaming(id: number | string): Promise<StreamingInfo | null> {
  const data = await getJson<{ streaming: StreamingInfo | null }>(`/api/shows/${id}/streaming`)
  return data.streaming
}

export async function getShowMedia(id: number | string): Promise<TitleMedia | null> {
  const data = await getJson<{ media: TitleMedia | null }>(`/api/shows/${id}/media`)
  return data.media
}

export async function getShowOverview(id: number | string): Promise<{ text: string; url: string } | null> {
  const data = await getJson<{ overview: { text: string; url: string } | null }>(`/api/shows/${id}/overview`)
  return data.overview
}

export async function getShowParentsGuide(id: number | string): Promise<ParentsGuide | null> {
  const data = await getJson<{ parentsGuide: ParentsGuide | null }>(`/api/shows/${id}/parents-guide`)
  return data.parentsGuide
}

export async function getShowBackdrop(id: number | string): Promise<string | null> {
  const data = await getJson<{ backdrop: string | null }>(`/api/shows/${id}/backdrop`)
  return data.backdrop
}

export async function getShowReviews(id: number | string): Promise<ReviewDigest | null> {
  const data = await getJson<{ reviews: ReviewDigest | null }>(`/api/shows/${id}/reviews`)
  return data.reviews
}

export async function getShowTrivia(id: number | string): Promise<string[]> {
  const data = await getJson<{ trivia: string[] }>(`/api/shows/${id}/trivia`)
  return data.trivia
}

// ── AI podcast ──────────────────────────────────────────────────────────────────

export interface PodcastEpisodeLite {
  id: string
  title: string
  status: 'pending' | 'generating' | 'ready' | 'failed'
  durationSec: number | null
  createdAt: number
}

export interface ShowPodcast {
  showId: string
  episodes: PodcastEpisodeLite[]
  remaining: number
}

export async function getShowPodcast(id: number | string): Promise<ShowPodcast | null> {
  const data = await getJson<{ podcast: ShowPodcast | null }>(`/api/shows/${id}/podcast`)
  return data.podcast
}

export async function createShowPodcast(id: number | string): Promise<{ podcastShowId: string; queued: number; remaining: number }> {
  const res = await fetch(`/api/shows/${id}/podcast`, { credentials: 'include', method: 'POST' })
  if (!res.ok) throw new Error('Failed to create podcast')
  return (await res.json()) as { podcastShowId: string; queued: number; remaining: number }
}

export async function nextShowPodcastBatch(id: number | string): Promise<{ podcastShowId: string; queued: number; remaining: number }> {
  const res = await fetch(`/api/shows/${id}/podcast/next-batch`, { credentials: 'include', method: 'POST' })
  if (!res.ok) throw new Error('Failed to queue next batch')
  return (await res.json()) as { podcastShowId: string; queued: number; remaining: number }
}
