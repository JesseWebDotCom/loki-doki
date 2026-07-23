// Admin management of per-member Apple iCloud connections (iCloud plan M1).
// All routes are admin-only in M1; member-facing calendar/mail endpoints arrive in
// M3/M5 with their own authorization. The ASP plaintext is accepted on create and
// reconnect, immediately encrypted, and never echoed back in any response.

import { Hono } from 'hono'
import type { AppEnv } from '@/types'
import { requireAdmin } from '@/middleware/auth'
import {
  listAccounts, createAccount, updateAccountPassword, deleteAccount, probeAccount,
} from '@/lib/icloud/accounts'

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

export { icloud }
