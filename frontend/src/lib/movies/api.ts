// Typed wrappers around /api/movies/*. Movies are keyed by title (+year) — the URL ref is
// the encoded title, with the year carried as a query param for disambiguation.

import type { ReviewDigest, TitleMedia, ParentsGuide, StreamProvider } from '@/lib/shows/api'

const opts: RequestInit = { credentials: 'include' }

export type { ReviewDigest, TitleMedia, ParentsGuide, StreamProvider }

export interface MovieSummary {
  title: string
  year: number | null
  poster: string | null
  genre: string | null
}

export interface MovieDetails {
  title: string
  year: number | null
  summary: string
  ageCertification: string | null
  runtimeMinutes: number | null
  poster: string | null
  justwatchUrl: string | null
}

export interface WebProvider {
  name: string
  searchUrl: string
}

export interface TitleScoring {
  imdbScore: number | null
  imdbVotes: number | null
  tmdbScore: number | null
  tomatoMeter: number | null
  certifiedFresh: boolean
}

export interface CastMember {
  name: string
  character: string
}

export interface SimilarTitle {
  title: string
  year: number | null
  objectType: string
  posterUrl: string
}

// Fast JustWatch core — renders the movie page immediately; enrichments load separately.
export interface MovieCore {
  details: MovieDetails
  backdrop: string | null
  streaming: { providers: StreamProvider[]; theaters: StreamProvider[]; justwatchUrl: string | null; webProviders?: WebProvider[] }
  inTheaters: boolean
  scoring: TitleScoring | null
  imdbId: string | null
  cast: CastMember[]
  directors: string[]
  similarTitles: SimilarTitle[]
}

export interface TheaterGroup {
  theater_name: string
  times: string[]
}

export interface ShowMovie {
  title: string
  slug: string | null
  url: string | null
  rating: string | null
  runtime_minutes: number | null
  poster_url: string | null
  times: string[]
  trailer_url: string
  theater_groups: TheaterGroup[]
}

export interface MovieShelf {
  key: string
  title: string
  items: MovieSummary[]
}

export interface ShowtimesData {
  zip: string
  date: string
  theater_count: number
  movies: ShowMovie[]
  source_url: string
}

export type ZipSource = 'setting' | 'location' | null

export interface NearMe {
  zip: string | null
  source: ZipSource
  data: ShowtimesData | null
}

// Build the detail-route link target for a movie.
export function movieTo(m: { title: string; year: number | null }): string {
  const y = m.year ? `?year=${m.year}` : ''
  return `/movies/${encodeURIComponent(m.title)}${y}`
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, opts)
  if (!res.ok) throw new Error(`Request failed: ${res.status}`)
  return (await res.json()) as T
}

export async function getMoviesHome(): Promise<MovieShelf[]> {
  const data = await getJson<{ shelves: MovieShelf[] }>('/api/movies/home')
  return data.shelves
}

export async function getInTheaters(zip = ''): Promise<MovieSummary[]> {
  const data = await getJson<{ items: MovieSummary[] }>(`/api/movies/in-theaters?zip=${encodeURIComponent(zip)}`)
  return data.items
}

// Full "what's playing near you" payload with theaters + showtimes. Resolves the household ZIP
// server-side when none is passed, so the section works with zero setup.
export async function getShowtimesNearMe(zip = ''): Promise<NearMe> {
  return getJson<NearMe>(`/api/movies/near-me${zip ? `?zip=${encodeURIComponent(zip)}` : ''}`)
}

export interface ZipInfo {
  saved: string
  zip: string | null
  source: ZipSource
}

export async function getMovieZip(): Promise<ZipInfo> {
  return getJson<ZipInfo>('/api/movies/zip')
}

export async function setMovieZip(zip: string): Promise<string> {
  const res = await fetch('/api/movies/zip', {
    credentials: 'include',
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ zip }),
  })
  if (!res.ok) throw new Error('Failed to save ZIP')
  return ((await res.json()) as { saved: string }).saved
}

