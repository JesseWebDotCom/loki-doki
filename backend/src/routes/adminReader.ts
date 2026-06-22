import { Hono } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { readerItems } from '@/db/schema'
import { requireAdmin } from '@/middleware/auth'
import type { AppEnv } from '@/types'

// Global (admin-managed) Reader items — owner_id = null, visible to all users.
// These are Live links (shared dashboards / family pages); offline article archiving
// is a per-user action, so admin globals are always type='live'.

const adminReaderRouter = new Hono<AppEnv>()

adminReaderRouter.get('/', requireAdmin, async (c) => {
  const rows = await db.select().from(readerItems)
    .where(and(isNull(readerItems.ownerId), eq(readerItems.type, 'live')))
  return c.json({ items: rows })
})

adminReaderRouter.post('/', requireAdmin, async (c) => {
  const body = await c.req.json<{ title: string; url: string; faviconUrl?: string; category?: string; useProxy?: boolean; useEmbed?: boolean }>()
  if (!body.title?.trim() || !body.url?.trim()) return c.json({ error: 'title and url required' }, 400)
  const now = new Date()
  const item = {
    id: crypto.randomUUID(), ownerId: null, source: 'bookmark' as const, sourceRef: null, type: 'live' as const,
    url: body.url.trim(), title: body.title.trim(), byline: null, siteName: null,
    faviconUrl: body.faviconUrl ?? null, excerpt: null, contentHtml: null, contentText: null,
    wordCount: 0, readingMins: 0, status: 'unread' as const, archiveState: 'none' as const, archiveError: null,
    readAt: null, useProxy: body.useProxy ?? false, useEmbed: body.useEmbed ?? false,
    category: body.category?.trim() || 'Services', collectionId: null, sortOrder: 0,
    screenshotPath: null, snapshotPath: null, ogImagePath: null, isAdult: false, createdAt: now, updatedAt: now,
  }
  await db.insert(readerItems).values(item)
  return c.json({ item })
})

adminReaderRouter.patch('/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<Partial<{ title: string; url: string; faviconUrl: string | null; category: string; sortOrder: number; useProxy: boolean; useEmbed: boolean }>>()
  const existing = await db.select().from(readerItems).where(and(eq(readerItems.id, id), isNull(readerItems.ownerId))).then(r => r[0])
  if (!existing) return c.json({ error: 'Not found' }, 404)
  await db.update(readerItems).set({
    title: body.title !== undefined ? body.title.trim() : existing.title,
    url: body.url !== undefined ? body.url.trim() : existing.url,
    faviconUrl: body.faviconUrl !== undefined ? body.faviconUrl : existing.faviconUrl,
    category: body.category !== undefined ? body.category.trim() : existing.category,
    sortOrder: body.sortOrder !== undefined ? body.sortOrder : existing.sortOrder,
    useProxy: body.useProxy !== undefined ? body.useProxy : existing.useProxy,
    useEmbed: body.useEmbed !== undefined ? body.useEmbed : existing.useEmbed,
    updatedAt: new Date(),
  }).where(eq(readerItems.id, id))
  return c.json({ ok: true })
})

adminReaderRouter.delete('/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const existing = await db.select().from(readerItems).where(and(eq(readerItems.id, id), isNull(readerItems.ownerId))).then(r => r[0])
  if (!existing) return c.json({ error: 'Not found' }, 404)
  await db.delete(readerItems).where(eq(readerItems.id, id))
  return c.json({ ok: true })
})

export { adminReaderRouter as adminReader }
