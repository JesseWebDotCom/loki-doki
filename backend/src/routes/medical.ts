import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { medicalTool } from '@/tools/medical'
import type { AppEnv } from '@/types'

const medicalRoute = new Hono<AppEnv>()

interface AnswerPayload {
  gist: string
  highlights: string[]
  sources: string[]
  depth_available: boolean
}

interface CacheEntry {
  gist: string | null
  highlights: string[]
  sources: string[]
  depth_available: boolean
  offline: boolean
  error?: string
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()
const TTL_MS = 10 * 60 * 1000

medicalRoute.get('/', requireAuth, async (c) => {
  const q = c.req.query('q')?.trim()
  if (!q) return c.json({ gist: null, error: 'Query is required' }, 400)

  const key = q.toLowerCase()
  const cached = cache.get(key)
  if (cached && Date.now() < cached.expiresAt) {
    const { expiresAt: _exp, ...payload } = cached
    return c.json(payload)
  }

  const result = await medicalTool.execute({ query: q })

  if (!result.success || !result.data) {
    const entry: CacheEntry = {
      gist: null,
      highlights: [],
      sources: [],
      depth_available: false,
      offline: result.offline ?? false,
      error: 'unavailable',
      expiresAt: Date.now() + TTL_MS,
    }
    cache.set(key, entry)
    return c.json({ gist: null, error: 'unavailable' })
  }

  const payload = (result.data as { answer_payload: AnswerPayload }).answer_payload

  const entry: CacheEntry = {
    gist: payload?.gist ?? null,
    highlights: payload?.highlights ?? [],
    sources: payload?.sources ?? [],
    depth_available: payload?.depth_available ?? false,
    offline: result.offline ?? false,
    expiresAt: Date.now() + TTL_MS,
  }
  cache.set(key, entry)

  const { expiresAt: _exp, ...response } = entry
  return c.json(response)
})

export { medicalRoute }
