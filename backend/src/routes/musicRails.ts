// Made For You rails + Replay recap. Thin wrapper over lib/music/rails (all the SQL,
// caching, and advisory filtering live there).

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { buildRails, buildReplay } from '@/lib/music/rails'
import type { AppEnv } from '@/types'

export const musicRails = new Hono<AppEnv>()
musicRails.use('*', requireAuth)

// GET /api/music/rails — the user's personalized shelves for the Listen page.
musicRails.get('/', async (c) => {
  const user = c.get('user')
  return c.json({ rails: await buildRails(user.id) })
})

// GET /api/music/rails/replay?year=2026 — the year-in-review recap.
musicRails.get('/replay', (c) => {
  const user = c.get('user')
  const yearRaw = c.req.query('year')
  const year = yearRaw && /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : new Date().getFullYear()
  return c.json(buildReplay(user.id, year))
})
