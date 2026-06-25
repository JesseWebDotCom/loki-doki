import { Hono } from 'hono'
import { and, desc, eq, isNull, or } from 'drizzle-orm'
import { db } from '@/db'
import { feeds, feedItems, feedFolders, userPreferences } from '@/db/schema'
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

const HIDDEN_KEY = 'news.hidden_categories'

// ── Category model ──────────────────────────────────────────────────────────────
// A News category is a feed_folders row. userId=null → shared/built-in (visible to all);
// slug ('global'|'local') marks the fixed built-ins; locked built-ins aren't feed-editable.
type CategoryKind = 'builtin' | 'shared' | 'personal'

function categoryKind(f: { userId: string | null; slug: string | null }, userId: string): CategoryKind {
  if (f.userId === userId) return 'personal'
  return f.slug ? 'builtin' : 'shared'
}

async function hiddenSet(userId: string): Promise<Set<string>> {
  const [row] = await db.select({ value: userPreferences.value }).from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, HIDDEN_KEY))).limit(1)
  if (!row) return new Set()
  try { return new Set(JSON.parse(row.value) as string[]) } catch { return new Set() }
}

async function setHidden(userId: string, ids: Set<string>): Promise<void> {
  const now = new Date()
  const value = JSON.stringify([...ids])
  await db.insert(userPreferences)
    .values({ id: crypto.randomUUID(), userId, key: HIDDEN_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: [userPreferences.userId, userPreferences.key], set: { value, updatedAt: now } })
}

// Categories visible to a user (built-ins + shared + own personal), ordered
// built-ins → shared → personal. Sort within each group by sortOrder then name.
async function visibleCategories(userId: string) {
  const rows = await db.select().from(feedFolders)
    .where(or(isNull(feedFolders.userId), eq(feedFolders.userId, userId)))
  const rank: Record<CategoryKind, number> = { builtin: 0, shared: 1, personal: 2 }
  return rows
    .map((f) => ({ ...f, kind: categoryKind(f, userId) }))
    .sort((a, b) => rank[a.kind] - rank[b.kind] || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
}

// ── Items ────────────────────────────────────────────────────────────────────────

// Stale-while-revalidate cache: serve stale immediately and refresh in background.
const cache = new Map<string, { items: NewsItem[]; expiresAt: number }>()
const TTL_MS = 15 * 60 * 1000

function getCacheEntry(key: string): { items: NewsItem[]; fresh: boolean } | null {
  const entry = cache.get(key)
  if (!entry) return null
  return { items: entry.items, fresh: Date.now() <= entry.expiresAt }
}

function setCached(key: string, items: NewsItem[]): void {
  // Never pin an empty result — a newly-created category whose feeds haven't polled yet
  // would otherwise stay "empty" for the whole TTL even after items arrive.
  if (!items.length) { cache.delete(key); return }
  cache.set(key, { items, expiresAt: Date.now() + TTL_MS })
}

// Items for a feed-backed category (the curated News store), deduped by title.
async function itemsFromFolder(folderId: string, limit: number): Promise<NewsItem[]> {
  const folderFeeds = await db.select({ id: feeds.id, title: feeds.title })
    .from(feeds).where(eq(feeds.folderId, folderId))
  if (folderFeeds.length === 0) return []

  // Fetch top `limit` items per feed (sorted newest-first), then round-robin interleave.
  // Pure date-sort would crowd out any feed whose articles are older than the others.
  type Row = { it: typeof feedItems.$inferSelect; feedTitle: string | null }
  const buckets: Row[][] = []
  for (const feed of folderFeeds) {
    const rows = await db.select({ it: feedItems })
      .from(feedItems)
      .where(eq(feedItems.feedId, feed.id))
      .orderBy(desc(feedItems.publishedAt), desc(feedItems.fetchedAt))
      .limit(limit)
    buckets.push(rows.map((r) => ({ it: r.it, feedTitle: feed.title })))
  }

  // Interleave: pick item[0] from each bucket, then item[1], etc.
  const maxLen = Math.max(...buckets.map((b) => b.length))
  const merged: Row[] = []
  for (let i = 0; i < maxLen; i++) {
    for (const bucket of buckets) { if (bucket[i]) merged.push(bucket[i]) }
  }

  const items: NewsItem[] = []
  const seen = new Set<string>()
  for (const r of merged) {
    const title = r.it.title
    if (!title) continue
    const key = title.toLowerCase().slice(0, 60)
    if (seen.has(key)) continue
    seen.add(key)
    items.push({
      title, url: r.it.url ?? undefined, source: r.feedTitle ?? undefined,
      summary: r.it.summary ?? undefined, imageUrl: r.it.imageUrl ?? undefined,
      publishedAt: r.it.publishedAt ?? undefined,
    })
    if (items.length >= limit) break
  }
  return items
}

// Town-aware local news via the Patch source (no feed rows — fetched live).
async function localItems(limit: number): Promise<NewsItem[]> {
  const s = await getBriefingSettings()
  const slug = s.patchSlug ?? (await resolvePatchSlug(s.defaultLocation))
  const townLabel = s.defaultLocation
  const result = await patchLocal({ slug, townLabel, limit }, 6000)
  return result.news.map((r) => ({
    title: r.title, url: r.url, detail: r.detail,
    summary: r.summary, imageUrl: r.imageUrl, publishedAt: r.publishedAt,
  }))
}

// Resolve items for any category. Built-in 'local' → Patch; built-in 'global' falls back to a
// live fetch when the store is still empty (fresh boot). Everything else → its folder's items.
async function categoryItems(cat: { id: string; slug: string | null }, limit: number): Promise<NewsItem[]> {
  if (cat.slug === 'local') {
    const items = await localItems(limit)
    setCached(`cat-${cat.id}-${limit}`, items)
    return items
  }
  let items = await itemsFromFolder(cat.id, limit)
  if (!items.length && cat.slug === 'global') {
    const raw = await worldHeadlines(limit, 6000)
    items = raw.map((r) => ({ title: r.title, url: r.url, source: r.source, summary: r.summary, imageUrl: r.imageUrl, publishedAt: r.publishedAt }))
  }
  setCached(`cat-${cat.id}-${limit}`, items)
  enrichOgImages(items).catch(() => {})
  return items
}

// ── Routes ─────────────────────────────────────────────────────────────────────

// GET /api/news/categories → tabs for the News app (built-ins + shared + personal).
news.get('/categories', requireAuth, async (c) => {
  const user = c.get('user')
  const [cats, hidden] = await Promise.all([visibleCategories(user.id), hiddenSet(user.id)])
  return c.json({
    categories: cats.map((f) => ({
      id: f.id,
      name: f.name,
      slug: f.slug ?? null,
      kind: f.kind,
      locked: !!f.locked,
      editable: f.kind === 'personal',
      hidden: hidden.has(f.id),
    })),
  })
})

// GET /api/news/categories/:id/items
news.get('/categories/:id/items', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 30)

  const cat = await db.select().from(feedFolders)
    .where(and(eq(feedFolders.id, id), or(isNull(feedFolders.userId), eq(feedFolders.userId, user.id)))).then((r) => r[0])
  if (!cat) return c.json({ error: 'Not found' }, 404)

  if (await isOffline(user.id)) return c.json({ items: [], offline: true })

  const cacheKey = `cat-${id}-${limit}`
  const entry = getCacheEntry(cacheKey)
  if (entry) {
    if (!entry.fresh) categoryItems(cat, limit).catch(() => {})
    return c.json({ items: entry.items })
  }
  try {
    return c.json({ items: await categoryItems(cat, limit) })
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.message.includes('timed out'))
    return c.json({ items: [], error: isTimeout ? 'offline' : 'unavailable' }, 200)
  }
})

