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

/** Resolve a TVMaze show id from an external id (IMDb tt… or TheTVDB numeric). */
export async function lookupShowId(opts: { imdb?: string | null; thetvdb?: number | null }): Promise<number | null> {
  const param = opts.imdb ? `imdb=${encodeURIComponent(opts.imdb)}` : opts.thetvdb ? `thetvdb=${opts.thetvdb}` : null
  if (!param) return null
  return cachedLookup('tvmaze-lookup', param, ONE_DAY_MS, async () => {
    const show = await tvmazeGet<RawShow>(`/lookup/shows?${param}`)
    return show?.id ? Number(show.id) : null
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

// ── Next episode (the tracked-shows Calendar) ───────────────────────────────────────

export interface UpcomingEpisode {
  show: ShowSummary
  name: string | null
  season: number | null
  number: number | null
  airdate: string | null   // YYYY-MM-DD
  airtime: string | null   // 24h "20:00"
  airstamp: string | null  // ISO timestamp
}

/** The show's next scheduled episode via ?embed=nextepisode — null when nothing is scheduled
 *  (ended/on-hiatus shows). Cached 6h so a watchlist sweep stays cheap. */
export async function getNextEpisode(showId: number): Promise<UpcomingEpisode | null> {
  return cachedLookup('tvmaze-nextep', String(showId), SIX_HOURS_MS, async () => {
    const show = await tvmazeGet<RawShow & { _embedded?: { nextepisode?: Record<string, unknown> } }>(
      `/shows/${showId}?embed=nextepisode`,
    )
    if (!show?.id) return null
    const ep = show._embedded?.nextepisode
    if (!ep) return null
    return {
      show: toSummary(show),
      name: ep.name ? String(ep.name) : null,
      season: ep.season != null ? Number(ep.season) : null,
      number: ep.number != null ? Number(ep.number) : null,
      airdate: ep.airdate ? String(ep.airdate) : null,
      airtime: ep.airtime ? String(ep.airtime) : null,
      airstamp: ep.airstamp ? String(ep.airstamp) : null,
    }
  })
}

// ── On TV Tonight (rich schedule: airtime + episode + network) ──────────────────────

export interface ScheduleEntry {
  show: ShowSummary
  airtime: string | null      // 24h "20:00"
  airtimeLabel: string | null // "8:00 PM"
  episode: string | null
  season: number | null
  number: number | null
  streaming: boolean          // from the web/streaming schedule vs broadcast
}

interface RawScheduleEntry {
  airtime?: string
  name?: string
  season?: number
  number?: number
  show?: RawShow
  _embedded?: { show?: RawShow }
}

function to12h(t: string | null | undefined): string | null {
  if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return null
  const [h, m] = t.split(':')
  let hour = Number(h)
  const ampm = hour >= 12 ? 'PM' : 'AM'
  hour = hour % 12 || 12
  return `${hour}:${m} ${ampm}`
}

/** Tonight's TV for a date (YYYY-MM-DD): broadcast/cable airings for `country` plus streaming
 *  premieres (web). English-language web entries only (trims foreign-language noise), deduped
 *  per show+episode, sorted by airtime. Backs the "On TV Tonight" section and companion tool. */
export async function getOnTvTonight(date: string, country = 'US'): Promise<ScheduleEntry[]> {
  return cachedLookup('tvmaze-ontv', `${country}:${date}`, 3 * 60 * 60 * 1000, async () => {
    const [broadcast, web] = await Promise.all([
      tvmazeGet<RawScheduleEntry[]>(`/schedule?country=${country}&date=${date}`),
      tvmazeGet<RawScheduleEntry[]>(`/schedule/web?date=${date}`),
    ])
    const seen = new Set<string>()
    const out: ScheduleEntry[] = []
    const collect = (raw: RawScheduleEntry[] | null, streaming: boolean, cap = Infinity) => {
      if (!Array.isArray(raw)) return
      let added = 0
      for (const e of raw) {
        if (added >= cap) break
        const show = e.show ?? e._embedded?.show
        if (!show?.id) continue
        // Streaming schedule is global; keep English (or unspecified) to cut foreign-language noise.
        if (streaming) {
          const lang = show.language ? String(show.language) : null
          if (lang && lang !== 'English') continue
        }
        const key = `${Number(show.id)}:${e.season ?? ''}:${e.number ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          show: toSummary(show),
          airtime: e.airtime || null,
          airtimeLabel: to12h(e.airtime),
          episode: e.name ? String(e.name) : null,
          season: e.season != null ? Number(e.season) : null,
          number: e.number != null ? Number(e.number) : null,
          streaming,
        })
        added++
      }
    }
    collect(broadcast, false)
    collect(web, true, 60)
    out.sort((a, b) => (a.airtime ?? '99:99').localeCompare(b.airtime ?? '99:99'))
    return out.slice(0, 200)
  })
}
