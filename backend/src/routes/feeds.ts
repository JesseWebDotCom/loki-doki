import { Hono } from 'hono'
import { and, count, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import { db } from '@/db'
import { feeds, feedItems, feedItemState, feedFolders, feedItemScores } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { discoverFeeds } from '@/lib/feeds/discover'
import { refreshFeed, refreshUserFeeds } from '@/lib/feeds/poller'
import { extractArticle } from '@/lib/content/extract'
import { getInterests, setInterestsText, recordFeedback, scoreItems } from '@/lib/feeds/classifier'
import { promoteToBookmarks, unpromoteFromBookmarks } from '@/routes/bookmarks'
import { logger } from '@/lib/logger'
import type { AppEnv } from '@/types'

const feedsRouter = new Hono<AppEnv>()
feedsRouter.use('*', requireAuth)

// Feeds visible to a user: their own + all system feeds.
function visibleWhere(userId: string) {
  return or(isNull(feeds.userId), eq(feeds.userId, userId))!
}

// ── Feeds list (own + system) with unread counts ───────────────────────────────

feedsRouter.get('/', async (c) => {
  const user = c.get('user')
  const rows = await db.select().from(feeds).where(visibleWhere(user.id)).orderBy(desc(feeds.isSystem), feeds.sortOrder)
  const ids = rows.map((f) => f.id)

  const unread = new Map<string, number>()
  if (ids.length) {
    const totals = await db.select({ feedId: feedItems.feedId, n: count() }).from(feedItems)
      .where(inArray(feedItems.feedId, ids)).groupBy(feedItems.feedId)
    const reads = await db.select({ feedId: feedItems.feedId, n: count() }).from(feedItems)
      .innerJoin(feedItemState, and(eq(feedItemState.itemId, feedItems.id), eq(feedItemState.userId, user.id), eq(feedItemState.read, true)))
      .where(inArray(feedItems.feedId, ids)).groupBy(feedItems.feedId)
    const readMap = new Map(reads.map((r) => [r.feedId, r.n]))
    for (const t of totals) unread.set(t.feedId, t.n - (readMap.get(t.feedId) ?? 0))
  }

  // Folders double as News categories: own (personal) + shared/built-in (userId null).
  const folderRows = await db.select().from(feedFolders)
    .where(or(isNull(feedFolders.userId), eq(feedFolders.userId, user.id))).orderBy(feedFolders.sortOrder)

  return c.json({
    feeds: rows.map((f) => ({ ...f, isSystem: !!f.isSystem, canEdit: f.userId === user.id, unread: unread.get(f.id) ?? 0 })),
    folders: folderRows.map((f) => ({ ...f, locked: !!f.locked, canEdit: f.userId === user.id })),
  })
})

feedsRouter.post('/discover', async (c) => {
  const { url } = await c.req.json<{ url: string }>()
  if (!url?.trim()) return c.json({ error: 'url required' }, 400)
  return c.json({ candidates: await discoverFeeds(url.trim()) })
})

feedsRouter.post('/', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ url?: string; feedUrl?: string; title?: string; query?: string; folderId?: string }>()

  // Saved-search "feed".
  if (body.query?.trim()) {
    const id = crypto.randomUUID()
    const now = new Date()
    await db.insert(feeds).values({
      id, userId: user.id, kind: 'search', url: null, query: body.query.trim(),
      title: body.title?.trim() || `Search: ${body.query.trim()}`, faviconUrl: null, siteUrl: null,
      folderId: body.folderId ?? null, isSystem: false, sortOrder: 0, notify: false,
      etag: null, lastModified: null, lastFetchedAt: null, lastError: null, pollIntervalSec: null, addedAt: now,
    })
    void refreshFeed(id).catch(() => {})
    return c.json({ id })
  }

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

  const existing = await db.select({ id: feeds.id }).from(feeds)
    .where(and(eq(feeds.userId, user.id), eq(feeds.url, feedUrl))).then((r) => r[0])
  if (existing) return c.json({ id: existing.id, already: true })

  const id = crypto.randomUUID()
  const now = new Date()
  await db.insert(feeds).values({
    id, userId: user.id, kind: 'rss', url: feedUrl, query: null, title, faviconUrl: null, siteUrl: null,
    folderId: body.folderId ?? null, isSystem: false, sortOrder: 0, notify: false,
    etag: null, lastModified: null, lastFetchedAt: null, lastError: null, pollIntervalSec: null, addedAt: now,
  })
  void refreshFeed(id).catch((err) => logger.warn(`[feeds] initial refresh failed: ${err}`))
  return c.json({ id })
})

