import type { Tool, ToolResult } from './index'
import { cachedLookup } from '@/lib/lookupCache'

// Companion tool: movie theater showtimes near a ZIP. Ported from v2
// lokidoki/plugins/movies_fandango — queries Fandango's unofficial napi endpoint.
// Degrades gracefully (the endpoint is undocumented and may change).

const THREE_HOURS_MS = 3 * 60 * 60 * 1000
const UA = 'Mozilla/5.0 (compatible; LokiDoki/1.0)'

export interface Showtime { time: string }
export interface TheaterGroup { theater_name: string; times: string[] }
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
export interface ShowtimesData {
  zip: string
  date: string
  theater_count: number
  movies: ShowMovie[]
  source_url: string
}

function isUsZip(s: string): boolean {
  return /^\d{5}$/.test(s.trim())
}

/** Today as YYYY-MM-DD in local time. */
function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function normalizeRating(raw: string | null | undefined): string | null {
  if (!raw) return null
  const r = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (r === 'PG13') return 'PG-13'
  if (r === 'NC17') return 'NC-17'
  if (r === 'NOTRATED' || r === 'NR' || r === 'UNRATED') return 'NR'
  return raw
}

/** Fandango showtimes come in several shapes; prefer the machine date, fall back to labels. */
function normalizeTime(st: { ticketingDate?: string; screenReaderTime?: string; date?: string }): string | null {
  const td = st.ticketingDate
  if (td && td.includes('+')) {
    const hm = td.split('+')[1] // "20:20"
    if (hm && /^\d{1,2}:\d{2}/.test(hm)) {
      const [h, m] = hm.split(':')
      let hour = Number(h)
      const ampm = hour >= 12 ? 'PM' : 'AM'
      hour = hour % 12 || 12
      return `${hour}:${m!.slice(0, 2)} ${ampm}`
    }
  }
  return st.screenReaderTime?.trim() || st.date?.trim() || null
}

// Loose shapes for the napi payload — every level is optional/defensive.
interface NapiShowtime { ticketingDate?: string; screenReaderTime?: string; date?: string }
interface NapiAmenityGroup { showtimes?: NapiShowtime[] }
interface NapiVariant { amenityGroups?: NapiAmenityGroup[] }
interface NapiMovie {
  title?: string
  mopURI?: string
  rating?: string
  runtime?: number | string
  poster?: { size?: Record<string, string> }
  variants?: NapiVariant[]
}
interface NapiTheater { name?: string; movies?: NapiMovie[] }
interface NapiResponse { theaters?: NapiTheater[] }

function slugFromMopUri(mopURI: string | undefined): string | null {
  if (!mopURI) return null
  const m = mopURI.match(/([a-z0-9-]+)\/?$/i)
  return m ? m[1]! : null
}

export function isUsZipCode(s: string): boolean {
  return isUsZip(s)
}
export function showtimesTodayIso(): string {
  return todayIso()
}

export async function fetchShowtimes(zip: string, date: string): Promise<ShowtimesData | null> {
  const referer = `https://www.fandango.com/${zip}_movietimes?date=${date}`
  const params = new URLSearchParams({
    zipCode: zip,
    date,
    page: '1',
    favTheaterOnly: 'false',
    limit: '25',
    isdesktop: 'true',
    filter: 'open-theaters',
    filterEnabled: 'true',
  })
  const res = await fetch(`https://www.fandango.com/napi/theaterswithshowtimes?${params}`, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: referer,
    },
    signal: AbortSignal.timeout(8_000),
  })
  if (!res.ok) return null
  const data = (await res.json()) as NapiResponse
  const theaters = data.theaters ?? []
  if (theaters.length === 0) return null

  // Merge the same movie across theaters; collect per-theater time groups.
  const byMovie = new Map<string, ShowMovie>()
  for (const theater of theaters) {
    const theaterName = theater.name?.trim() || 'Theater'
    for (const movie of theater.movies ?? []) {
      const title = movie.title?.trim()
      if (!title) continue
      const key = title.toLowerCase()

      const times = new Set<string>()
      for (const variant of movie.variants ?? []) {
        for (const group of variant.amenityGroups ?? []) {
          for (const st of group.showtimes ?? []) {
            const t = normalizeTime(st)
            if (t) times.add(t)
          }
        }
      }
      if (times.size === 0) continue
      const timeList = [...times]

      let entry = byMovie.get(key)
      if (!entry) {
        const slug = slugFromMopUri(movie.mopURI)
        entry = {
          title,
          slug,
          url: slug ? `https://www.fandango.com/${slug}/movie-overview` : null,
          rating: normalizeRating(movie.rating),
          runtime_minutes: movie.runtime != null ? Number(movie.runtime) || null : null,
          poster_url: movie.poster?.size?.['300'] ?? null,
          times: [],
          trailer_url: `https://www.youtube.com/results?search_query=${encodeURIComponent(`${title} official trailer`)}`,
          theater_groups: [],
        }
        byMovie.set(key, entry)
      }
      for (const t of timeList) if (!entry.times.includes(t)) entry.times.push(t)
      entry.theater_groups.push({ theater_name: theaterName, times: timeList })
    }
  }

  const movies = [...byMovie.values()].slice(0, 10).map((m) => ({
    ...m,
    theater_groups: m.theater_groups.slice(0, 3),
  }))

  return { zip, date, theater_count: theaters.length, movies, source_url: referer }
}

