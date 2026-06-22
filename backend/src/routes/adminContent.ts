import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { users } from '@/db/schema'
import { requireAdmin } from '@/middleware/auth'
import {
  DEFAULT_SAFETY_FLOOR, setSafetyFloor, resetSafetyFloor,
  getCeiling, setCeiling, getUserAdminCeiling, setUserAdminCeiling, MAX_DIALS, DIAL_LEVELS,
} from '@/lib/contentPolicy'
import { getAppSetting } from '@/lib/settings'
import type { AppEnv } from '@/types'

const adminContent = new Hono<AppEnv>()

// ── Safety floor (always-on, admin-editable) ─────────────────────────────────────
adminContent.get('/floor', requireAdmin, async (c) => {
  const stored = await getAppSetting('content.floor')
  const isCustom = typeof stored === 'string' && stored.trim().length > 0
  const prompt = isCustom ? (stored as string) : DEFAULT_SAFETY_FLOOR
  return c.json({ prompt, isCustom, default: DEFAULT_SAFETY_FLOOR })
})

adminContent.put('/floor', requireAdmin, async (c) => {
  const { prompt } = (await c.req.json()) as { prompt: string }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return c.json({ error: 'prompt is required' }, 400)
  }
  await setSafetyFloor(prompt)
  return c.json({ ok: true, prompt: prompt.trim() })
})

adminContent.delete('/floor', requireAdmin, async (c) => {
  await resetSafetyFloor()
  return c.json({ ok: true, prompt: DEFAULT_SAFETY_FLOOR })
})

// ── Instance content ceiling ─────────────────────────────────────────────────────
adminContent.get('/ceiling', requireAdmin, async (c) => {
  const ceiling = await getCeiling()
  return c.json({ ceiling, max: MAX_DIALS, levels: DIAL_LEVELS })
})

adminContent.put('/ceiling', requireAdmin, async (c) => {
  const body = (await c.req.json()) as { ceiling?: Record<string, unknown> }
  const ceiling = await setCeiling(body.ceiling ?? {})
  return c.json({ ok: true, ceiling })
})

// ── Per-user content ceiling (parental control) ──────────────────────────────────
// The admin-enforced maximum a specific user can never exceed. Defaults: admins → full,
// everyone else → fully censored (so a new child account is safe until raised here).
adminContent.get('/users/:userId/ceiling', requireAdmin, async (c) => {
  const userId = c.req.param('userId')
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1)
  if (!u) return c.json({ error: 'User not found' }, 404)
  const ceiling = await getUserAdminCeiling(userId, u.role)
  return c.json({ ceiling, max: MAX_DIALS, levels: DIAL_LEVELS })
})

adminContent.put('/users/:userId/ceiling', requireAdmin, async (c) => {
  const userId = c.req.param('userId')
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1)
  if (!u) return c.json({ error: 'User not found' }, 404)
  const body = (await c.req.json()) as { ceiling?: Record<string, unknown> }
  const ceiling = await setUserAdminCeiling(userId, body.ceiling ?? {})
  return c.json({ ok: true, ceiling })
})

export { adminContent }
