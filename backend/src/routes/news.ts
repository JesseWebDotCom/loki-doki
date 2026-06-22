import { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { feeds, feedItems } from '@/db/schema'
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

// World headlines now read from the unified feed store (curated News = system feeds),
// deduped by title. Falls back to a live fetch when the store is still empty (fresh boot,
// before the first poll completes) so News never shows blank.
async function worldFromStore(limit: number): Promise<NewsItem[]> {
  const rows = await db.select({ it: feedItems, feedTitle: feeds.title }).from(feedItems)
    .innerJoin(feeds, eq(feedItems.feedId, feeds.id))
    .where(eq(feeds.isSystem, true))
    .orderBy(desc(feedItems.publishedAt), desc(feedItems.fetchedAt))
    .limit(limit * 4)
  const items: NewsItem[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    const title = r.it.title
    if (!title) continue
    const key = title.toLowerCase().slice(0, 60)
    if (seen.has(key)) continue
    seen.add(key)
    items.push({
      title, url: r.it.url ?? undefined, source: r.feedTitle,
      summary: r.it.summary ?? undefined, imageUrl: r.it.imageUrl ?? undefined,
      publishedAt: r.it.publishedAt ?? undefined,
    })
    if (items.length >= limit) break
  }
  return items
}

async function fetchItems(type: string, limit: number, userId: string): Promise<NewsItem[]> {
  if (type === 'world') {
    let items = await worldFromStore(limit)
    if (!items.length) {
      // Store empty (pre-first-poll) → live fallback, same shape as before.
      const raw = await worldHeadlines(limit, 6000)
      items = raw.map((r) => ({ title: r.title, url: r.url, source: r.source, summary: r.summary, imageUrl: r.imageUrl, publishedAt: r.publishedAt }))
    }
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
