// Admin management of per-member Apple iCloud connections (iCloud plan M1).
// All routes are admin-only in M1; member-facing calendar/mail endpoints arrive in
// M3/M5 with their own authorization. The ASP plaintext is accepted on create and
// reconnect, immediately encrypted, and never echoed back in any response.

import { Hono } from 'hono'
import { and, asc, count, desc, eq, gt, lt } from 'drizzle-orm'
import type { AppEnv } from '@/types'
import { db } from '@/db'
import {
  icloudAccounts, icloudCalendars, icloudEventOccurrences, icloudMailMessages, users,
} from '@/db/schema'
import { requireAdmin, requireAuth } from '@/middleware/auth'
import { requireFeature, userMayUseCapability } from '@/lib/featureGate'
import {
  listAccounts, createAccount, updateAccountPassword, deleteAccount, probeAccount,
} from '@/lib/icloud/accounts'
import { syncAccountNow } from '@/lib/icloud/calendarPoller'
import { mailWatcherStatus } from '@/lib/icloud/mail/watcher'

const icloud = new Hono<AppEnv>()

icloud.get('/accounts', requireAdmin, async (c) => {
  return c.json({ accounts: await listAccounts() })
})

icloud.post('/accounts', requireAdmin, async (c) => {
  const body = await c.req.json<{ userId?: string; appleId?: string; appPassword?: string }>().catch(() => null)
  const userId = body?.userId?.trim()
  const appleId = body?.appleId?.trim()
  const appPassword = body?.appPassword?.trim()
  if (!userId || !appleId || !appPassword) {
    return c.json({ error: 'userId, appleId, and appPassword are required' }, 400)
  }
  try {
    return c.json({ account: await createAccount(userId, appleId, appPassword) })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('UNIQUE')) return c.json({ error: 'That Apple ID is already connected for this member' }, 409)
    if (msg.includes('FOREIGN KEY')) return c.json({ error: 'Unknown member' }, 400)
    throw e
  }
})

icloud.post('/accounts/:id/probe', requireAdmin, async (c) => {
  const account = await probeAccount(c.req.param('id'))
  if (!account) return c.json({ error: 'Not found' }, 404)
  return c.json({ account })
})

// Reconnect with a fresh app-specific password (after Apple revoked the old one).
icloud.put('/accounts/:id', requireAdmin, async (c) => {
  const body = await c.req.json<{ appPassword?: string }>().catch(() => null)
  const appPassword = body?.appPassword?.trim()
  if (!appPassword) return c.json({ error: 'appPassword is required' }, 400)
  const account = await updateAccountPassword(c.req.param('id'), appPassword)
  if (!account) return c.json({ error: 'Not found' }, 404)
  return c.json({ account })
})

icloud.delete('/accounts/:id', requireAdmin, async (c) => {
  await deleteAccount(c.req.param('id'))
  return c.json({ ok: true })
})

// ── Calendars (M2) ────────────────────────────────────────────────────────────

icloud.get('/calendars', requireAdmin, async (c) => {
  const rows = await db.select().from(icloudCalendars)
  return c.json({
    calendars: rows.map((r) => ({
      id: r.id, accountId: r.accountId, name: r.name, colorHex: r.colorHex,
      enabled: r.enabled, lastSyncAt: r.lastSyncAt,
    })),
  })
})

icloud.put('/calendars/:id', requireAdmin, async (c) => {
  const body = await c.req.json<{ enabled?: boolean }>().catch(() => null)
  if (typeof body?.enabled !== 'boolean') return c.json({ error: 'enabled (boolean) is required' }, 400)
  const [row] = await db.select({ id: icloudCalendars.id }).from(icloudCalendars)
    .where(eq(icloudCalendars.id, c.req.param('id'))).limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  await db.update(icloudCalendars)
    .set({ enabled: body.enabled, updatedAt: new Date() })
    .where(eq(icloudCalendars.id, row.id))
  return c.json({ ok: true })
})

