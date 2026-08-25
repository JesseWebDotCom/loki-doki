import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'

const NAGER_API = 'https://date.nager.at/api/v3/PublicHolidays'

interface HolidayItem {
  date: string
  localName: string
  name: string
  countryCode: string
}

interface CacheEntry {
  holidays: HolidayItem[]
  offline: boolean
  expiresAt: number
}

// 24-hour in-memory cache keyed by "COUNTRY-YEAR"
const cache = new Map<string, CacheEntry>()
const TTL_MS = 24 * 60 * 60 * 1000

// Offline US fixed-date holidays (movable ones require Nager.Date)
const FIXED_US: Array<{ date: string; localName: string; name: string }> = [
  { date: '01-01', localName: "New Year's Day",   name: "New Year's Day" },
  { date: '02-14', localName: "Valentine's Day",  name: "Valentine's Day" },
  { date: '03-17', localName: "St. Patrick's Day", name: "St. Patrick's Day" },
  { date: '06-19', localName: 'Juneteenth',        name: 'Juneteenth' },
  { date: '07-04', localName: 'Independence Day',  name: 'Independence Day' },
  { date: '10-31', localName: 'Halloween',         name: 'Halloween' },
  { date: '11-11', localName: 'Veterans Day',      name: 'Veterans Day' },
  { date: '12-24', localName: 'Christmas Eve',     name: 'Christmas Eve' },
  { date: '12-25', localName: 'Christmas Day',     name: 'Christmas Day' },
  { date: '12-31', localName: "New Year's Eve",    name: "New Year's Eve" },
]

function offlineUS(year: number): HolidayItem[] {
  return FIXED_US.map((h) => ({
    date: `${year}-${h.date}`,
    localName: h.localName,
    name: h.name,
    countryCode: 'US',
  }))
}

async function fetchNager(country: string, year: number): Promise<HolidayItem[] | null> {
  try {
    const res = await fetch(`${NAGER_API}/${year}/${country}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'MaiPaiHome/3' },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const payload = (await res.json()) as Array<Record<string, unknown>>
    if (!Array.isArray(payload)) return null
    return payload
      .map((item) => ({
        date: String(item.date ?? ''),
        localName: String(item.localName || item.name || ''),
        name: String(item.name || item.localName || ''),
        countryCode: String(item.countryCode ?? country),
      }))
      .filter((h) => h.date && h.localName)
  } catch {
    return null
  }
}

const holidaysRoute = new Hono<AppEnv>()

// GET /api/holidays?country=US&year=2025
holidaysRoute.get('/', requireAuth, async (c) => {
  const country = (c.req.query('country') ?? 'US').toUpperCase().trim() || 'US'
  const yearParam = c.req.query('year')
  const year = yearParam ? Number(yearParam) : new Date().getFullYear()
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return c.json({ error: 'Invalid year' }, 400)
  }

  const cacheKey = `${country}-${year}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt) {
    return c.json({ holidays: cached.holidays, country, year, offline: cached.offline })
  }

  const nager = await fetchNager(country, year)
  if (nager) {
    const entry: CacheEntry = { holidays: nager, offline: false, expiresAt: Date.now() + TTL_MS }
    cache.set(cacheKey, entry)
    return c.json({ holidays: nager, country, year, offline: false })
  }

  // Degrade to offline table for US only
  if (country === 'US') {
    const fallback = offlineUS(year)
    const entry: CacheEntry = { holidays: fallback, offline: true, expiresAt: Date.now() + TTL_MS }
    cache.set(cacheKey, entry)
    return c.json({ holidays: fallback, country, year, offline: true })
  }

  return c.json({ holidays: [], country, year, offline: true, error: 'Unavailable offline for this country' })
})

export { holidaysRoute }