feedsRouter.patch('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json<Partial<{ title: string; folderId: string | null; notify: boolean; sortOrder: number }>>()
  const existing = await db.select().from(feeds).where(and(eq(feeds.id, id), eq(feeds.userId, user.id))).then((r) => r[0])
  if (!existing) return c.json({ error: 'Not found' }, 404) // system feeds (userId null) are non-editable
  await db.update(feeds).set({
    title: body.title !== undefined ? body.title.trim() : existing.title,
    folderId: body.folderId !== undefined ? body.folderId : existing.folderId,
    notify: body.notify !== undefined ? body.notify : existing.notify,
    sortOrder: body.sortOrder !== undefined ? body.sortOrder : existing.sortOrder,
  }).where(eq(feeds.id, id))
  return c.json({ ok: true })
})

feedsRouter.delete('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const existing = await db.select().from(feeds).where(eq(feeds.id, id)).then((r) => r[0])
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.userId !== user.id) return c.json({ error: 'System feeds cannot be removed' }, 403)
  await db.delete(feeds).where(eq(feeds.id, id))
  return c.json({ ok: true })
})

feedsRouter.post('/:id/refresh', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const f = await db.select().from(feeds).where(and(eq(feeds.id, id), visibleWhere(user.id))).then((r) => r[0])
  if (!f) return c.json({ error: 'Not found' }, 404)
  const n = await refreshFeed(id).catch(() => 0)
  return c.json({ ok: true, added: n })
})

// ── Items ───────────────────────────────────────────────────────────────────────

feedsRouter.get('/items', async (c) => {
  const user = c.get('user')
  const { feedId, folderId, saved, unread, cursor } = c.req.query()
  const limit = Math.min(Number(c.req.query('limit')) || 40, 100)

  const conds = [visibleWhere(user.id)]
  if (feedId) conds.push(eq(feedItems.feedId, feedId))
  if (folderId) conds.push(eq(feeds.folderId, folderId))
  if (cursor) conds.push(lt(feedItems.publishedAt, Number(cursor)))

  const rows = await db.select({
    item: feedItems,
    feedTitle: feeds.title,
    feedFavicon: feeds.faviconUrl,
    read: feedItemState.read,
    isSaved: feedItemState.saved,
    score: feedItemScores.score,
  }).from(feedItems)
    .innerJoin(feeds, eq(feedItems.feedId, feeds.id))
    .leftJoin(feedItemState, and(eq(feedItemState.itemId, feedItems.id), eq(feedItemState.userId, user.id)))
    .leftJoin(feedItemScores, and(eq(feedItemScores.itemId, feedItems.id), eq(feedItemScores.userId, user.id)))
    .where(and(...conds))
    .orderBy(desc(feedItems.publishedAt), desc(feedItems.fetchedAt))
    .limit(limit + 1)

  let filtered = rows
  if (saved === '1') filtered = rows.filter((r) => r.isSaved)
  if (unread === '1') filtered = filtered.filter((r) => !r.read)

  const page = filtered.slice(0, limit)
  const next = filtered.length > limit ? page[page.length - 1]?.item.publishedAt ?? null : null

  // Score any unscored items in this page in the background so the interest fold/highlight
  // appears on the next load (never blocks the list; bounded inside scoreItems).
  const unscored = page.filter((r) => r.score == null).map((r) => ({ id: r.item.id, title: r.item.title ?? '', summary: r.item.summary }))
  if (unscored.length) void scoreItems(user.id, unscored).catch(() => {})

  return c.json({
    items: page.map((r) => ({
      ...r.item,
      feedTitle: r.feedTitle,
      feedFavicon: r.feedFavicon,
      contentHtml: undefined, // omit heavy field from list
      read: !!r.read,
      saved: !!r.isSaved,
      score: r.score ?? null,
    })),
    nextCursor: next,
  })
})

// ── Interest classifier (AI fold/highlight) ─────────────────────────────────────

feedsRouter.get('/interests', async (c) => {
  const user = c.get('user')
  return c.json(await getInterests(user.id))
})
feedsRouter.put('/interests', async (c) => {
  const user = c.get('user')
  const { interestsText } = await c.req.json<{ interestsText: string }>()
  await setInterestsText(user.id, interestsText ?? '')
  return c.json({ ok: true })
})
feedsRouter.post('/items/:id/feedback', async (c) => {
  const user = c.get('user')
  const itemId = c.req.param('id')
  const { vote } = await c.req.json<{ vote: 'up' | 'down' }>()
  const item = await db.select({ i: feedItems }).from(feedItems)
    .innerJoin(feeds, eq(feedItems.feedId, feeds.id))
    .where(and(eq(feedItems.id, itemId), visibleWhere(user.id))).then((r) => r[0]?.i)
  if (!item) return c.json({ error: 'Not found' }, 404)
  await recordFeedback(user.id, item.title ?? '', vote === 'up' ? 'up' : 'down', itemId)
  return c.json({ ok: true })
})

