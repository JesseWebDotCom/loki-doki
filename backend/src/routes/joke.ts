import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'

const jokeRoute = new Hono<AppEnv>()

interface JokeCache {
  joke: string
  dateKey: string
}

const cache = new Map<string, JokeCache>()

function todayKey(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

// GET /api/joke — returns the same joke all day (date-keyed cache)
jokeRoute.get('/', requireAuth, async (c) => {
  const key = todayKey()
  const entry = cache.get('joke')
  if (entry && entry.dateKey === key) {
    return c.json({ joke: entry.joke, date: key })
  }

  try {
    const res = await fetch('https://icanhazdadjoke.com/', {
      headers: { Accept: 'application/json', 'User-Agent': 'LokiDoki/1.0' },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`joke: ${res.status}`)
    const data = (await res.json()) as { joke?: string }
    const joke = data.joke?.trim()
    if (!joke) throw new Error('joke: empty')

    cache.set('joke', { joke, dateKey: key })
    return c.json({ joke, date: key })
  } catch {
    return c.json({ joke: null, date: key, error: 'unavailable' }, 200)
  }
})

export { jokeRoute }
