// Admin management of per-member Apple iCloud connections (iCloud plan M1).
// All routes are admin-only in M1; member-facing calendar/mail endpoints arrive in
// M3/M5 with their own authorization. The ASP plaintext is accepted on create and
// reconnect, immediately encrypted, and never echoed back in any response.

import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import type { AppEnv } from '@/types'
import { db } from '@/db'
import { icloudCalendars } from '@/db/schema'
import { requireAdmin } from '@/middleware/auth'
import {
  listAccounts, createAccount, updateAccountPassword, deleteAccount, probeAccount,
} from '@/lib/icloud/accounts'
import { syncAccountNow } from '@/lib/icloud/calendarPoller'

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

// Manual sync: discovers calendars on a fresh connection and gives instant feedback.
icloud.post('/accounts/:id/sync', requireAdmin, async (c) => {
  const result = await syncAccountNow(c.req.param('id'))
  if (!result.ok) return c.json({ error: result.error ?? 'Sync failed' }, 502)
  const account = (await listAccounts()).find((a) => a.id === c.req.param('id')) ?? null
  return c.json({ ok: true, account })
})

export { icloud }
