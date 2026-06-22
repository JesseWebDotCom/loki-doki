import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { isOffline } from '@/lib/connectivity'
import type { AppEnv } from '@/types'
import { sportsToday, DEFAULT_LEAGUES, type LeagueRef } from '@/lib/briefing/sources/sports'

const sportsRoute = new Hono<AppEnv>()

interface GameItem {
  title: string
}

const cache = new Map<string, { items: GameItem[]; expiresAt: number }>()
const TTL_MS = 15 * 60 * 1000

// Map query param values to LeagueRef entries
const LEAGUE_MAP: Record<string, LeagueRef> = {
  'mlb':       { key: 'MLB',       path: 'baseball/mlb' },
  'nfl':       { key: 'NFL',       path: 'football/nfl' },
  'nba':       { key: 'NBA',       path: 'basketball/nba' },
  'nhl':       { key: 'NHL',       path: 'hockey/nhl' },
  'mls':       { key: 'MLS',       path: 'soccer/usa.1' },
  'world-cup': { key: 'World Cup', path: 'soccer/fifa.world' },
}

// GET /api/sports?league=mlb|nfl|nba|nhl|mls|world-cup
sportsRoute.get('/', requireAuth, async (c) => {
  const user = c.get('user')
  if (await isOffline(user.id)) return c.json({ games: [], offline: true, league: null })

  const leagueParam = c.req.query('league') ?? null
  const cacheKey = leagueParam ?? 'all'

  const entry = cache.get(cacheKey)
  if (entry && Date.now() < entry.expiresAt) {
    return c.json({ games: entry.items, league: leagueParam })
  }

  const leagues: LeagueRef[] = leagueParam
    ? (LEAGUE_MAP[leagueParam] ? [LEAGUE_MAP[leagueParam]!] : DEFAULT_LEAGUES)
    : DEFAULT_LEAGUES

  const limit = leagueParam ? 12 : 8

  try {
    const raw = await sportsToday({ leagues, limit })
    const items: GameItem[] = raw.map((r) => ({ title: r.title }))
    cache.set(cacheKey, { items, expiresAt: Date.now() + TTL_MS })
    return c.json({ games: items, league: leagueParam })
  } catch {
    return c.json({ games: [], error: 'unavailable', league: leagueParam }, 200)
  }
})

export { sportsRoute }