// Merged household events view (any signed-in member — the family calendar is
// household-visible by design, like moments; MAIL is the private surface, not this).
icloud.get('/calendar/events', requireAuth, requireFeature('icloud-calendar'), async (c) => {
  const from = new Date(Number(c.req.query('from')) || Date.now())
  const to = new Date(Number(c.req.query('to')) || from.getTime() + 7 * 86_400_000)
  if (to.getTime() - from.getTime() > 100 * 86_400_000) return c.json({ error: 'Range too large' }, 400)
  const rows = await db
    .select({
      id: icloudEventOccurrences.id,
      summary: icloudEventOccurrences.summary,
      location: icloudEventOccurrences.location,
      startsAt: icloudEventOccurrences.startsAt,
      endsAt: icloudEventOccurrences.endsAt,
      allDay: icloudEventOccurrences.allDay,
      userId: icloudEventOccurrences.userId,
      member: users.nickname,
      colorHex: icloudCalendars.colorHex,
      calendarName: icloudCalendars.name,
    })
    .from(icloudEventOccurrences)
    .innerJoin(icloudCalendars, and(
      eq(icloudEventOccurrences.calendarId, icloudCalendars.id),
      eq(icloudCalendars.enabled, true),
    ))
    .innerJoin(users, eq(icloudEventOccurrences.userId, users.id))
    .where(and(lt(icloudEventOccurrences.startsAt, to), gt(icloudEventOccurrences.endsAt, from)))
    .orderBy(asc(icloudEventOccurrences.startsAt))
    .limit(500)
  return c.json({ events: rows })
})

// Manual sync: discovers calendars on a fresh connection and gives instant feedback.
icloud.post('/accounts/:id/sync', requireAdmin, async (c) => {
  const result = await syncAccountNow(c.req.param('id'))
  if (!result.ok) return c.json({ error: result.error ?? 'Sync failed' }, 502)
  const account = (await listAccounts()).find((a) => a.id === c.req.param('id')) ?? null
  return c.json({ ok: true, account })
})

// ── Mail (M4) ─────────────────────────────────────────────────────────────────
// Privacy model (decided 2026-07-23): the message index is OWNER-ONLY — admins get
// watcher status + counts here, and only M5's notify-bucket flags later, never the
// index. The perProfile gate additionally default-denies non-admin profiles.

// Admin: per-account watcher status + counts. No subjects, senders, or snippets.
icloud.get('/mail/status', requireAdmin, requireFeature('icloud-mail'), async (c) => {
  const statuses = new Map(mailWatcherStatus().map((s) => [s.accountId, s]))
  const counts = await db
    .select({ accountId: icloudMailMessages.accountId, total: count() })
    .from(icloudMailMessages)
    .groupBy(icloudMailMessages.accountId)
  const totals = new Map(counts.map((r) => [r.accountId, r.total]))
  const accounts = await listAccounts()
  return c.json({
    accounts: accounts.map((a) => ({
      accountId: a.id,
      userNickname: a.userNickname,
      watcherConnected: statuses.get(a.id)?.connected ?? false,
      watcherError: statuses.get(a.id)?.lastError ?? null,
      messagesIndexed: totals.get(a.id) ?? 0,
    })),
  })
})

// Owner-only recent message index for the signed-in member's own account(s).
icloud.get('/mail/messages', requireAuth, requireFeature('icloud-mail'), async (c) => {
  const user = c.get('user')
  if (!(await userMayUseCapability(user, 'icloud-mail'))) {
    return c.json({ error: 'feature_not_granted', feature: 'icloud-mail' }, 403)
  }
  const limit = Math.min(Number(c.req.query('limit')) || 50, 200)
  const rows = await db
    .select({
      id: icloudMailMessages.id,
      fromAddress: icloudMailMessages.fromAddress,
      fromName: icloudMailMessages.fromName,
      subject: icloudMailMessages.subject,
      snippet: icloudMailMessages.snippet,
      receivedAt: icloudMailMessages.receivedAt,
      seen: icloudMailMessages.seen,
      hasAttachments: icloudMailMessages.hasAttachments,
    })
    .from(icloudMailMessages)
    .innerJoin(icloudAccounts, eq(icloudMailMessages.accountId, icloudAccounts.id))
    .where(eq(icloudAccounts.userId, user.id))
    .orderBy(desc(icloudMailMessages.receivedAt))
    .limit(limit)
  return c.json({ messages: rows })
})

export { icloud }