// POST /api/news/categories/:id/hide  &  /unhide — per-user tab visibility.
news.post('/categories/:id/hide', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const set = await hiddenSet(user.id)
  set.add(id)
  await setHidden(user.id, set)
  return c.json({ ok: true })
})

news.post('/categories/:id/unhide', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const set = await hiddenSet(user.id)
  set.delete(id)
  await setHidden(user.id, set)
  return c.json({ ok: true })
})

// ── Legacy endpoint (HomePage Today widgets) ─────────────────────────────────────
// GET /api/news?type=world|local — kept for the home highlights. 'world' = the Global
// built-in category; 'local' = Patch.
news.get('/', requireAuth, async (c) => {
  const user = c.get('user')
  const type = c.req.query('type') === 'local' ? 'local' : 'world'
  const limit = Math.min(Number(c.req.query('limit') ?? 10), 20)

  if (await isOffline(user.id)) return c.json({ items: [], type, offline: true })

  try {
    const slug = type === 'local' ? 'local' : 'global'
    const folder = await db.select().from(feedFolders).where(eq(feedFolders.slug, slug)).then((r) => r[0])
    if (folder) {
      // Route through the cached category path (stale-while-revalidate) for parity.
      const cacheKey = `cat-${folder.id}-${limit}`
      const entry = getCacheEntry(cacheKey)
      if (entry) {
        if (!entry.fresh) categoryItems(folder, limit).catch(() => {})
        return c.json({ items: entry.items, type })
      }
      return c.json({ items: await categoryItems(folder, limit), type })
    }
    // Pre-seed fallback (folder not created yet): live world headlines / Patch.
    const items = type === 'local'
      ? await localItems(limit)
      : (await worldHeadlines(limit, 6000)).map((r) => ({ title: r.title, url: r.url, source: r.source, summary: r.summary, imageUrl: r.imageUrl, publishedAt: r.publishedAt }))
    return c.json({ items, type })
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.message.includes('timed out'))
    return c.json({ items: [], type, error: isTimeout ? 'offline' : 'unavailable' }, 200)
  }
})

export { news }
