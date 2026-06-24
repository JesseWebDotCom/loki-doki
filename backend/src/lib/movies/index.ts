// Movies aggregator. There's no keyless TVMaze equivalent for film, so JustWatch is the
// primary metadata source (title, year, synopsis, age cert, runtime, poster, streaming),
// enriched with the shared title modules (trailers/soundtrack, Wikipedia overview, reviews,
// trivia, parents guide, backdrop) and — uniquely for movies — local showtimes via the
// existing Fandango integration. Movies are keyed by title (+year), since that's all the
// browse/lookup feeds and Fandango give us in common.

import { fetchShowtimes, showtimesTodayIso, isUsZipCode, type ShowMovie } from '@/tools/showtimes'
import { cachedLookup } from '@/lib/lookupCache'
import { lookupTitle, webStreamingFallback, type StreamingInfo } from '@/lib/titles/streaming'
import { browsePopular, type JwTitle } from '@/lib/titles/justwatch'
import { getTitleMedia } from '@/lib/titles/media'
import { getOverview, type TitleOverview } from '@/lib/titles/overview'
import { getParentsGuide, type ContentRating } from '@/lib/titles/parentsGuide'
import { findBackdrop } from '@/lib/titles/backdrop'
import type { TitleMedia } from '@/lib/titles/types'

const THREE_HOURS_MS = 3 * 60 * 60 * 1000
const THIRTY_MIN_MS = 30 * 60 * 1000

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

// Fast core for the movie page — the JustWatch lookup (metadata + streaming) + an instant
// poster-based backdrop. The slower enrichments (trailers, overview, parents guide, sharper
// backdrop, reviews, trivia) each stream in via their own title-keyed endpoint.
export interface MovieCore {
  details: MovieDetails
  backdrop: string | null
  streaming: StreamingInfo
  inTheaters: boolean
}

export async function getMovieCore(title: string, year: number | null): Promise<MovieCore | null> {
  const lookup = await lookupTitle(title, 'MOVIE')
  if (!lookup || !lookup.found) return null
  const resolvedYear = lookup.year ?? year
  // Supplement with a web-search check only when JustWatch lists nothing AND the film isn't in
  // theaters — for in-cinema titles the web is full of "when will it come to X" speculation,
  // which would otherwise surface as false "available on X" chips.
  const webProviders =
    lookup.providers.length === 0 && lookup.theaters.length === 0
      ? await webStreamingFallback(lookup.title, resolvedYear)
      : []
  return {
    details: {
      title: lookup.title,
      year: resolvedYear,
      summary: lookup.shortDescription,
      ageCertification: lookup.ageCertification || null,
      runtimeMinutes: lookup.runtimeMinutes,
      poster: lookup.posterUrl || null,
      justwatchUrl: lookup.justwatchUrl,
    },
    backdrop: lookup.posterUrl || null,
    streaming: { providers: lookup.providers, theaters: lookup.theaters, justwatchUrl: lookup.justwatchUrl, webProviders },
    inTheaters: lookup.theaters.length > 0,
  }
}

// ── per-section enrichments (title-keyed; frontend already has title+year) ──────────

export function getMovieMediaById(title: string, year: number | null): Promise<TitleMedia> {
  return getTitleMedia(title, year ? String(year) : null, 'movie')
}
export function getMovieOverviewById(title: string, year: number | null): Promise<TitleOverview | null> {
  return getOverview(title, year ? String(year) : null, 'movie')
}
export function getMovieParentsGuideById(title: string, year: number | null): Promise<ContentRating | null> {
  return getParentsGuide(title, year ? String(year) : null, 'movie')
}
export function getMovieBackdropById(title: string, year: number | null): Promise<string | null> {
  return findBackdrop(title, year ? String(year) : null, 'movie')
}

// ── home shelves ──────────────────────────────────────────────────────────────────

export interface MovieShelf {
  key: string
  title: string
  items: MovieSummary[]
}

function jwToSummary(t: JwTitle): MovieSummary {
  return { title: t.title, year: t.year, poster: t.poster, genre: t.genres[0] ?? null }
}

// Build a few genre rows from a JustWatch pool, biggest buckets first.
function genreShelves(pool: JwTitle[], max = 3): MovieShelf[] {
  const buckets = new Map<string, JwTitle[]>()
  for (const t of pool) {
    for (const g of t.genres) {
      const arr = buckets.get(g) ?? []
      if (arr.length < 20 && !arr.some((x) => x.title === t.title && x.year === t.year)) arr.push(t)
      buckets.set(g, arr)
    }
  }
  return [...buckets.entries()]
    .filter(([, items]) => items.length >= 5)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, max)
    .map(([genre, items]) => ({ key: `genre:${genre}`, title: genre, items: items.map(jwToSummary) }))
}

export async function getHomeShelves(): Promise<MovieShelf[]> {
  return cachedLookup('movies-home', 'v2', THIRTY_MIN_MS, async () => {
    const currentYear = new Date().getFullYear()
    const [inTheaters, trending, popular, newReleases] = await Promise.all([
      browsePopular({ objectType: 'MOVIE', cinema: true, first: 20 }),
      browsePopular({ objectType: 'MOVIE', sortBy: 'TRENDING', first: 20 }),
      browsePopular({ objectType: 'MOVIE', sortBy: 'POPULAR', first: 20 }),
      browsePopular({ objectType: 'MOVIE', sortBy: 'TRENDING', releaseYearMin: currentYear - 1, first: 20 }),
    ])

    const shelves: MovieShelf[] = []
    if (inTheaters.length) shelves.push({ key: 'in-theaters', title: 'In Theaters Now', items: inTheaters.map(jwToSummary) })
    if (trending.length) shelves.push({ key: 'trending', title: 'Trending Now', items: trending.map(jwToSummary) })
    if (popular.length) shelves.push({ key: 'popular', title: 'Popular Movies', items: popular.map(jwToSummary) })
    if (newReleases.length) shelves.push({ key: 'new', title: 'New Releases', items: newReleases.map(jwToSummary) })
    shelves.push(...genreShelves([...trending, ...popular]))
    return shelves
  })
}

// ── in theaters near a ZIP (Fandango) — used for the per-movie showtimes panel ───────

function showMovieToSummary(m: ShowMovie): MovieSummary {
  return { title: m.title, year: null, poster: m.poster_url, genre: null }
}

/** Movies currently in theaters near a ZIP — drives the "In Theaters" shelf. */
export async function getInTheaters(zip: string): Promise<MovieSummary[]> {
  if (!isUsZipCode(zip)) return []
  const date = showtimesTodayIso()
  const data = await cachedLookup('showtimes', `${zip}:${date}`, THREE_HOURS_MS, () => fetchShowtimes(zip, date))
  if (!data) return []
  return data.movies.map(showMovieToSummary)
}

/** Showtimes for one movie near a ZIP — the per-movie showtimes panel. */
export async function getMovieShowtimes(title: string, zip: string): Promise<ShowMovie | null> {
  if (!isUsZipCode(zip)) return null
  const date = showtimesTodayIso()
  const data = await cachedLookup('showtimes', `${zip}:${date}`, THREE_HOURS_MS, () => fetchShowtimes(zip, date))
  if (!data) return null
  const t = title.toLowerCase()
  return (
    data.movies.find((m) => m.title.toLowerCase() === t) ??
    data.movies.find((m) => m.title.toLowerCase().includes(t) || t.includes(m.title.toLowerCase())) ??
    null
  )
}
