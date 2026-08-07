import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { lookupTitle } from '@/lib/titles/streaming'
import type { AppEnv } from '@/types'

/**
 * Film metadata by title, for the video apps.
 *
 * YouTube's free movies carry junk titles: "FULL MOVIE | Action 2026 | Tom
 * Hardy, ...", ALL CAPS, actor lists, upload years. The apps clean those
 * down to a probable title and ask here for the real thing, so a film shows
 * its OFFICIAL synopsis, year, runtime, certificate and poster instead of
 * whatever the uploader typed in the description.
 *
 * JustWatch (via lookupTitle) is the source: it is already this hub's
 * primary movie metadata provider and needs no key.
 */
const titlesRoute = new Hono<AppEnv>()

const CACHE_TTL = 24 * 60 * 60_000
const cache = new Map<string, { data: unknown; expiresAt: number }>()

titlesRoute.get('/lookup', requireAuth, async (c) => {
  const title = (c.req.query('title') ?? '').trim()
  const year = (c.req.query('year') ?? '').trim()
  const type = c.req.query('type') === 'show' ? 'SHOW' : 'MOVIE'
  if (!title) return c.json({ error: 'title is required' }, 400)

  // Year sharpens the match when the cleaned title is generic ("Rampage").
  const query = year ? `${title} ${year}` : title
  const key = `${type}:${query.toLowerCase()}`
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) return c.json(hit.data)

  const found = await lookupTitle(query, type)
  const payload = found?.found
    ? {
        found: true,
        title: found.title,
        year: found.year,
        description: found.shortDescription,
        certificate: found.ageCertification,
        runtimeMinutes: found.runtimeMinutes,
        posterUrl: found.posterUrl,
        cast: found.cast.slice(0, 8).map(m => m.name).filter(Boolean),
        directors: found.directors,
        score: found.scoring,
      }
    : { found: false, title, year: year || null }

  cache.set(key, { data: payload, expiresAt: Date.now() + CACHE_TTL })
  return c.json(payload)
})

export { titlesRoute }
