// Shows aggregator — assembles the rich show bundle and the home-page discovery shelves
// from TVMaze (core metadata) + the shared title enrichment (streaming, trailers/music,
// Wikipedia overview, parents guide, backdrop). Every external piece is fault-tolerant, so
// a partial outage degrades a section rather than failing the page. Reviews and trivia are
// LLM-heavy and fetched lazily by their own routes.

import {
  getShowBackground,
  getShowCast,
  getShowDetails,
  getShowEpisodes,
  getScheduleToday,
  resolveShow,
  type ShowCastMember,
  type ShowDetails,
  type ShowEpisode,
  type ShowSummary,
} from './tvmaze'
import { getStreaming, type StreamingInfo } from '@/lib/titles/streaming'
import { browsePopular, type JwTitle } from '@/lib/titles/justwatch'
import { getTitleMedia } from '@/lib/titles/media'
import { getOverview, type TitleOverview } from '@/lib/titles/overview'
import { getParentsGuide, type ContentRating } from '@/lib/titles/parentsGuide'
import { findBackdrop } from '@/lib/titles/backdrop'
import { cachedLookup } from '@/lib/lookupCache'
import type { TitleMedia } from '@/lib/titles/types'

export interface SeasonGroup {
  season: number
  episodes: ShowEpisode[]
}

// Fast "core" bundle — TVMaze only, so the page hero/episodes/cast render immediately. The
// slower enrichments (streaming, media, overview, parents guide, sharper backdrop, reviews,
// trivia) each have their own endpoint and stream into their section independently.
export interface ShowCore {
  details: ShowDetails
  backdrop: string | null
  seasons: SeasonGroup[]
  seasonCount: number
  episodeCount: number
  cast: ShowCastMember[]
}

function groupBySeason(episodes: ShowEpisode[]): SeasonGroup[] {
  const map = new Map<number, ShowEpisode[]>()
  for (const e of episodes) {
    const arr = map.get(e.season) ?? []
    arr.push(e)
    map.set(e.season, arr)
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([season, eps]) => ({ season, episodes: eps.sort((a, b) => (a.number ?? 0) - (b.number ?? 0)) }))
}

export async function getShowCore(id: number): Promise<ShowCore | null> {
  const [details, episodes, cast, background] = await Promise.all([
    getShowDetails(id),
    getShowEpisodes(id),
    getShowCast(id),
    getShowBackground(id),
  ])
  if (!details) return null

  const seasons = groupBySeason(episodes)
  return {
    details: { ...details, background },
    // Instant wallpaper from TVMaze art (or the poster); the /backdrop endpoint sharpens it.
    backdrop: background ?? details.poster,
    seasons,
    seasonCount: seasons.length,
    episodeCount: episodes.length,
    cast,
  }
}

// ── per-section enrichments (each its own lazy endpoint) ───────────────────────────

export async function getShowStreaming(id: number): Promise<StreamingInfo | null> {
  const details = await getShowDetails(id)
  if (!details) return null
  return getStreaming(details.name, 'SHOW', 'US', details.year ? Number(details.year) : null)
}

export async function getShowMediaById(id: number): Promise<TitleMedia | null> {
  const details = await getShowDetails(id)
  if (!details) return null
  return getTitleMedia(details.name, details.year, 'show')
}

export async function getShowOverviewById(id: number): Promise<TitleOverview | null> {
  const details = await getShowDetails(id)
  if (!details) return null
  return getOverview(details.name, details.year, 'show')
}

export async function getShowParentsGuideById(id: number): Promise<ContentRating | null> {
  const details = await getShowDetails(id)
  if (!details) return null
  return getParentsGuide(details.name, details.year, 'show')
}

// Sharper landscape backdrop via image search (slow) — used to upgrade the core poster art.
export async function getShowBackdropById(id: number): Promise<string | null> {
  const details = await getShowDetails(id)
  if (!details) return null
  if (details.poster) {
    const bg = await getShowBackground(id)
    if (bg) return bg
  }
  return findBackdrop(details.name, details.year, 'show')
}

