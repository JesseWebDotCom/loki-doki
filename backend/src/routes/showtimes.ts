import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'
import { cachedLookup } from '@/lib/lookupCache'
import { fetchShowtimes, isUsZipCode, showtimesTodayIso } from '@/tools/showtimes'

const THREE_HOURS_MS = 3 * 60 * 60 * 1000

const showtimesRoute = new Hono<AppEnv>()

// GET /api/showtimes?zip=78701[&date=YYYY-MM-DD] — backs the Showtimes page.
showtimesRoute.get('/', requireAuth, async (c) => {
  const zip = c.req.query('zip')?.trim() ?? ''
  if (!isUsZipCode(zip)) return c.json({ error: 'A 5-digit US ZIP code is required' }, 400)
  const date = c.req.query('date')?.trim() || showtimesTodayIso()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'Invalid date' }, 400)

  try {
    const data = await cachedLookup('showtimes', `${zip}:${date}`, THREE_HOURS_MS, () => fetchShowtimes(zip, date))
    if (!data) return c.json({ zip, date, theater_count: 0, movies: [], source_url: '' })
    return c.json(data)
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return c.json({ error: 'Showtimes are unavailable right now' }, 504)
    }
    return c.json({ error: String(err) }, 500)
  }
})

export { showtimesRoute }