/** Best-effort ZIP from coordinates via Nominatim reverse geocode (online). */
export async function zipFromCoords(lat: number, lng: number): Promise<string | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5_000) },
    )
    if (!res.ok) return null
    const data = (await res.json()) as { address?: { postcode?: string } }
    const pc = data.address?.postcode?.slice(0, 5)
    return pc && isUsZip(pc) ? pc : null
  } catch {
    return null
  }
}

export const showtimesTool: Tool = {
  id: 'showtimes',
  name: 'Movie Showtimes',
  description: 'Find movies playing in theaters near you and their showtimes, via Fandango.',
  offline: false,
  dataSources: [
    { name: 'Fandango', domain: 'fandango.com', purpose: 'Movie theater showtimes', type: 'api' },
    { name: 'Nominatim', domain: 'openstreetmap.org', purpose: 'ZIP code from coordinates', type: 'api' },
  ],
  configSchema: [
    {
      key: 'default_zip',
      label: 'Default ZIP code',
      description: 'Used to find nearby theaters when no ZIP is mentioned',
      type: 'string',
      scope: 'user',
      placeholder: 'e.g. 78701',
    },
  ],
  examples: [
    'what movies are playing in theaters near me',
    'movie showtimes tonight',
    'what time is a movie playing',
    'films at the local cinema today',
    'when can I see a movie in theaters',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'showtimes',
      description: 'Get movies and theater showtimes near a US ZIP code.',
      parameters: {
        type: 'object',
        required: [],
        properties: {
          zip: { type: 'string', description: '5-digit US ZIP code. Omit to use the saved default or current location.' },
          title: { type: 'string', description: 'Optional movie title to focus on.' },
        },
      },
    },
  },

  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const { zip: argZip, title } = args as { zip?: string; title?: string }

    let zip = argZip?.trim()
    if (!zip || !isUsZip(zip)) {
      const configured = String(config?.['default_zip'] ?? '').trim()
      if (isUsZip(configured)) {
        zip = configured
      } else {
        const lat = config?.['_lat'] as number | undefined
        const lng = config?.['_lng'] as number | undefined
        if (typeof lat === 'number' && typeof lng === 'number') {
          zip = (await zipFromCoords(lat, lng)) ?? undefined
        }
      }
    }
    if (!zip || !isUsZip(zip)) {
      return { success: false, error: 'A US ZIP code is required — include one or set a default in Settings' }
    }

    const date = todayIso()
    try {
      const data = await cachedLookup('showtimes', `${zip}:${date}`, THREE_HOURS_MS, () => fetchShowtimes(zip!, date))
      if (!data || data.movies.length === 0) {
        return { success: false, error: `No showtimes found near ${zip}` }
      }
      if (title?.trim()) {
        const t = title.trim().toLowerCase()
        const filtered = data.movies.filter((m) => m.title.toLowerCase().includes(t))
        return { success: true, data: { ...data, movies: filtered.length ? filtered : data.movies } }
      }
      return { success: true, data }
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return { success: false, offline: true, error: 'Showtimes are unavailable right now' }
      }
      return { success: false, error: String(err) }
    }
  },
}
