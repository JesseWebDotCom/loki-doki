// Movies aggregator. There's no keyless TVMaze equivalent for film, so JustWatch is the
// primary metadata source (title, year, synopsis, age cert, runtime, poster, streaming),
// enriched with the shared title modules (trailers/soundtrack, Wikipedia overview, reviews,
// trivia, parents guide, backdrop) and — uniquely for movies — local showtimes via the
// existing Fandango integration. Movies are keyed by title (+year), since that's all the
// browse/lookup feeds and Fandango give us in common.

import { and, eq } from 'drizzle-orm'
import { fetchShowtimes, showtimesTodayIso, isUsZipCode, zipFromCoords, type ShowMovie, type ShowtimesData } from '@/tools/showtimes'
import { db } from '@/db'
import { userPreferences, toolUserConfig } from '@/db/schema'
import { resolveToolConfig } from '@/lib/toolConfig'
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
  // IMDb-class extras from the JustWatch detail lookup (all optional/nullable).
  scoring: import('@/lib/titles/types').TitleScoring | null
  imdbId: string | null
  cast: import('@/lib/titles/types').CastMember[]
  directors: string[]
  similarTitles: import('@/lib/titles/types').SimilarTitle[]
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
    scoring: lookup.scoring,
    imdbId: lookup.imdbId,
    cast: lookup.cast,
    directors: lookup.directors,
    similarTitles: lookup.similarTitles,
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

// ── rail pages: Top Rated / New Releases (JustWatch browse) ─────────────────────────

/** IMDb-Top-250-flavor list: IMDB_SCORE sort with a big votes floor (verified live). */
export async function getTopRatedMovies(): Promise<MovieSummary[]> {
  const items = await browsePopular({ objectType: 'MOVIE', sortBy: 'IMDB_SCORE', imdbVotesMin: 200_000, first: 48 })
  return items.map(jwToSummary)
}

/** This year's releases, trending first. */
export async function getNewMovies(): Promise<MovieSummary[]> {
  const items = await browsePopular({ objectType: 'MOVIE', sortBy: 'TRENDING', releaseYearMin: new Date().getFullYear(), first: 48 })
  return items.map(jwToSummary)
}

/** Age-appropriate movie discovery: US MPAA certs by viewer age ("something for an 8 year old").
 *  Trending-first so the list feels current, not a dusty catalog. */
export async function getMoviesForAge(age: number): Promise<MovieSummary[]> {
  const certs = age <= 6 ? ['G'] : age <= 12 ? ['G', 'PG'] : ['G', 'PG', 'PG-13']
  const items = await browsePopular({ objectType: 'MOVIE', sortBy: 'TRENDING', ageCertifications: certs, first: 48 })
  return items.map(jwToSummary)
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

// ── ZIP resolution (household location → ZIP) ───────────────────────────────────────
// Fandango needs a 5-digit ZIP, but the household `user.location` preference only stores
// lat/lng + a city name. Resolution order: the user's saved Showtimes ZIP (the editable
// setting) → reverse-geocode the household location. The reverse-geocode is cached in-memory
// per rounded coordinate so we don't hit Nominatim on every page load.

export type ZipSource = 'setting' | 'location' | null
export interface ResolvedZip {
  zip: string | null
  source: ZipSource
}

const zipCoordCache = new Map<string, { zip: string | null; at: number }>()
const ZIP_COORD_TTL_MS = 24 * 60 * 60 * 1000

async function readUserLocation(userId: string): Promise<{ lat?: number; lng?: number; displayName?: string; postalCode?: string } | null> {
  try {
    const [row] = await db
      .select({ value: userPreferences.value })
      .from(userPreferences)
      .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, 'user.location')))
      .limit(1)
    if (!row) return null
    return JSON.parse(row.value) as { lat?: number; lng?: number; displayName?: string; postalCode?: string }
  } catch {
    return null
  }
}

/** The user's explicitly-saved Showtimes ZIP (the editable setting), or '' if none/invalid. */
export async function getSavedZip(userId: string): Promise<string> {
  const cfg = await resolveToolConfig('showtimes', userId)
  const saved = String(cfg['default_zip'] ?? '').trim()
  return isUsZipCode(saved) ? saved : ''
}

/** Persist the user's Showtimes ZIP (stored on the shared `showtimes` tool config so the
 *  companion tool and the Movies app resolve the same value). Empty clears it. */
export async function setSavedZip(userId: string, zip: string): Promise<string> {
  const clean = zip.trim()
  const value = isUsZipCode(clean) ? clean : ''
  const where = and(
    eq(toolUserConfig.userId, userId),
    eq(toolUserConfig.toolId, 'showtimes'),
    eq(toolUserConfig.key, 'default_zip'),
  )
  if (!value) {
    await db.delete(toolUserConfig).where(where)
    return ''
  }
  const [existing] = await db.select({ id: toolUserConfig.id }).from(toolUserConfig).where(where).limit(1)
  if (existing) {
    await db.update(toolUserConfig).set({ value: JSON.stringify(value), updatedAt: new Date() }).where(where)
  } else {
    await db.insert(toolUserConfig).values({
      id: crypto.randomUUID(), userId, toolId: 'showtimes', key: 'default_zip', value: JSON.stringify(value), updatedAt: new Date(),
    })
  }
  return value
}

/** Resolve a US ZIP for a user: saved setting → reverse-geocode household `user.location`. */
export async function resolveUserZip(userId: string): Promise<ResolvedZip> {
  const saved = await getSavedZip(userId)
  if (saved) return { zip: saved, source: 'setting' }

  const loc = await readUserLocation(userId)
  // A ZIP the user typed at onboarding is exact — prefer it over reverse-geocoding coordinates.
  if (loc?.postalCode && isUsZipCode(loc.postalCode)) return { zip: loc.postalCode, source: 'location' }
  if (loc && typeof loc.lat === 'number' && typeof loc.lng === 'number') {
    const key = `${loc.lat.toFixed(3)},${loc.lng.toFixed(3)}`
    const cached = zipCoordCache.get(key)
    if (cached && Date.now() - cached.at < ZIP_COORD_TTL_MS) {
      return { zip: cached.zip, source: cached.zip ? 'location' : null }
    }
    const zip = await zipFromCoords(loc.lat, loc.lng)
    zipCoordCache.set(key, { zip, at: Date.now() })
    if (zip) return { zip, source: 'location' }
  }
  return { zip: null, source: null }
}

/** Full showtimes payload near a ZIP — movies + theaters + times (the discovery section). */
export async function getShowtimesNear(zip: string): Promise<ShowtimesData | null> {
  if (!isUsZipCode(zip)) return null
  const date = showtimesTodayIso()
  return cachedLookup('showtimes', `${zip}:${date}`, THREE_HOURS_MS, () => fetchShowtimes(zip, date))
}