// Full article content for the in-app reader. Uses the feed's own content:encoded if
// present, else lazily extracts (and caches) the article on first open.
feedsRouter.get('/items/:id/content', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const row = await db.select({ i: feedItems }).from(feedItems)
    .innerJoin(feeds, eq(feedItems.feedId, feeds.id))
    .where(and(eq(feedItems.id, id), visibleWhere(user.id))).then((r) => r[0]?.i)
  if (!row) return c.json({ error: 'Not found' }, 404)

  if (row.contentHtml) {
    return c.json({ id: row.id, title: row.title, url: row.url, author: row.author, contentHtml: row.contentHtml, readingMins: Math.max(1, Math.round((row.contentHtml.replace(/<[^>]+>/g, ' ').split(/\s+/).length) / 200)) })
  }
  if (row.url) {
    try {
      const a = await extractArticle(row.url)
      if (a.contentHtml) await db.update(feedItems).set({ contentHtml: a.contentHtml }).where(eq(feedItems.id, id))
      return c.json({ id: row.id, title: row.title || a.title, url: row.url, author: row.author ?? a.byline, siteName: a.siteName, contentHtml: a.contentHtml, readingMins: a.readingMins })
    } catch { /* fall through */ }
  }
  return c.json({ id: row.id, title: row.title, url: row.url, author: row.author, contentHtml: null, readingMins: 0 })
})

// Upsert per-user read/saved state. saved=true promotes a copy into Reader.
feedsRouter.patch('/items/:id', async (c) => {
  const user = c.get('user')
  const itemId = c.req.param('id')
  const body = await c.req.json<Partial<{ read: boolean; saved: boolean }>>()

  const item = await db.select({ i: feedItems }).from(feedItems)
    .innerJoin(feeds, eq(feedItems.feedId, feeds.id))
    .where(and(eq(feedItems.id, itemId), visibleWhere(user.id))).then((r) => r[0]?.i)
  if (!item) return c.json({ error: 'Not found' }, 404)

  const existing = await db.select().from(feedItemState)
    .where(and(eq(feedItemState.userId, user.id), eq(feedItemState.itemId, itemId))).then((r) => r[0])
  const now = new Date()
  if (existing) {
    await db.update(feedItemState).set({
      read: body.read !== undefined ? body.read : existing.read,
      saved: body.saved !== undefined ? body.saved : existing.saved,
      readAt: body.read ? (existing.readAt ?? now) : existing.readAt,
    }).where(eq(feedItemState.id, existing.id))
  } else {
    await db.insert(feedItemState).values({
      id: crypto.randomUUID(), userId: user.id, itemId,
      read: body.read ?? false, saved: body.saved ?? false, readAt: body.read ? now : null,
    })
  }

  // Promote/unpromote into the Reader library.
  if (body.saved === true) {
    await promoteToBookmarks(item, user.id).catch((err) => logger.warn(`[feeds] promote failed: ${err}`))
  } else if (body.saved === false) {
    await unpromoteFromBookmarks(itemId, user.id).catch(() => {})
  }
  return c.json({ ok: true })
})

feedsRouter.post('/items/read-all', async (c) => {
  const user = c.get('user')
  const { feedId, folderId } = await c.req.json<{ feedId?: string; folderId?: string }>()
  const conds = [visibleWhere(user.id)]
  if (feedId) conds.push(eq(feedItems.feedId, feedId))
  if (folderId) conds.push(eq(feeds.folderId, folderId))
  const rows = await db.select({ id: feedItems.id }).from(feedItems)
    .innerJoin(feeds, eq(feedItems.feedId, feeds.id)).where(and(...conds))

  const now = new Date()
  // Upsert read=true for each (small batches). Existing rows are flipped; new ones inserted.
  const existing = await db.select({ itemId: feedItemState.itemId }).from(feedItemState)
    .where(and(eq(feedItemState.userId, user.id), inArray(feedItemState.itemId, rows.map((r) => r.id).length ? rows.map((r) => r.id) : ['_'])))
  const have = new Set(existing.map((e) => e.itemId))
  const toInsert = rows.filter((r) => !have.has(r.id))
  if (have.size) {
    await db.update(feedItemState).set({ read: true, readAt: now })
      .where(and(eq(feedItemState.userId, user.id), inArray(feedItemState.itemId, [...have])))
  }
  for (let i = 0; i < toInsert.length; i += 200) {
    await db.insert(feedItemState).values(toInsert.slice(i, i + 200).map((r) => ({
      id: crypto.randomUUID(), userId: user.id, itemId: r.id, read: true, saved: false, readAt: now,
    }))).onConflictDoNothing()
  }
  return c.json({ ok: true, marked: rows.length })
})

