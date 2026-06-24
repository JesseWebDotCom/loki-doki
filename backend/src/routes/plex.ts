// Plex API for the Shows + Movies apps. All endpoints degrade gracefully to "not
// configured / not present" when no Plex server is set up, so the frontend can always call
// them and just hide the Plex affordances when absent.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { getPlexConnection, plexStatus, findInPlex, recentlyAdded, addToPlexWatchlist } from '@/lib/plex'
import type { AppEnv } from '@/types'

const plexRoute = new Hono<AppEnv>()
plexRoute.use('*', requireAuth)

plexRoute.get('/status', async (c) => {
  const conn = await getPlexConnection()
  if (!conn) return c.json({ configured: false, ok: false, serverName: null })
  const status = await plexStatus(conn)
  return c.json({ configured: true, ...status })
})

plexRoute.get('/find', async (c) => {
  const conn = await getPlexConnection()
  const type = c.req.query('type') === 'movie' ? 'movie' : 'show'
  const title = c.req.query('title')?.trim()
  if (!conn || !title) {
    return c.json({ present: false, ratingKey: null, title: null, year: null, type: null, deepLink: null, guids: [] })
  }
  const yearRaw = c.req.query('year')
  const tvdbRaw = c.req.query('tvdb')
  const match = await findInPlex(conn, {
    type,
    title,
    year: yearRaw && /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null,
    imdb: c.req.query('imdb') ?? null,
    tvdb: tvdbRaw && /^\d+$/.test(tvdbRaw) ? Number(tvdbRaw) : null,
  })
  return c.json(match)
})

plexRoute.get('/recent', async (c) => {
  const conn = await getPlexConnection()
  if (!conn) return c.json({ items: [] })
  const items = await recentlyAdded(conn, 20)
  return c.json({ items })
})

plexRoute.post('/watchlist', async (c) => {
  const conn = await getPlexConnection()
  if (!conn) return c.json({ ok: false, error: 'Plex not configured' }, 400)
  const body = (await c.req.json().catch(() => ({}))) as { plexGuid?: string }
  const plexGuid = (body.plexGuid ?? '').trim()
  if (!plexGuid) return c.json({ ok: false, error: 'plexGuid is required' }, 400)
  const ok = await addToPlexWatchlist(conn, plexGuid)
  return c.json({ ok })
})

export { plexRoute }
