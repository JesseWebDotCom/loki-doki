import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'
import { whereToWatchTool } from '@/tools/whereToWatch'
import { resolveToolConfig } from '@/lib/toolConfig'

const whereToWatchRoute = new Hono<AppEnv>()

// 5-minute in-memory cache for popular/new results
interface CacheEntry {
  data: unknown
  expiresAt: number
}
const cache = new Map<string, CacheEntry>()
const TTL_MS = 5 * 60 * 1000

function getCached(key: string): unknown | null {
  const entry = cache.get(key)
  if (!entry || Date.now() > entry.expiresAt) return null
  return entry.data
}

function setCached(key: string, data: unknown): void {
  cache.set(key, { data, expiresAt: Date.now() + TTL_MS })
}

// GET /api/where-to-watch?q=<title>&mode=popular|new|lookup&country=US
whereToWatchRoute.get('/', requireAuth, async (c) => {
  const q = (c.req.query('q') ?? '').trim()
  const country = (c.req.query('country') ?? 'US').toUpperCase().trim() || 'US'
  const modeParam = c.req.query('mode') ?? 'popular'
  const mode = q ? 'lookup' : (modeParam === 'new' ? 'new' : 'popular')

  // Only cache browse (popular/new) results, not per-title lookups
  if (!q) {
    const cacheKey = `${mode}:${country}`
    const cached = getCached(cacheKey)
    if (cached) return c.json(cached)
  }

  try {
    const user = c.get('user')
    const toolConfig = await resolveToolConfig('where-to-watch', user.id)
    toolConfig['_userId'] = user.id
    toolConfig['country'] = country
    const result = await whereToWatchTool.execute({ mode, query: q || undefined }, toolConfig)
    if (!result.success) {
      return c.json({ items: [], error: 'unavailable' })
    }
    const data = result.data as Record<string, unknown>

    if (!q) {
      const cacheKey = `${mode}:${country}`
      setCached(cacheKey, data)
    }

    return c.json(data)
  } catch {
    return c.json({ items: [], error: 'unavailable' })
  }
})

export { whereToWatchRoute }
