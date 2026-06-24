// Feeds poller: conditional-GET fetch, per-host throttle, dedup-upsert, prune.
// Modeled on youtube/feed.ts (overlap guard, bounded concurrency, stale loop) with
// added ETag/Last-Modified conditional GET and per-host spacing for user feeds.
//
// Saved items are promoted into bookmarks (a separate permanent store), so feed_items
// can be pruned freely here — no "never delete saved" carve-out.

import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { feeds, feedItems } from '@/db/schema'
import { logger } from '@/lib/logger'
import { parseFeedXml, type ParsedEntry } from '@/lib/feeds/parse'
import { googleNewsSearch } from '@/lib/briefing/sources/rss'

const UA = 'Mozilla/5.0 (compatible; LokiDoki/1.0)'
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

async function upsertEntries(feed: Feed, entries: ParsedEntry[]): Promise<number> {
  if (!entries.length) return 0
  const guids = entries.map((e) => e.guid)
  const known = await db.select({ guid: feedItems.guid }).from(feedItems)
    .where(and(eq(feedItems.feedId, feed.id), inArray(feedItems.guid, guids)))
  const knownSet = new Set(known.map((r) => r.guid))
  const fresh = entries.filter((e) => !knownSet.has(e.guid))
  if (!fresh.length) return 0

  const now = new Date()
  await db.insert(feedItems).values(fresh.map((e) => ({
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
  }))).onConflictDoNothing()
  return fresh.length
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
    const n = await upsertEntries(feed, entries)
    await prune(feed.id)
    await db.update(feeds).set({ lastFetchedAt: now, lastError: null }).where(eq(feeds.id, feed.id))
    return n
  }

  if (!feed.url) return 0
  await hostThrottle(feed.url)

  const headers: Record<string, string> = { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' }
  if (feed.etag) headers['If-None-Match'] = feed.etag
  if (feed.lastModified) headers['If-Modified-Since'] = feed.lastModified

  const res = await fetch(feed.url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (res.status === 304) {
    await db.update(feeds).set({ lastFetchedAt: now, lastError: null }).where(eq(feeds.id, feed.id))
    return 0
  }
  if (!res.ok) throw new Error(`feed ${res.status} for ${feed.url}`)

  const xml = await res.text()
  const parsed = parseFeedXml(xml)
  const n = await upsertEntries(feed, parsed.entries)
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

  return n
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
