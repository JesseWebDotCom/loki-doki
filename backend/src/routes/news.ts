import { Hono } from 'hono'
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import { db } from '@/db'
import { feeds, feedItems, feedFolders, userPreferences } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { isOffline } from '@/lib/connectivity'
import type { AppEnv } from '@/types'
import { worldHeadlines } from '@/lib/briefing/sources/rss'
import { blendedLocalNews } from '@/lib/briefing/localNews'
import { getBriefingSettings } from '@/lib/briefing/settings'
import { resolvePatchSlug } from '@/lib/briefing/resolveSlug'
import { enrichOgImages } from '@/lib/ogImage'
import { OBITUARY_RE } from '@/lib/content/extract'
import { cachedExtractArticle } from '@/lib/content/extractCache'
import { stripHtml } from '@/lib/htmlText'
import { ensureUrlSummary } from '@/lib/news/summarize'
import { persistLocalItems, recentLocalItems } from '@/lib/news/localStore'

const news = new Hono<AppEnv>()

interface NewsItem {
  // Present only for items backed by a feedItems row (folder/category items); local/global
  // fallback headlines are fetched live and have no DB row to key an in-app reader off of -
  // those route through GET /article?url= instead (see below).
  id?: string
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

  // Take the top `limit` items per feed (sorted newest-first), then round-robin interleave.
  // Pure date-sort would crowd out any feed whose articles are older than the others.
  // One bulk query instead of one per feed (20-30 sequential queries for the global category);
  // the poller caps retention at 200 items/feed so the bulk fetch stays bounded, and the
  // per-feed top-`limit` cut happens in JS while grouping.
  type Row = { it: typeof feedItems.$inferSelect; feedTitle: string | null }
  const titleByFeedId = new Map(folderFeeds.map((f) => [f.id, f.title]))
  const allRows = await db.select()
    .from(feedItems)
    .where(inArray(feedItems.feedId, folderFeeds.map((f) => f.id)))
    .orderBy(desc(feedItems.publishedAt), desc(feedItems.fetchedAt))
  const bucketByFeedId = new Map<string, Row[]>(folderFeeds.map((f) => [f.id, []]))
  for (const it of allRows) {
    const bucket = bucketByFeedId.get(it.feedId)
    if (!bucket || bucket.length >= limit) continue
    bucket.push({ it, feedTitle: titleByFeedId.get(it.feedId) ?? null })
  }
  const buckets = [...bucketByFeedId.values()]

  // Interleave: pick item[0] from each bucket, then item[1], etc.
  const maxLen = Math.max(...buckets.map((b) => b.length))
  const merged: Row[] = []
  for (let i = 0; i < maxLen; i++) {
    for (const bucket of buckets) { const row = bucket[i]; if (row) merged.push(row) }
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
      id: r.it.id, title, url: r.it.url ?? undefined, source: r.feedTitle ?? undefined,
      summary: r.it.summary ?? undefined, imageUrl: r.it.imageUrl ?? undefined,
      publishedAt: r.it.publishedAt ?? undefined,
    })
    if (items.length >= limit) break
  }
  return items
}

// Town-aware local news — Patch + Daily Voice + Bing News RSS blend, fetched live and
// persisted into a hidden history feed (lib/news/localStore.ts) so the Local tab covers
// weeks, not just each source's current front page. Served as live items merged with the
// stored history, deduped, newest first.
async function localItems(limit: number): Promise<NewsItem[]> {
  const s = await getBriefingSettings()
  const slug = s.patchSlug ?? (await resolvePatchSlug(s.defaultLocation))
  const townLabel = s.defaultLocation
  // Over-ask the blend so the history store accumulates faster than any one page size;
  // the final slice below still honors the caller's limit.
  const { news } = await blendedLocalNews({ patchSlug: slug, townLabel, limit: Math.max(limit, 30) })
  await persistLocalItems(news)

  const live: NewsItem[] = news.map((r) => ({
    title: r.title, url: r.url, source: r.detail, detail: r.detail,
    summary: r.summary, imageUrl: r.imageUrl, publishedAt: r.publishedAt,
  }))
  const stored: NewsItem[] = (await recentLocalItems())
    .filter((r) => r.title)
    .map((r) => ({
      title: r.title!, url: r.url ?? undefined, source: r.author ?? undefined, detail: r.author ?? undefined,
      summary: r.summary ?? undefined, imageUrl: r.imageUrl ?? undefined, publishedAt: r.publishedAt ?? undefined,
    }))

  // Merge live-first (fresher fields win the dedupe), by url and by normalized title.
  const merged: NewsItem[] = []
  const seen = new Set<string>()
  for (const it of [...live, ...stored]) {
    const keys = [it.url, it.title.toLowerCase().slice(0, 60)].filter((k): k is string => !!k)
    if (keys.some((k) => seen.has(k))) continue
    for (const k of keys) seen.add(k)
    merged.push(it)
  }
  // Newest first; items with no date sink to the bottom.
  merged.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
  return merged.slice(0, limit)
}

