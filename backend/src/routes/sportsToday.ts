import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { isOffline } from '@/lib/connectivity'
import type { AppEnv } from '@/types'
import { sportsToday, DEFAULT_LEAGUES } from '@/lib/briefing/sources/sports'

const sportsTodayRoute = new Hono<AppEnv>()

interface GameItem {
  title: string
}

const cache = new Map<string, { items: GameItem[]; expiresAt: number }>()
const TTL_MS = 15 * 60 * 1000

// GET /api/sports/today
sportsTodayRoute.get('/', requireAuth, async (c) => {
  const user = c.get('user')
  if (await isOffline(user.id)) return c.json({ games: [], offline: true })

  const entry = cache.get('sports')
  if (entry && Date.now() < entry.expiresAt) {
    return c.json({ games: entry.items })
  }

  try {
    const raw = await sportsToday({ leagues: DEFAULT_LEAGUES, limit: 8 })
    const items: GameItem[] = raw.map((r) => ({ title: r.title }))
    cache.set('sports', { items, expiresAt: Date.now() + TTL_MS })
    return c.json({ games: items })
  } catch {
    return c.json({ games: [], error: 'unavailable' }, 200)
  }
})

export { sportsTodayRoute }
