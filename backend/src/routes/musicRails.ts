// Made For You rails + Replay recap. Thin wrapper over lib/music/rails (all the SQL,
// caching, and advisory filtering live there).

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { buildRails, buildReplay } from '@/lib/music/rails'
import { familyEntrySetsFor, filterTracksBySets } from '@/lib/family/audioPolicy'
import type { AppEnv } from '@/types'

export const musicRails = new Hono<AppEnv>()
musicRails.use('*', requireAuth)

// GET /api/music/rails — the user's personalized shelves for the Listen page.
// Family audio: allowlist-only profiles get no suggestion rails at all (the rails ARE
// the open catalog); blocklisted artists drop out of everyone else's shelves.
musicRails.get('/', async (c) => {
  const user = c.get('user')
  const sets = await familyEntrySetsFor(user.id)
  if (sets.allowlistOnly) return c.json({ rails: [] })
  const rails = await buildRails(user.id)
  if (!sets.hasAny) return c.json({ rails })
  return c.json({
    rails: rails
      .map(r => ({ ...r, tracks: filterTracksBySets(sets, r.tracks) }))
      .filter(r => r.tracks.length > 0),
  })
})

// GET /api/music/rails/replay?year=2026 — the year-in-review recap.
musicRails.get('/replay', (c) => {
  const user = c.get('user')
  const yearRaw = c.req.query('year')
  const year = yearRaw && /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : new Date().getFullYear()
  return c.json(buildReplay(user.id, year))
})
