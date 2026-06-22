import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { isOffline } from '@/lib/connectivity'
import type { AppEnv } from '@/types'
import { worldHeadlines } from '@/lib/briefing/sources/rss'
import { patchLocal } from '@/lib/briefing/sources/patch'
import { getBriefingSettings } from '@/lib/briefing/settings'
import { resolvePatchSlug } from '@/lib/briefing/resolveSlug'
import { enrichOgImages } from '@/lib/ogImage'

const news = new Hono<AppEnv>()

interface NewsItem {
  title: string
  url?: string
  source?: string
  detail?: string
  imageUrl?: string
  summary?: string
  publishedAt?: number
}

// Stale-while-revalidate cache: serve stale immediately and refresh in background.
const cache = new Map<string, { items: NewsItem[]; expiresAt: number }>()
const TTL_MS = 15 * 60 * 1000

function getCacheEntry(key: string): { items: NewsItem[]; fresh: boolean } | null {
  const entry = cache.get(key)
  if (!entry) return null
  return { items: entry.items, fresh: Date.now() <= entry.expiresAt }
}

function setCached(key: string, items: NewsItem[]): void {
  cache.set(key, { items, expiresAt: Date.now() + TTL_MS })
}

async function fetchItems(type: string, limit: number, userId: string): Promise<NewsItem[]> {
  if (type === 'world') {
    const raw = await worldHeadlines(limit, 6000)
    const items: NewsItem[] = raw.map((r) => ({
      title: r.title,
      url: r.url,
      source: r.source,
      summary: r.summary,
      imageUrl: r.imageUrl,
      publishedAt: r.publishedAt,
    }))
    // Cache before enriching images so the response isn't blocked.
    // enrichOgImages mutates items in place, so the cached reference gets images too.
    const key = `${type}-${limit}`
    setCached(key, items)
    enrichOgImages(items).catch(() => {})
    return items
  } else {
    const s = await getBriefingSettings()
    const slug = s.patchSlug ?? (await resolvePatchSlug(s.defaultLocation))
    const townLabel = s.defaultLocation
    const result = await patchLocal({ slug, townLabel, limit }, 6000)
    const items: NewsItem[] = result.news.map((r) => ({
      title: r.title,
      url: r.url,
      detail: r.detail,
      summary: r.summary,
      imageUrl: r.imageUrl,
      publishedAt: r.publishedAt,
    }))
    setCached(`${type}-${limit}`, items)
    return items
  }
}

// GET /api/news?type=world|local
news.get('/', requireAuth, async (c) => {
  const user = c.get('user')
  const type = c.req.query('type') === 'local' ? 'local' : 'world'
  const limit = Math.min(Number(c.req.query('limit') ?? 10), 20)

  if (await isOffline(user.id)) return c.json({ items: [], type, offline: true })

  const cacheKey = `${type}-${limit}`
  const entry = getCacheEntry(cacheKey)
  if (entry) {
    if (!entry.fresh) {
      // Serve stale immediately, refresh in background
      fetchItems(type, limit, user.id).catch(() => {})
    }
    return c.json({ items: entry.items, type })
  }

  try {
    const items = await fetchItems(type, limit, user.id)
    return c.json({ items, type })
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.message.includes('timed out'))
    return c.json({ items: [], type, error: isTimeout ? 'offline' : 'unavailable' }, 200)
  }
})

export { news }