// ── home shelves ──────────────────────────────────────────────────────────────────

export interface ShowShelf {
  key: string
  title: string
  items: ShowSummary[]
}

// Resolve JustWatch titles to TVMaze shows so the cards carry native ids + posters (the show
// detail page is TVMaze-keyed). Unresolved titles are dropped. Cached upstream via the
// per-title resolve cache + the home-shelf cache.
async function resolveJwShows(jw: JwTitle[]): Promise<ShowSummary[]> {
  const resolved = await Promise.all(jw.map((t) => resolveShow(t.title, t.year)))
  const seen = new Set<number>()
  const out: ShowSummary[] = []
  for (const s of resolved) {
    if (!s || seen.has(s.id)) continue
    seen.add(s.id)
    out.push(s)
  }
  return out
}

// Build a few genre rows from a pool of shows, biggest buckets first.
function genreShelves(pool: ShowSummary[], max = 3): ShowShelf[] {
  const buckets = new Map<string, ShowSummary[]>()
  for (const s of pool) {
    for (const g of s.genres) {
      const arr = buckets.get(g) ?? []
      if (arr.length < 20 && !arr.some((x) => x.id === s.id)) arr.push(s)
      buckets.set(g, arr)
    }
  }
  return [...buckets.entries()]
    .filter(([, items]) => items.length >= 4)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, max)
    .map(([genre, items]) => ({ key: `genre:${genre}`, title: genre, items }))
}

/** IMDb-Top-250-flavor list resolved to TVMaze ids (votes floor keeps out obscure titles). */
export async function getTopRatedShows(): Promise<ShowSummary[]> {
  return cachedLookup('shows-top-rated', 'v1', 3 * 60 * 60 * 1000, async () => {
    const jw = await browsePopular({ objectType: 'SHOW', sortBy: 'IMDB_SCORE', imdbVotesMin: 100_000, first: 48 })
    return resolveJwShows(jw)
  })
}

/** Age-appropriate show discovery: US TV certs by viewer age. Trending-first, TVMaze-resolved. */
export async function getShowsForAge(age: number): Promise<ShowSummary[]> {
  const certs = age <= 6 ? ['TV-Y', 'TV-G'] : age <= 9 ? ['TV-Y', 'TV-Y7', 'TV-G'] : age <= 12 ? ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG'] : ['TV-Y7', 'TV-G', 'TV-PG', 'TV-14']
  return cachedLookup('shows-for-age', certs.join(','), 3 * 60 * 60 * 1000, async () => {
    const jw = await browsePopular({ objectType: 'SHOW', sortBy: 'TRENDING', ageCertifications: certs, first: 48 })
    return resolveJwShows(jw)
  })
}

export async function getHomeShelves(): Promise<ShowShelf[]> {
  return cachedLookup('shows-home', 'v2', 30 * 60 * 1000, async () => {
    const [trendingJw, popularJw, onTv] = await Promise.all([
      browsePopular({ objectType: 'SHOW', sortBy: 'TRENDING', first: 18 }),
      browsePopular({ objectType: 'SHOW', sortBy: 'POPULAR', first: 18 }),
      getScheduleToday('US'),
    ])
    const [trending, popular] = await Promise.all([resolveJwShows(trendingJw), resolveJwShows(popularJw)])

    const shelves: ShowShelf[] = []
    if (trending.length) shelves.push({ key: 'trending', title: 'Trending Now', items: trending })
    if (popular.length) shelves.push({ key: 'popular', title: 'Popular Shows', items: popular })
    if (onTv.length) shelves.push({ key: 'on-tv', title: 'On TV Today', items: onTv.slice(0, 24) })

    // Genre rows derived from the union of the pools.
    shelves.push(...genreShelves([...trending, ...popular, ...onTv]))
    return shelves
  })
}