// ── Folders ───────────────────────────────────────────────────────────────────

feedsRouter.get('/folders', async (c) => {
  const user = c.get('user')
  const folderRows = await db.select().from(feedFolders)
    .where(or(isNull(feedFolders.userId), eq(feedFolders.userId, user.id))).orderBy(feedFolders.sortOrder)
  return c.json({ folders: folderRows.map((f) => ({ ...f, locked: !!f.locked, canEdit: f.userId === user.id })) })
})
feedsRouter.post('/folders', async (c) => {
  const user = c.get('user')
  const { name } = await c.req.json<{ name: string }>()
  if (!name?.trim()) return c.json({ error: 'name required' }, 400)
  const id = crypto.randomUUID()
  await db.insert(feedFolders).values({ id, userId: user.id, name: name.trim(), sortOrder: 0, createdAt: new Date() })
  return c.json({ id })
})
feedsRouter.delete('/folders/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  // Only the owner can delete (built-in/shared folders have userId null and won't match).
  const own = await db.select({ id: feedFolders.id }).from(feedFolders)
    .where(and(eq(feedFolders.id, id), eq(feedFolders.userId, user.id))).then((r) => r[0])
  if (!own) return c.json({ error: 'Not found' }, 404)
  // Cascade-delete this category's feeds (FK is SET NULL, which would otherwise leave them
  // orphaned and still polling forever).
  await db.delete(feeds).where(and(eq(feeds.folderId, id), eq(feeds.userId, user.id)))
  await db.delete(feedFolders).where(eq(feedFolders.id, id))
  return c.json({ ok: true })
})

// ── OPML import / export ────────────────────────────────────────────────────────

feedsRouter.get('/opml/export', async (c) => {
  const user = c.get('user')
  const rows = await db.select().from(feeds).where(and(eq(feeds.userId, user.id), eq(feeds.kind, 'rss')))
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const lines = rows.map((f) => `    <outline text="${esc(f.title || f.url || '')}" type="rss" xmlUrl="${esc(f.url || '')}"${f.siteUrl ? ` htmlUrl="${esc(f.siteUrl)}"` : ''}/>`)
  const opml = `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="1.0">\n  <head><title>Loki Feeds</title></head>\n  <body>\n${lines.join('\n')}\n  </body>\n</opml>\n`
  c.header('Content-Type', 'text/x-opml; charset=utf-8')
  c.header('Content-Disposition', 'attachment; filename="loki-feeds.opml"')
  return c.body(opml)
})

feedsRouter.post('/opml/import', async (c) => {
  const user = c.get('user')
  const { opml } = await c.req.json<{ opml: string }>()
  if (!opml) return c.json({ error: 'opml required' }, 400)
  const now = new Date()
  const newIds: string[] = []
  for (const tag of opml.match(/<outline\b[^>]*xmlUrl=["'][^"']+["'][^>]*\/?>/gi) ?? []) {
    const url = tag.match(/xmlUrl=["']([^"']+)["']/i)?.[1]
    if (!url) continue
    const title = tag.match(/(?:text|title)=["']([^"']*)["']/i)?.[1] ?? ''
    const exists = await db.select({ id: feeds.id }).from(feeds)
      .where(and(eq(feeds.userId, user.id), eq(feeds.url, url))).then((r) => r[0])
    if (exists) continue
    const id = crypto.randomUUID()
    await db.insert(feeds).values({
      id, userId: user.id, kind: 'rss', url, query: null, title, faviconUrl: null, siteUrl: null,
      folderId: null, isSystem: false, sortOrder: 0, notify: false,
      etag: null, lastModified: null, lastFetchedAt: null, lastError: null, pollIntervalSec: null, addedAt: now,
    })
    newIds.push(id)
  }
  // One background refresh pass for the whole import (not N immediate refreshes).
  if (newIds.length) void refreshUserFeeds(user.id).catch(() => {})
  return c.json({ imported: newIds.length })
})

export { feedsRouter as feeds }
