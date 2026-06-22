import { Hono } from 'hono'
import { eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { bookmarks } from '@/db/schema'
import { requireAdmin } from '@/middleware/auth'
import type { AppEnv } from '@/types'

const adminBookmarksRouter = new Hono<AppEnv>()

adminBookmarksRouter.get('/', requireAdmin, async (c) => {
  const rows = await db.select().from(bookmarks).where(isNull(bookmarks.ownerId))
  return c.json({ bookmarks: rows })
})

adminBookmarksRouter.post('/', requireAdmin, async (c) => {
  const body = await c.req.json<{ label: string; url: string; icon?: string; category?: string; useProxy?: boolean; useEmbed?: boolean }>()
  if (!body.label?.trim() || !body.url?.trim()) return c.json({ error: 'label and url required' }, 400)

  const now = new Date()
  const bookmark = {
    id: crypto.randomUUID(),
    ownerId: null,
    label: body.label.trim(),
    url: body.url.trim(),
    icon: body.icon ?? null,
    category: body.category?.trim() || 'Services',
    sortOrder: 0,
    useProxy: body.useProxy ?? false,
    useEmbed: body.useEmbed ?? false,
    createdAt: now,
    updatedAt: now,
  }
  await db.insert(bookmarks).values(bookmark)
  return c.json({ bookmark })
})

adminBookmarksRouter.patch('/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<Partial<{ label: string; url: string; icon: string | null; category: string; sortOrder: number; useProxy: boolean; useEmbed: boolean }>>()

  const existing = await db.select().from(bookmarks).where(eq(bookmarks.id, id)).then(r => r[0])
  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db.update(bookmarks)
    .set({
      label:     body.label     !== undefined ? body.label.trim()    : existing.label,
      url:       body.url       !== undefined ? body.url.trim()      : existing.url,
      icon:      body.icon      !== undefined ? body.icon            : existing.icon,
      category:  body.category  !== undefined ? body.category.trim() : existing.category,
      sortOrder: body.sortOrder !== undefined ? body.sortOrder       : existing.sortOrder,
      useProxy:  body.useProxy  !== undefined ? body.useProxy        : existing.useProxy,
      useEmbed:  body.useEmbed  !== undefined ? body.useEmbed        : existing.useEmbed,
      updatedAt: new Date(),
    })
    .where(eq(bookmarks.id, id))

  return c.json({ ok: true })
})

adminBookmarksRouter.delete('/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const existing = await db.select().from(bookmarks).where(eq(bookmarks.id, id)).then(r => r[0])
  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db.delete(bookmarks).where(eq(bookmarks.id, id))
  return c.json({ ok: true })
})

export { adminBookmarksRouter as adminBookmarks }
