import { Hono } from 'hono'
import { tvShowsTool } from '@/tools/tvshows'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'

const tvShowsRoute = new Hono<AppEnv>()

tvShowsRoute.get('/', requireAuth, async (c) => {
  const q = c.req.query('q')?.trim()
  if (!q) return c.json({ error: 'Query param q is required' }, 400)

  const result = await tvShowsTool.execute({ query: q })
  if (!result.success) {
    return c.json({ error: result.error ?? 'Search failed' }, result.offline ? 503 : 500)
  }

  return c.json(result.data)
})

export { tvShowsRoute }
