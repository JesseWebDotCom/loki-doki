// User-facing read of the ambient briefing (weather/news/sports/on-this-day) that already
// powers the companion's system-prompt injection. Same warm-cache read the companion route
// uses (backend/src/routes/companions.ts) — a synchronous Map lookup plus a fire-and-forget
// lazy warm, never an await on the request path.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { loadUserPrefs } from '@/lib/companionTurn'
import { getCachedBriefing } from '@/lib/briefing/cache'
import { ensureBriefingWarm, DEFAULT_BRIEFING_KEY } from '@/lib/briefing/refresh'
import type { AppEnv } from '@/types'

const briefing = new Hono<AppEnv>()

briefing.get('/', requireAuth, async (c) => {
  const user = c.get('user')
  const prefs = await loadUserPrefs(user.id)
  const storedLoc = prefs['user.location'] as { displayName?: string; lat?: number; lng?: number } | undefined
  const locStr = storedLoc?.displayName ?? null
  const key = locStr ?? DEFAULT_BRIEFING_KEY

  const entry = getCachedBriefing(key)
  ensureBriefingWarm(key, locStr ? { displayName: locStr, lat: storedLoc?.lat, lng: storedLoc?.lng } : null, user.id)

  if (!entry) return c.json({ payload: null, warming: true })
  return c.json({ payload: entry.payload, warming: false })
})

export { briefing }
