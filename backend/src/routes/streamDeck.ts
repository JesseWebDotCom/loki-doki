// Stream Deck API — per-user button pages and grid editor.
//   GET    /api/stream-deck/pages              list user's pages (with buttons)
//   POST   /api/stream-deck/pages              create a page
//   PATCH  /api/stream-deck/pages/:id          update page metadata
//   DELETE /api/stream-deck/pages/:id          delete page (cascade deletes buttons)
//   PUT    /api/stream-deck/pages/:id/buttons  replace all buttons on a page
//   GET    /api/stream-deck/pages/:id/buttons  list buttons for a page

import { Hono } from 'hono'
import { eq, asc, inArray } from 'drizzle-orm'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'
import { db } from '@/db'
import { streamDeckPages, streamDeckButtons } from '@/db/schema'
import { pushStreamDeckConfig } from '@/lib/pod/streamDeckPush'

const streamDeck = new Hono<AppEnv>()

const now = () => new Date()
const uuid = () => crypto.randomUUID()

// ── Pages ─────────────────────────────────────────────────────────────────────

streamDeck.get('/pages', requireAuth, async (c) => {
  const user = c.get('user')
  const pages = await db.select().from(streamDeckPages)
    .where(eq(streamDeckPages.userId, user.id))
    .orderBy(asc(streamDeckPages.sortOrder))

  const allButtons = pages.length
    ? await db.select().from(streamDeckButtons)
        .where(inArray(streamDeckButtons.pageId, pages.map(p => p.id)))
    : []

  return c.json(pages.map(p => ({
    ...p,
    buttons: allButtons.filter(b => b.pageId === p.id),
  })))
})

streamDeck.post('/pages', requireAuth, async (c) => {
  const user = c.get('user')
  const b = (await c.req.json().catch(() => ({}))) as {
    name?: string
    gridRows?: number
    gridCols?: number
    sortOrder?: number
  }
  if (!b.name || typeof b.name !== 'string' || !b.name.trim()) {
    return c.json({ error: 'name is required' }, 400)
  }
  const id = uuid()
  const ts = now()
  await db.insert(streamDeckPages).values({
    id,
    userId: user.id,
    name: b.name.trim(),
    gridRows: typeof b.gridRows === 'number' ? b.gridRows : 3,
    gridCols: typeof b.gridCols === 'number' ? b.gridCols : 5,
    sortOrder: typeof b.sortOrder === 'number' ? b.sortOrder : 0,
    createdAt: ts,
    updatedAt: ts,
  })
  const [page] = await db.select().from(streamDeckPages).where(eq(streamDeckPages.id, id))
  void pushStreamDeckConfig(user.id)
  return c.json(page, 201)
})

streamDeck.patch('/pages/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [existing] = await db.select().from(streamDeckPages)
    .where(eq(streamDeckPages.id, id))
  if (!existing) return c.json({ error: 'page not found' }, 404)
  if (existing.userId !== user.id) return c.json({ error: 'page not found' }, 404)

  const b = (await c.req.json().catch(() => ({}))) as {
    name?: string
    gridRows?: number
    gridCols?: number
    sortOrder?: number
  }
  const updates: Partial<typeof existing> = { updatedAt: now() }
  if (typeof b.name === 'string' && b.name.trim()) updates.name = b.name.trim()
  if (typeof b.gridRows === 'number') updates.gridRows = b.gridRows
  if (typeof b.gridCols === 'number') updates.gridCols = b.gridCols
  if (typeof b.sortOrder === 'number') updates.sortOrder = b.sortOrder

  await db.update(streamDeckPages).set(updates).where(eq(streamDeckPages.id, id))
  const [page] = await db.select().from(streamDeckPages).where(eq(streamDeckPages.id, id))
  void pushStreamDeckConfig(user.id)
  return c.json(page)
})

streamDeck.delete('/pages/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [existing] = await db.select().from(streamDeckPages)
    .where(eq(streamDeckPages.id, id))
  if (!existing) return c.json({ error: 'page not found' }, 404)
  if (existing.userId !== user.id) return c.json({ error: 'page not found' }, 404)

  await db.delete(streamDeckPages).where(eq(streamDeckPages.id, id))
  void pushStreamDeckConfig(user.id)
  return c.json({ ok: true })
})

// ── Buttons ───────────────────────────────────────────────────────────────────

streamDeck.get('/pages/:id/buttons', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [page] = await db.select().from(streamDeckPages).where(eq(streamDeckPages.id, id))
  if (!page) return c.json({ error: 'page not found' }, 404)
  if (page.userId !== user.id) return c.json({ error: 'page not found' }, 404)

  const buttons = await db.select().from(streamDeckButtons)
    .where(eq(streamDeckButtons.pageId, id))
  return c.json(buttons)
})

streamDeck.put('/pages/:id/buttons', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [page] = await db.select().from(streamDeckPages).where(eq(streamDeckPages.id, id))
  if (!page) return c.json({ error: 'page not found' }, 404)
  if (page.userId !== user.id) return c.json({ error: 'page not found' }, 404)

  const body = await c.req.json().catch(() => null)
  if (!Array.isArray(body)) return c.json({ error: 'body must be an array of buttons' }, 400)

  const ts = now()
  const rows = body.map((btn: {
    row?: unknown
    col?: unknown
    icon?: unknown
    label?: unknown
    bgColor?: unknown
    textColor?: unknown
    action?: unknown
  }) => ({
    id: uuid(),
    pageId: id,
    row: typeof btn.row === 'number' ? btn.row : 0,
    col: typeof btn.col === 'number' ? btn.col : 0,
    icon: typeof btn.icon === 'string' ? btn.icon : 'Square',
    label: typeof btn.label === 'string' ? btn.label : '',
    bgColor: typeof btn.bgColor === 'string' ? btn.bgColor : '#1e1e2e',
    textColor: typeof btn.textColor === 'string' ? btn.textColor : '#ffffff',
    action: btn.action !== undefined ? JSON.stringify(btn.action) : '{}',
    createdAt: ts,
    updatedAt: ts,
  }))

  await db.delete(streamDeckButtons).where(eq(streamDeckButtons.pageId, id))
  if (rows.length) await db.insert(streamDeckButtons).values(rows)

  const buttons = await db.select().from(streamDeckButtons)
    .where(eq(streamDeckButtons.pageId, id))
  void pushStreamDeckConfig(user.id)
  return c.json(buttons)
})

export { streamDeck }
