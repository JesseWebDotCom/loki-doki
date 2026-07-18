import { Hono } from 'hono'
import { eq, and, isNull, or, desc, notInArray, count } from 'drizzle-orm'
import { db } from '@/db'
import { notifications, userPreferences } from '@/db/schema'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import { emitNotification } from '@/lib/notify'
import { buildNotificationDigest, invalidateDigest } from '@/lib/notifications/digest'
import type { AppEnv } from '@/types'

const notificationsRoute = new Hono<AppEnv>()

// Rows visible to a user: their own, PLUS the admin-targeted (userId IS NULL) ones only
// when they're an admin. Without the role gate, every user saw (and could mark read)
// admin install-requests — a privacy + integrity leak.
const visibleTo = (user: { id: string; role: string }) =>
  user.role === 'admin'
    ? or(eq(notifications.userId, user.id), isNull(notifications.userId))
    : eq(notifications.userId, user.id)

type NotifType = typeof notifications.$inferSelect['type']
// Derive from the schema enum so muting/validation never silently drifts out of sync when a
// new type is added (price_alert/file_drop/service_alert were previously missing → muting them
// was a no-op and POSTing them 400'd).
const NOTIF_TYPES: readonly NotifType[] = notifications.type.enumValues as readonly NotifType[]

// Per-user "delivery" preference (Settings → Notifications). A user can mute whole
// notification types; we filter at read time rather than creation time because the
// admin-broadcast rows (userId IS NULL) are shared and can't be filtered per-admin
// when they're created. The pref is a JSON array of muted type strings.
async function mutedTypes(userId: string): Promise<NotifType[]> {
  const [row] = await db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, 'notifications.muted')))
    .limit(1)
  if (!row) return []
  try {
    const v = JSON.parse(row.value)
    return Array.isArray(v) ? v.filter((x): x is NotifType => NOTIF_TYPES.includes(x as NotifType)) : []
  } catch { return [] }
}

// Combine the visibility clause with the user's muted-type filter.
function whereFor(user: { id: string; role: string }, muted: NotifType[]) {
  return muted.length ? and(visibleTo(user), notInArray(notifications.type, muted)) : visibleTo(user)
}

// ── GET /api/notifications ─────────────────────────────────────────────────────

notificationsRoute.get('/', requireAuth, async (c) => {
  const user = c.get('user')
  const muted = await mutedTypes(user.id)
  const rows = await db
    .select()
    .from(notifications)
    .where(whereFor(user, muted))
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

// ── GET /api/notifications/digest ─────────────────────────────────────────────
// Opt-in AI one-line summary of the current unread notifications for the bell
// dropdown. Off unless the user set notifications.aiDigest = true. Camera and
// service/resource alerts are never summarized (shown verbatim in the list).

async function digestEnabled(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, 'notifications.aiDigest')))
    .limit(1)
  if (!row) return false
  try { return JSON.parse(row.value) === true } catch { return false }
}

notificationsRoute.get('/digest', requireAuth, async (c) => {
  const user = c.get('user')
  if (!(await digestEnabled(user.id))) return c.json({ enabled: false, digest: null })
  const muted = await mutedTypes(user.id)
  const rows = await db
    .select({ id: notifications.id, type: notifications.type, payload: notifications.payload })
    .from(notifications)
    .where(and(whereFor(user, muted), isNull(notifications.readAt)))
    .orderBy(desc(notifications.createdAt))
    .limit(30)
  const unread = rows.map((r) => {
    let payload: Record<string, unknown> = {}
    try { payload = JSON.parse(r.payload) as Record<string, unknown> } catch { /* keep {} */ }
    return { id: r.id, type: r.type, payload }
  })
  const digest = await buildNotificationDigest(user.id, unread)
  return c.json({ enabled: true, ...digest })
})

// ── GET /api/notifications/unread-count ───────────────────────────────────────

notificationsRoute.get('/unread-count', requireAuth, async (c) => {
  const user = c.get('user')
  const muted = await mutedTypes(user.id)
  const [row] = await db
    .select({ n: count() })
    .from(notifications)
    .where(and(whereFor(user, muted), isNull(notifications.readAt)))
  return c.json({ unreadCount: row?.n ?? 0 })
})

// ── PATCH /api/notifications/:id/read ─────────────────────────────────────────

notificationsRoute.patch('/:id/read', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, id), visibleTo(user)))
  invalidateDigest(user.id)
  return c.json({ ok: true })
})

// ── POST /api/notifications/read-all ──────────────────────────────────────────

notificationsRoute.post('/read-all', requireAuth, async (c) => {
  const user = c.get('user')
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(visibleTo(user), isNull(notifications.readAt)))
  invalidateDigest(user.id)
  return c.json({ ok: true })
})

// ── DELETE /api/notifications ─────────────────────────────────────────────────
// Clear the user's notification list. Removes everything visible to them — their own
// rows, plus admin-broadcast rows when they're an admin (same scope as the list view).

notificationsRoute.delete('/', requireAuth, async (c) => {
  const user = c.get('user')
  await db.delete(notifications).where(visibleTo(user))
  invalidateDigest(user.id)
  return c.json({ ok: true })
})

// ── POST /api/notifications (admin only) ──────────────────────────────────────

notificationsRoute.post('/', requireAdmin, async (c) => {
  const body = await c.req.json() as {
    type: NotifType
    userId?: string | null
    payload?: Record<string, unknown>
    priority?: 'info' | 'normal' | 'urgent'
  }
  if (!NOTIF_TYPES.includes(body.type)) return c.json({ error: 'unknown notification type' }, 400)
  const id = await emitNotification({
    type: body.type,
    userId: body.userId ?? null,
    payload: body.payload ?? {},
    priority: body.priority,
  })
  return c.json({ ok: true, id })
})

export { notificationsRoute }
