import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'
import { jokesTool } from '@/tools/jokes'

const jokesDedicatedRoute = new Hono<AppEnv>()

interface JokeCache {
  joke: string
  dateKey: string
}

const cache = new Map<string, JokeCache>()

function todayKey(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

// GET /api/jokes -- returns the same joke all day (date-keyed cache)
jokesDedicatedRoute.get('/', requireAuth, async (c) => {
  const key = todayKey()
  const entry = cache.get('joke')
  if (entry && entry.dateKey === key) {
    return c.json({ joke: entry.joke })
  }

  const result = await jokesTool.execute(null)
  if (!result.success || !result.data) {
    return c.json({ joke: null, error: 'unavailable' })
  }

  const joke = (result.data as { joke: string }).joke
  cache.set('joke', { joke, dateKey: key })
  return c.json({ joke })
})

// GET /api/jokes/fresh -- always returns a fresh joke, no caching
jokesDedicatedRoute.get('/fresh', requireAuth, async (c) => {
  const result = await jokesTool.execute(null)
  if (!result.success || !result.data) {
    return c.json({ joke: null, error: 'unavailable' })
  }

  const joke = (result.data as { joke: string }).joke
  return c.json({ joke })
})

export { jokesDedicatedRoute }
