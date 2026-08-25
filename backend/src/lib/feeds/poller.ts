// Feeds poller: conditional-GET fetch, per-host throttle, dedup-upsert, prune.
// Modeled on youtube/feed.ts (overlap guard, bounded concurrency, stale loop) with
// added ETag/Last-Modified conditional GET and per-host spacing for user feeds.
//
// Saved items are promoted into bookmarks (a separate permanent store), so feed_items
// can be pruned freely here — no "never delete saved" carve-out.

import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { feeds, feedItems } from '@/db/schema'
import { logger } from '@/lib/logger'
import { parseFeedXml, type ParsedEntry } from '@/lib/feeds/parse'
import { safeFetch } from '@/lib/ssrfGuard'
import { googleNewsSearch } from '@/lib/briefing/sources/rss'
import { prefetchFeedItemContent } from '@/lib/feeds/contentQuality'

const UA = 'Mozilla/5.0 (compatible; MaiPaiHome/1.0)'
const FETCH_TIMEOUT_MS = 10_000
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000
const MIN_HOST_GAP_MS = 1500
const FEED_CONCURRENCY = 4
const KEEP_PER_FEED = 200

type Feed = typeof feeds.$inferSelect

const lastHostFetch = new Map<string, number>()
async function hostThrottle(url: string): Promise<void> {
  let host: string
  try { host = new URL(url).host } catch { return }
  const last = lastHostFetch.get(host) ?? 0
  const wait = MIN_HOST_GAP_MS - (Date.now() - last)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastHostFetch.set(host, Date.now())
}

/** Returns the ids of newly-inserted items (empty when everything was already known). */
async function upsertEntries(feed: Feed, entries: ParsedEntry[]): Promise<string[]> {
  if (!entries.length) return []
  const guids = entries.map((e) => e.guid)
  const known = await db.select({ guid: feedItems.guid, id: feedItems.id, imageUrl: feedItems.imageUrl })
    .from(feedItems).where(and(eq(feedItems.feedId, feed.id), inArray(feedItems.guid, guids)))
  const knownMap = new Map(known.map((r) => [r.guid, r]))
  const fresh = entries.filter((e) => !knownMap.has(e.guid))

  // Back-fill imageUrl for existing items that were stored before the img-in-content fallback.
  const toBackfill = entries.filter((e) => {
    const row = knownMap.get(e.guid)
    return row && !row.imageUrl && e.imageUrl
  })
  for (const e of toBackfill) {
    const row = knownMap.get(e.guid)!
    await db.update(feedItems).set({ imageUrl: e.imageUrl }).where(and(eq(feedItems.id, row.id), isNull(feedItems.imageUrl)))
  }

  if (!fresh.length) return []

  const now = new Date()
  const rows = fresh.map((e) => ({
    id: crypto.randomUUID(),
    feedId: feed.id,
    guid: e.guid,
    title: e.title,
    url: e.url,
    author: e.author,
    summary: e.summary,
    contentHtml: e.contentHtml,
    imageUrl: e.imageUrl,
    publishedAt: e.publishedAt,
    fetchedAt: now,
  }))
  await db.insert(feedItems).values(rows).onConflictDoNothing()
  return rows.map((r) => r.id)
}

async function prune(feedId: string): Promise<void> {
  const rows = await db.select({ id: feedItems.id }).from(feedItems)
    .where(eq(feedItems.feedId, feedId))
    .orderBy(desc(feedItems.publishedAt), desc(feedItems.fetchedAt))
  if (rows.length <= KEEP_PER_FEED) return
  const overflow = rows.slice(KEEP_PER_FEED).map((r) => r.id)
  // Delete in chunks to stay under SQLite's bound-variable limit.
  for (let i = 0; i < overflow.length; i += 400) {
    await db.delete(feedItems).where(inArray(feedItems.id, overflow.slice(i, i + 400)))
  }
}

