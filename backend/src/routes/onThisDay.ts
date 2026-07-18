import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { isOffline } from '@/lib/connectivity'
import type { AppEnv } from '@/types'
import { onThisDay } from '@/lib/briefing/sources/onThisDay'

const onThisDayRoute = new Hono<AppEnv>()

interface OtdItem {
  title: string
}

interface OtdResponse {
  events: OtdItem[]
  births: OtdItem[]
  deaths: OtdItem[]
  month: number
  day: number
}

// Cache keyed by "MM-DD" — stays valid all day.
const cache = new Map<string, { data: OtdResponse; dateKey: string }>()

function todayKey(): string {
  const now = new Date()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${m}-${d}`
}

function getCached(): OtdResponse | null {
  const key = todayKey()
  const entry = cache.get('otd')
  if (!entry || entry.dateKey !== key) return null
  return entry.data
}

function setCached(data: OtdResponse): void {
  cache.set('otd', { data, dateKey: todayKey() })
}

// GET /api/on-this-day
onThisDayRoute.get('/', requireAuth, async (c) => {
  const user = c.get('user')
  if (await isOffline(user.id)) {
    const now = new Date()
    return c.json({ events: [], births: [], deaths: [], month: now.getMonth() + 1, day: now.getDate(), offline: true })
  }

  // Content is stable for the calendar day; let the browser reuse it for an hour
  // (private: responses ride the session cookie).
  c.header('Cache-Control', 'private, max-age=3600')
  const cached = getCached()
  if (cached) return c.json(cached)

  const now = new Date()
  const month = now.getMonth() + 1
  const day = now.getDate()

  try {
    const [events, births, deaths] = await Promise.all([
      onThisDay({ month, day, limit: 12, feed: 'selected' }).catch(() => []),
      onThisDay({ month, day, limit: 12, feed: 'births' }).catch(() => []),
      onThisDay({ month, day, limit: 12, feed: 'deaths' }).catch(() => []),
    ])

    const data: OtdResponse = {
      events: events.map((e) => ({ title: e.title })),
      births: births.map((e) => ({ title: e.title })),
      deaths: deaths.map((e) => ({ title: e.title })),
      month,
      day,
    }

    setCached(data)
    return c.json(data)
  } catch {
    return c.json({ events: [], births: [], deaths: [], month, day, error: 'unavailable' }, 200)
  }
})

export { onThisDayRoute }
