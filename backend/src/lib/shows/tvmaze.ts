// TVMaze data layer for the Shows app — keyless, no API key. Wraps the handful of endpoints
// we use (show details, episodes, cast, images, search, schedule) with caching and a
// uniform, frontend-friendly shape. Every fetch is fault-tolerant: a failure yields null /
// [] so the aggregator can still assemble a partial bundle.

import { stripTags } from '@/lib/htmlText'
import { cachedLookup } from '@/lib/lookupCache'

const API = 'https://api.tvmaze.com'
const SIX_HOURS_MS = 6 * 60 * 60 * 1000
const ONE_DAY_MS = 24 * 60 * 60 * 1000

async function tvmazeGet<T>(path: string, timeoutMs = 6000): Promise<T | null> {
  try {
    const res = await fetch(`${API}${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

// ── shapes ──────────────────────────────────────────────────────────────────────

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

type RawShow = Record<string, unknown>

function networkName(show: RawShow): string | null {
  const net = (show.network as RawShow | null)?.name ?? (show.webChannel as RawShow | null)?.name
  return net ? String(net) : null
}

function posterOf(show: RawShow): string | null {
  const image = (show.image as RawShow | null) ?? {}
  const url = image.original ?? image.medium
  return url ? String(url) : null
}

function yearOf(show: RawShow): string | null {
  const premiered = show.premiered ? String(show.premiered) : ''
  return premiered ? premiered.slice(0, 4) : null
}

export function toSummary(show: RawShow): ShowSummary {
  return {
    id: Number(show.id),
    name: String(show.name ?? ''),
    year: yearOf(show),
    poster: posterOf(show),
    network: networkName(show),
    status: show.status ? String(show.status) : null,
    rating: (show.rating as RawShow | null)?.average != null ? Number((show.rating as RawShow).average) : null,
    genres: Array.isArray(show.genres) ? (show.genres as string[]) : [],
  }
}

function toDetails(show: RawShow): ShowDetails {
  const schedule = (show.schedule as RawShow | null) ?? {}
  const externals = (show.externals as RawShow | null) ?? {}
  return {
    id: Number(show.id),
    name: String(show.name ?? ''),
    summary: stripTags(String(show.summary ?? '')),
    premiered: show.premiered ? String(show.premiered) : null,
    ended: show.ended ? String(show.ended) : null,
    year: yearOf(show),
    status: show.status ? String(show.status) : null,
    network: networkName(show),
    language: show.language ? String(show.language) : null,
    genres: Array.isArray(show.genres) ? (show.genres as string[]) : [],
    rating: (show.rating as RawShow | null)?.average != null ? Number((show.rating as RawShow).average) : null,
    runtime: Number(show.runtime ?? show.averageRuntime ?? 0) || null,
    officialSite: show.officialSite ? String(show.officialSite) : null,
    poster: posterOf(show),
    background: null, // filled from /images by the aggregator
    url: show.url ? String(show.url) : null,
    scheduleDays: Array.isArray(schedule.days) ? (schedule.days as string[]) : [],
    externals: {
      imdb: externals.imdb ? String(externals.imdb) : null,
      thetvdb: externals.thetvdb != null ? Number(externals.thetvdb) : null,
      tvrage: externals.tvrage != null ? Number(externals.tvrage) : null,
    },
  }
}

// ── lookups ──────────────────────────────────────────────────────────────────────

export async function getShowDetails(id: number): Promise<ShowDetails | null> {
  return cachedLookup('tvmaze-show', String(id), SIX_HOURS_MS, async () => {
    const show = await tvmazeGet<RawShow>(`/shows/${id}`)
    return show?.id ? toDetails(show) : null
  })
}

export async function getShowEpisodes(id: number): Promise<ShowEpisode[]> {
  return cachedLookup('tvmaze-episodes', String(id), SIX_HOURS_MS, async () => {
    const raw = await tvmazeGet<RawShow[]>(`/shows/${id}/episodes`)
    if (!Array.isArray(raw)) return []
    return raw.map((e) => {
      const image = (e.image as RawShow | null) ?? {}
      return {
        id: Number(e.id),
        season: Number(e.season ?? 0),
        number: e.number != null ? Number(e.number) : null,
        name: String(e.name ?? ''),
        airdate: e.airdate ? String(e.airdate) : null,
        runtime: e.runtime != null ? Number(e.runtime) : null,
        summary: stripTags(String(e.summary ?? '')),
        image: image.medium || image.original ? String(image.medium ?? image.original) : null,
        rating: (e.rating as RawShow | null)?.average != null ? Number((e.rating as RawShow).average) : null,
      } satisfies ShowEpisode
    })
  })
}

export async function getShowCast(id: number): Promise<ShowCastMember[]> {
  return cachedLookup('tvmaze-cast', String(id), SIX_HOURS_MS, async () => {
    const raw = await tvmazeGet<Array<{ person?: RawShow; character?: RawShow }>>(`/shows/${id}/cast`)
    if (!Array.isArray(raw)) return []
    return raw.slice(0, 20).map((c) => {
      const image = (c.person?.image as RawShow | null) ?? {}
      return {
        name: String(c.person?.name ?? ''),
        character: String(c.character?.name ?? ''),
        image: image.medium ? String(image.medium) : null,
      }
    })
  })
}

/** Best landscape background art for the show, for the page wallpaper. */
export async function getShowBackground(id: number): Promise<string | null> {
  return cachedLookup('tvmaze-images', String(id), ONE_DAY_MS, async () => {
    const raw = await tvmazeGet<Array<RawShow>>(`/shows/${id}/images`)
    if (!Array.isArray(raw)) return null
    const backgrounds = raw.filter((i) => String(i.type ?? '') === 'background')
    const pick = backgrounds[0] ?? raw.find((i) => String(i.type ?? '') === 'banner')
    if (!pick) return null
    const res = (pick.resolutions as RawShow | null) ?? {}
    const original = (res.original as RawShow | null)?.url
    return original ? String(original) : null
  })
}

export async function searchShows(query: string, limit = 12): Promise<ShowSummary[]> {
  const q = query.trim()
  if (!q) return []
  return cachedLookup('tvmaze-search', `${limit}:${q.toLowerCase()}`, SIX_HOURS_MS, async () => {
    const raw = await tvmazeGet<Array<{ show?: RawShow }>>(`/search/shows?q=${encodeURIComponent(q)}`)
    if (!Array.isArray(raw)) return []
    return raw
      .map((r) => (r.show?.id ? toSummary(r.show) : null))
      .filter((s): s is ShowSummary => s !== null)
      .slice(0, limit)
  })
}

/** Resolve a free-text title (e.g. from a JustWatch trending row) to a TVMaze show. */
export async function resolveShow(title: string, year?: number | null): Promise<ShowSummary | null> {
  const q = title.trim()
  if (!q) return null
  return cachedLookup('tvmaze-resolve', `${q.toLowerCase()}:${year ?? ''}`, ONE_DAY_MS, async () => {
    const show = await tvmazeGet<RawShow>(`/singlesearch/shows?q=${encodeURIComponent(q)}`)
    if (!show?.id) return null
    const summary = toSummary(show)
    // Guard against wildly wrong matches when a year is known.
    if (year && summary.year && Math.abs(Number(summary.year) - year) > 2) return null
    return summary
  })
}

/** Shows with an episode airing in the given country today — the "On TV" feed. */
export async function getScheduleToday(country = 'US'): Promise<ShowSummary[]> {
  return cachedLookup('tvmaze-schedule', country, 3 * 60 * 60 * 1000, async () => {
    const raw = await tvmazeGet<Array<{ show?: RawShow; _embedded?: { show?: RawShow } }>>(`/schedule?country=${country}`)
    if (!Array.isArray(raw)) return []
    const seen = new Set<number>()
    const out: ShowSummary[] = []
    for (const entry of raw) {
      const show = entry.show ?? entry._embedded?.show
      if (!show?.id) continue
      const id = Number(show.id)
      if (seen.has(id)) continue
      seen.add(id)
      out.push(toSummary(show))
    }
    return out
  })
}