export async function getTopRatedMovies(): Promise<MovieSummary[]> {
  return (await getJson<{ items: MovieSummary[] }>('/api/movies/top-rated')).items
}

export async function getNewMovies(): Promise<MovieSummary[]> {
  return (await getJson<{ items: MovieSummary[] }>('/api/movies/new')).items
}

export async function getMoviesForAge(age: number): Promise<MovieSummary[]> {
  return (await getJson<{ items: MovieSummary[] }>(`/api/movies/for-age?age=${age}`)).items
}

export async function searchMovies(q: string): Promise<MovieSummary[]> {
  const data = await getJson<{ results: MovieSummary[] }>(`/api/movies/search?q=${encodeURIComponent(q)}`)
  return data.results
}

function yq(year: number | null): string {
  return year ? `&year=${year}` : ''
}

export async function getMovie(title: string, year: number | null): Promise<MovieCore> {
  return getJson<MovieCore>(`/api/movies/detail?title=${encodeURIComponent(title)}${yq(year)}`)
}

export async function getMovieMedia(title: string, year: number | null): Promise<TitleMedia | null> {
  const data = await getJson<{ media: TitleMedia | null }>(`/api/movies/media?title=${encodeURIComponent(title)}${yq(year)}`)
  return data.media
}

export async function getMovieOverview(title: string, year: number | null): Promise<{ text: string; url: string } | null> {
  const data = await getJson<{ overview: { text: string; url: string } | null }>(`/api/movies/overview?title=${encodeURIComponent(title)}${yq(year)}`)
  return data.overview
}

export async function getMovieParentsGuide(title: string, year: number | null): Promise<ParentsGuide | null> {
  const data = await getJson<{ parentsGuide: ParentsGuide | null }>(`/api/movies/parents-guide?title=${encodeURIComponent(title)}${yq(year)}`)
  return data.parentsGuide
}

export async function getMovieBackdrop(title: string, year: number | null): Promise<string | null> {
  const data = await getJson<{ backdrop: string | null }>(`/api/movies/backdrop?title=${encodeURIComponent(title)}${yq(year)}`)
  return data.backdrop
}

export async function getMovieShowtimes(title: string, zip: string): Promise<ShowMovie | null> {
  const data = await getJson<{ movie: ShowMovie | null }>(
    `/api/movies/showtimes?title=${encodeURIComponent(title)}&zip=${encodeURIComponent(zip)}`,
  )
  return data.movie
}

export async function getMovieReviews(title: string, year: number | null): Promise<ReviewDigest | null> {
  const y = year ? `&year=${year}` : ''
  const data = await getJson<{ reviews: ReviewDigest | null }>(`/api/movies/reviews?title=${encodeURIComponent(title)}${y}`)
  return data.reviews
}

export async function getMovieTrivia(title: string, year: number | null): Promise<string[]> {
  const y = year ? `&year=${year}` : ''
  const data = await getJson<{ trivia: string[] }>(`/api/movies/trivia?title=${encodeURIComponent(title)}${y}`)
  return data.trivia
}

// ── AI podcast (single deep-dive) ─────────────────────────────────────────────────

export interface MoviePodcast {
  showId: string
  episodes: { id: string; title: string; status: 'pending' | 'generating' | 'ready' | 'failed'; durationSec: number | null; createdAt: number }[]
}

export async function getMoviePodcastApi(title: string): Promise<MoviePodcast | null> {
  const data = await getJson<{ podcast: MoviePodcast | null }>(`/api/movies/podcast?title=${encodeURIComponent(title)}`)
  return data.podcast
}

export async function createMoviePodcast(title: string, year: number | null, overview: string): Promise<{ id: string; queued: boolean }> {
  const res = await fetch('/api/movies/podcast', {
    credentials: 'include',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, year, overview }),
  })
  if (!res.ok) throw new Error('Failed to create podcast')
  return (await res.json()) as { id: string; queued: boolean }
}
