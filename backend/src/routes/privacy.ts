import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { imageLoras } from '@/db/schema'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { hashPin, verifyPin, lockoutDuration } from '@/lib/pin'
import { getClientIp, pinThrottleCheck, pinThrottleFail, pinThrottleReset } from '@/lib/pinThrottle'
import { detectIsAdult, getAdultKeywords, DEFAULT_ADULT_KEYWORDS } from '@/lib/adultDetection'
import type { AppEnv } from '@/types'

const privacy = new Hono<AppEnv>()

// Brute-force tracking, persisted to app_settings so the lockout survives a server
// restart (an in-memory counter could be reset by simply bouncing the process).
interface Attempt { count: number; lockedUntil: number }
const lockKey = (userId: string) => `privacy.lockout.${userId}`

// ── User: read privacy settings ───────────────────────────────────────────────

privacy.get('/settings', requireAuth, async (c) => {
  const enabled        = (await getAppSetting('privacy.enabled')) ?? true
  const timeoutSeconds = (await getAppSetting('privacy.timeout_seconds')) ?? 30
  const pinHash        = await getAppSetting('privacy.pin_hash')
  return c.json({
    enabled:        Boolean(enabled),
    timeoutSeconds: Number(timeoutSeconds),
    hasPin:         Boolean(pinHash),
  })
})

// ── User: verify PIN to reveal adult content ──────────────────────────────────

privacy.post('/verify', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.json() as { pin?: string }
  const pin  = body.pin?.trim() ?? ''

  if (!pin) return c.json({ ok: false, error: 'PIN required' }, 400)

  // Global per-IP throttle (complements the persisted per-user lockout below).
  const ip = getClientIp(c)
  const throttled = pinThrottleCheck(ip)
  if (throttled.blocked) {
    return c.json({ ok: false, error: `Too many attempts. Try again in ${throttled.retryAfter}s` }, 429)
  }

  // Rate limiting (persisted)
  const attempt = (await getAppSetting(lockKey(user.id))) as Attempt | null ?? { count: 0, lockedUntil: 0 }
  if (attempt.count >= 5 && Date.now() < attempt.lockedUntil) {
    const secsLeft = Math.ceil((attempt.lockedUntil - Date.now()) / 1000)
    return c.json({ ok: false, error: `Too many attempts. Try again in ${secsLeft}s` }, 429)
  }
  // Lockout window expired: reset the counter so we don't re-lock at max backoff
  // on the next wrong guess (otherwise count only ever resets on success, which
  // turns a single lockout into a permanent one).
  if (attempt.count >= 5 && Date.now() >= attempt.lockedUntil) {
    attempt.count = 0
    attempt.lockedUntil = 0
  }

  const pinHash = await getAppSetting('privacy.pin_hash') as string | null
  if (!pinHash) return c.json({ ok: false, error: 'Privacy PIN not configured' }, 400)

  const ok = await verifyPin(pin, pinHash)
  if (!ok) {
    pinThrottleFail(ip)
    attempt.count += 1
    if (attempt.count >= 5) {
      attempt.lockedUntil = Date.now() + lockoutDuration(attempt.count)
    }
    await setAppSetting(lockKey(user.id), attempt)
    return c.json({ ok: false, error: 'Incorrect PIN' }, 401)
  }

  pinThrottleReset(ip)
  await setAppSetting(lockKey(user.id), null)
  return c.json({ ok: true })
})

// ── Admin: get privacy settings ───────────────────────────────────────────────

privacy.get('/admin/settings', requireAdmin, async (c) => {
  const enabled        = (await getAppSetting('privacy.enabled')) ?? true
  const timeoutSeconds = (await getAppSetting('privacy.timeout_seconds')) ?? 30
  const pinHash        = await getAppSetting('privacy.pin_hash')
  return c.json({
    enabled:        Boolean(enabled),
    timeoutSeconds: Number(timeoutSeconds),
    hasPin:         Boolean(pinHash),
  })
})

// ── Admin: update privacy settings ───────────────────────────────────────────

privacy.post('/admin/settings', requireAdmin, async (c) => {
  const body = await c.req.json() as {
    enabled?: boolean
    timeoutSeconds?: number
    pin?: string
  }

  if (body.enabled !== undefined) await setAppSetting('privacy.enabled', body.enabled)
  if (body.timeoutSeconds !== undefined) {
    const secs = Math.max(10, Math.min(3600, Number(body.timeoutSeconds)))
    await setAppSetting('privacy.timeout_seconds', secs)
  }
  if (body.pin !== undefined && body.pin.trim().length > 0) {
    await setAppSetting('privacy.pin_hash', await hashPin(body.pin.trim()))
  }

  const enabled        = (await getAppSetting('privacy.enabled')) ?? true
  const timeoutSeconds = (await getAppSetting('privacy.timeout_seconds')) ?? 30
  const pinHash        = await getAppSetting('privacy.pin_hash')
  return c.json({
    enabled:        Boolean(enabled),
    timeoutSeconds: Number(timeoutSeconds),
    hasPin:         Boolean(pinHash),
  })
})

// ── Admin: get adult keywords ─────────────────────────────────────────────────

privacy.get('/admin/keywords', requireAdmin, async (c) => {
  const custom = await getAppSetting('privacy.adult_keywords') as string[] | null
  const usingCustom = Array.isArray(custom) && custom.length > 0
  return c.json({
    keywords: usingCustom ? custom : DEFAULT_ADULT_KEYWORDS,
    isCustom: usingCustom,
    defaults: DEFAULT_ADULT_KEYWORDS,
  })
})

// ── Admin: save adult keywords ────────────────────────────────────────────────

privacy.post('/admin/keywords', requireAdmin, async (c) => {
  const body = await c.req.json() as { keywords?: string[]; reset?: boolean }
  if (body.reset) {
    await setAppSetting('privacy.adult_keywords', null)
    return c.json({ keywords: DEFAULT_ADULT_KEYWORDS, isCustom: false, defaults: DEFAULT_ADULT_KEYWORDS })
  }
  const kws = (body.keywords ?? [])
    .map((k: string) => k.trim().toLowerCase())
    .filter((k: string) => k.length > 0)
  await setAppSetting('privacy.adult_keywords', kws)
  return c.json({ keywords: kws, isCustom: true, defaults: DEFAULT_ADULT_KEYWORDS })
})

// ── Admin: rescan all LoRAs for adult content ─────────────────────────────────

privacy.post('/admin/rescan', requireAdmin, async (c) => {
  const loras = await db.select({
    id:          imageLoras.id,
    name:        imageLoras.name,
    description: imageLoras.description,
  }).from(imageLoras)

  const keywords = await getAdultKeywords()
  let updated = 0

  for (const lora of loras) {
    const isAdult = detectIsAdult(lora.name, lora.description ?? '', undefined, keywords)
    await db.update(imageLoras)
      .set({ isAdult, updatedAt: new Date() })
      .where(eq(imageLoras.id, lora.id))
    updated++
  }

  // Return counts of flagged vs clean
  const flagged = await db.select({ id: imageLoras.id })
    .from(imageLoras)
    .where(eq(imageLoras.isAdult, true))

  return c.json({ scanned: updated, flagged: flagged.length })
})

export { privacy }