/** Fetch one feed (conditional GET), upsert new items, prune. Returns # new items. */
export async function fetchAndUpsertFeed(feed: Feed): Promise<number> {
  const now = new Date()

  // Marker feeds ('system:' urls) are written by app code, never fetched here - e.g. the
  // Local blend history feed (lib/news/localStore.ts), which routes/news.ts fills itself.
  if (feed.url?.startsWith('system:')) return 0

  // Saved-search feeds resolve through Google News rather than a stored URL.
  if (feed.kind === 'search') {
    if (!feed.query) return 0
    const results = await googleNewsSearch(feed.query, 25, FETCH_TIMEOUT_MS)
    const entries: ParsedEntry[] = results
      .filter((r) => r.url)
      .map((r) => ({
        guid: r.url!, title: r.title, url: r.url!, author: null,
        summary: r.summary ?? null, contentHtml: null, imageUrl: r.imageUrl ?? null,
        publishedAt: r.publishedAt ?? null,
      }))
    // No content prefetch here: Google News item URLs are redirect wrappers, not article pages.
    const newIds = await upsertEntries(feed, entries)
    await prune(feed.id)
    await db.update(feeds).set({ lastFetchedAt: now, lastError: null }).where(eq(feeds.id, feed.id))
    return newIds.length
  }

  if (!feed.url) return 0
  await hostThrottle(feed.url)

  const headers: Record<string, string> = { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' }
  if (feed.etag) headers['If-None-Match'] = feed.etag
  if (feed.lastModified) headers['If-Modified-Since'] = feed.lastModified

  const res = await safeFetch(feed.url, { headers }, { timeoutMs: FETCH_TIMEOUT_MS })
  if (res.status === 304) {
    await db.update(feeds).set({ lastFetchedAt: now, lastError: null }).where(eq(feeds.id, feed.id))
    return 0
  }
  if (!res.ok) throw new Error(`feed ${res.status} for ${feed.url}`)

  const xml = await res.text()
  const parsed = parseFeedXml(xml)
  const newIds = await upsertEntries(feed, parsed.entries)
  // Background: extract new articles' full content now so opening one is instant.
  if (newIds.length) prefetchFeedItemContent(newIds)
  // And park TL;DR generation for the newest few in the idle band, so the reader's
  // summary panel is warm by the time anyone opens the article. Persisted per item
  // (feed_items.ai_summary), so a re-poll never re-summarizes; capped per poll.
  if (newIds.length) {
    void import('@/lib/precompute').then(async (m) => {
      for (const id of newIds.slice(0, 5)) {
        await m.enqueuePrecompute(id, `Article summary (${feed.title || 'feed'})`, { kind: 'news-summary', itemId: id })
      }
    }).catch(() => {})
  }
  await prune(feed.id)

  const siteUrl = feed.siteUrl ?? parsed.siteUrl ?? null
  let faviconUrl = feed.faviconUrl
  if (!faviconUrl && siteUrl) { try { faviconUrl = `${new URL(siteUrl).origin}/favicon.ico` } catch { /* ignore */ } }

  await db.update(feeds).set({
    title: feed.title || parsed.title || feed.title,
    siteUrl,
    faviconUrl,
    etag: res.headers.get('etag') ?? feed.etag,
    lastModified: res.headers.get('last-modified') ?? feed.lastModified,
    lastFetchedAt: now,
    lastError: null,
  }).where(eq(feeds.id, feed.id))

  return newIds.length
}

async function fetchBounded(list: Feed[]): Promise<void> {
  for (let i = 0; i < list.length; i += FEED_CONCURRENCY) {
    await Promise.allSettled(list.slice(i, i + FEED_CONCURRENCY).map(async (feed) => {
      try {
        const n = await fetchAndUpsertFeed(feed)
        if (n > 0) logger.info(`[feeds] +${n} from "${feed.title || feed.url}"`)
      } catch (err) {
        await db.update(feeds).set({ lastError: String(err), lastFetchedAt: new Date() }).where(eq(feeds.id, feed.id)).catch(() => {})
        logger.warn(`[feeds] error for "${feed.title || feed.url}": ${err}`)
      }
    }))
  }
}

export async function refreshFeed(feedId: string): Promise<number> {
  const feed = await db.select().from(feeds).where(eq(feeds.id, feedId)).then((r) => r[0])
  if (!feed) return 0
  return fetchAndUpsertFeed(feed)
}

export async function refreshUserFeeds(userId: string): Promise<void> {
  const list = await db.select().from(feeds).where(eq(feeds.userId, userId))
  await fetchBounded(list)
}

export async function refreshSystemFeeds(): Promise<void> {
  const list = await db.select().from(feeds).where(eq(feeds.isSystem, true))
  await fetchBounded(list)
}

let _timer: ReturnType<typeof setInterval> | null = null
let _polling = false

export function startFeedPoller(): void {
  if (_timer) return
  _timer = setInterval(async () => {
    if (_polling) return
    _polling = true
    try {
      const all = await db.select().from(feeds)
      const stale = all.filter((f) => {
        const interval = (f.pollIntervalSec ? f.pollIntervalSec * 1000 : DEFAULT_INTERVAL_MS)
        return !f.lastFetchedAt || Date.now() - f.lastFetchedAt.getTime() > interval
      })
      await fetchBounded(stale)
    } catch (err) {
      logger.warn(`[feeds] poller error: ${err}`)
    } finally {
      _polling = false
    }
  }, 60_000) // wake every minute; per-feed interval gating decides what actually fetches
}
