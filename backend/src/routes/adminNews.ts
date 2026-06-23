// Admin management for shared News categories. A shared category is a feed_folders row with
// userId=null and slug=null (built-ins have a slug and are not editable here). Its feeds are
// userId=null, so they're auto-visible to every user via the feeds route's visibleWhere().

import { Hono } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { feeds, feedFolders } from '@/db/schema'
import { requireAdmin } from '@/middleware/auth'
import { discoverFeeds } from '@/lib/feeds/discover'
import { refreshFeed } from '@/lib/feeds/poller'
import { logger } from '@/lib/logger'
import type { AppEnv } from '@/types'

const adminNews = new Hono<AppEnv>()
adminNews.use('*', requireAdmin)

// List shared categories (excludes built-ins) with their feeds.
adminNews.get('/categories', async (c) => {
  const folders = await db.select().from(feedFolders)
    .where(and(isNull(feedFolders.userId), isNull(feedFolders.slug))).orderBy(feedFolders.sortOrder)
  const sharedFeeds = await db.select().from(feeds).where(isNull(feeds.userId)).orderBy(feeds.sortOrder)
  return c.json({
    categories: folders.map((f) => ({
      id: f.id,
      name: f.name,
      feeds: sharedFeeds
        .filter((s) => s.folderId === f.id)
        .map((s) => ({ id: s.id, title: s.title, url: s.url, lastError: s.lastError })),
    })),
  })
})

adminNews.post('/categories', async (c) => {
  const { name } = await c.req.json<{ name: string }>()
  if (!name?.trim()) return c.json({ error: 'name required' }, 400)
  const id = crypto.randomUUID()
  await db.insert(feedFolders).values({
    id, userId: null, name: name.trim(), slug: null, locked: false, sortOrder: 0, createdAt: new Date(),
  })
  return c.json({ id })
})

adminNews.delete('/categories/:id', async (c) => {
  const id = c.req.param('id')
  // Only shared, non-built-in categories may be deleted.
  const cat = await db.select().from(feedFolders)
    .where(and(eq(feedFolders.id, id), isNull(feedFolders.userId), isNull(feedFolders.slug))).then((r) => r[0])
  if (!cat) return c.json({ error: 'Not found' }, 404)
  // Cascade-delete its shared feeds (FK is SET NULL otherwise).
  await db.delete(feeds).where(and(eq(feeds.folderId, id), isNull(feeds.userId)))
  await db.delete(feedFolders).where(eq(feedFolders.id, id))
  return c.json({ ok: true })
})

adminNews.post('/categories/:id/feeds', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ url?: string; feedUrl?: string; title?: string }>()
  const cat = await db.select().from(feedFolders)
    .where(and(eq(feedFolders.id, id), isNull(feedFolders.userId), isNull(feedFolders.slug))).then((r) => r[0])
  if (!cat) return c.json({ error: 'Not found' }, 404)

  const input = (body.feedUrl || body.url || '').trim()
  if (!input) return c.json({ error: 'url required' }, 400)

  // Resolve the actual feed URL (autodiscovery) unless an explicit feedUrl was given.
  let feedUrl = body.feedUrl?.trim() || ''
  let title = body.title?.trim() || ''
  if (!feedUrl) {
    const candidates = await discoverFeeds(input)
    if (!candidates.length) return c.json({ error: 'No feed found at that URL' }, 422)
    feedUrl = candidates[0]!.url
    title = title || candidates[0]!.title || ''
  }

  // NULL userId is "distinct" in the unique index, so guard shared dupes explicitly.
  const existing = await db.select({ id: feeds.id }).from(feeds)
    .where(and(isNull(feeds.userId), eq(feeds.url, feedUrl))).then((r) => r[0])
  if (existing) {
    await db.update(feeds).set({ folderId: id }).where(eq(feeds.id, existing.id))
    return c.json({ id: existing.id, already: true })
  }

  const feedId = crypto.randomUUID()
  await db.insert(feeds).values({
    id: feedId, userId: null, kind: 'rss', url: feedUrl, query: null, title, faviconUrl: null, siteUrl: null,
    folderId: id, isSystem: false, sortOrder: 0, notify: false,
    etag: null, lastModified: null, lastFetchedAt: null, lastError: null, pollIntervalSec: null, addedAt: new Date(),
  })
  void refreshFeed(feedId).catch((err) => logger.warn(`[admin-news] initial refresh failed: ${err}`))
  return c.json({ id: feedId })
})

adminNews.delete('/feeds/:id', async (c) => {
  const id = c.req.param('id')
  const f = await db.select().from(feeds).where(and(eq(feeds.id, id), isNull(feeds.userId))).then((r) => r[0])
  if (!f) return c.json({ error: 'Not found' }, 404)
  if (f.isSystem) return c.json({ error: 'Built-in feeds cannot be removed' }, 403)
  await db.delete(feeds).where(eq(feeds.id, id))
  return c.json({ ok: true })
})

export { adminNews }
