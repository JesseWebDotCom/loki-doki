import { Hono } from 'hono'
import { eq, and, isNull, or, desc, isNotNull } from 'drizzle-orm'
import { db } from '@/db'
import { notifications } from '@/db/schema'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import type { AppEnv } from '@/types'

const notificationsRoute = new Hono<AppEnv>()

// Rows visible to a user: their own, PLUS the admin-targeted (userId IS NULL) ones only
// when they're an admin. Without the role gate, every user saw (and could mark read)
// admin install-requests — a privacy + integrity leak.
const visibleTo = (user: { id: string; role: string }) =>
  user.role === 'admin'
    ? or(eq(notifications.userId, user.id), isNull(notifications.userId))
    : eq(notifications.userId, user.id)

// ── GET /api/notifications ─────────────────────────────────────────────────────

notificationsRoute.get('/', requireAuth, async (c) => {
  const user = c.get('user')
  const rows = await db
    .select()
    .from(notifications)
    .where(visibleTo(user))
    .orderBy(desc(notifications.createdAt))
    .limit(50)
  const unreadCount = rows.filter(r => r.readAt === null).length
  // createdAt/readAt are Drizzle `timestamp` columns → Date objects, which would
  // JSON-serialize to ISO strings. The frontend expects epoch ms numbers
  // (timeAgo math), so normalize here — otherwise relative times render "NaNd ago".
  const serialized = rows.map(r => ({
    ...r,
    createdAt: r.createdAt instanceof Date ? r.createdAt.getTime() : r.createdAt,
    readAt: r.readAt instanceof Date ? r.readAt.getTime() : r.readAt,
  }))
  return c.json({ notifications: serialized, unreadCount })
})

// ── GET /api/notifications/unread-count ───────────────────────────────────────

notificationsRoute.get('/unread-count', requireAuth, async (c) => {
  const user = c.get('user')
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(visibleTo(user), isNull(notifications.readAt)))
  return c.json({ unreadCount: rows.length })
})

// ── PATCH /api/notifications/:id/read ─────────────────────────────────────────

notificationsRoute.patch('/:id/read', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, id), visibleTo(user)))
  return c.json({ ok: true })
})

// ── POST /api/notifications/read-all ──────────────────────────────────────────

notificationsRoute.post('/read-all', requireAuth, async (c) => {
  const user = c.get('user')
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(visibleTo(user), isNull(notifications.readAt)))
  return c.json({ ok: true })
})

// ── POST /api/notifications (admin only) ──────────────────────────────────────

notificationsRoute.post('/', requireAdmin, async (c) => {
  const body = await c.req.json() as {
    type: 'install_request' | 'install_complete' | 'download_complete' | 'system'
    userId?: string | null
    payload?: Record<string, unknown>
  }
  const id = crypto.randomUUID()
  const now = new Date()
  await db.insert(notifications).values({
    id,
    userId: body.userId ?? null,
    type: body.type,
    payload: JSON.stringify(body.payload ?? {}),
    createdAt: now,
  })
  return c.json({ ok: true, id })
})

export { notificationsRoute }