// Resolve items for any category. Built-in 'local' → Patch; built-in 'global' falls back to a
// live fetch when the store is still empty (fresh boot). Everything else → its folder's items.
async function categoryItems(cat: { id: string; slug: string | null }, limit: number): Promise<NewsItem[]> {
  if (cat.slug === 'local') {
    const items = await localItems(limit)
    // Awaited (unlike the folder branch below): most local items are Google News RSS, which
    // carries NO image at all, so nearly every item needs this. Firing it in the background
    // meant the first response — the one both the server cache and the client's 5-min
    // staleTime latch onto — always shipped with placeholders that never got a chance to heal.
    await enrichOgImages(items).catch(() => {})
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
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100)

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

// Split sanitized reader HTML into clean plain-text paragraphs for clients that render
// text natively instead of HTML (the tvOS app). Block-element closers become breaks, tags
// are stripped and entities decoded (stripHtml), and empty/boilerplate-short fragments
// (stray credits, orphaned labels) are dropped.
function htmlToParagraphs(html: string): string[] {
  const broken = html
    .replace(/<\/(p|h[1-6]|li|blockquote|figcaption|pre|div|section|td|dt|dd)>/gi, '\n')
    .replace(/<(?:br|hr)\s*\/?>/gi, '\n')
  const out: string[] = []
  for (const raw of broken.split('\n')) {
    const text = stripHtml(raw)
    if (text.length < 12) continue
    out.push(text)
  }
  return out
}

// GET /api/news/article?url= — in-app reader content for headline items that have no
// feedItems row (local/global fallback headlines). Extraction goes through a small
// in-memory LRU (extractCache.ts) so the web reader, the TV client, and the summary
// endpoint share one extraction per url; nothing is persisted - these items aren't
// "yours" the way a subscribed feed item is.
//
// `?format=text` returns the same article as plain-text paragraphs (for the tvOS app,
// which renders text natively); the default HTML response is unchanged.
news.get('/article', requireAuth, async (c) => {
  const url = c.req.query('url')
  if (!url) return c.json({ error: 'Missing url' }, 400)
  const asText = c.req.query('format') === 'text'
  try {
    const a = await cachedExtractArticle(url)
    if (asText) {
      return c.json({
        title: a.title,
        byline: a.byline,
        siteName: a.siteName,
        readingMins: a.readingMins,
        source: a.source,
        paragraphs: a.contentHtml ? htmlToParagraphs(a.contentHtml) : [],
      })
    }
    return c.json({
      id: url,
      title: a.title,
      url,
      author: a.byline,
      siteName: a.siteName,
      contentHtml: a.contentHtml,
      readingMins: a.readingMins,
      isObituary: a.isObituary,
      readerSource: a.source,
      archiveUrl: a.archiveUrl,
    })
  } catch {
    if (asText) {
      return c.json({ title: null, byline: null, siteName: null, readingMins: 0, source: null, paragraphs: [] })
    }
    return c.json({ id: url, title: null, url, author: null, contentHtml: null, readingMins: 0, isObituary: OBITUARY_RE.test(url), readerSource: null, archiveUrl: null })
  }
})

// GET /api/news/article/summary?url= — AI TL;DR for a headline card's reader page, for
// items with no feedItems row (see /article above). Short-lived in-memory cache, not
// persisted - these headlines aren't "yours" the way a subscribed feed item is.
news.get('/article/summary', requireAuth, async (c) => {
  const url = c.req.query('url')
  if (!url) return c.json({ error: 'Missing url' }, 400)
  return c.json({ summary: await ensureUrlSummary(url) })
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
  const limit = Math.min(Number(c.req.query('limit') ?? 10), 60)

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
