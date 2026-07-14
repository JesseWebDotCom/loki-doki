import { Hono } from 'hono'
import { getCookie, deleteCookie } from 'hono/cookie'
import { getConnInfo } from 'hono/bun'
import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { users, sessions, profilePins } from '@/db/schema'
import { hashSessionToken, issueSession } from '@/lib/session'
import { verifyPin, hashPin, lockoutDuration } from '@/lib/pin'
import { getClientIp, pinThrottleCheck, pinThrottleFail, pinThrottleReset } from '@/lib/pinThrottle'
import { requireAuth, invalidateSessionCache } from '@/middleware/auth'
import type { AppEnv } from '@/types'

const auth = new Hono<AppEnv>()

// A reverse proxy makes every socket peer look like loopback, so we can only trust a
// loopback peer as "operator on the box" when no proxy is configured. Mirrors the
// TRUST_PROXY gate in pinThrottle.ts.
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || !!(process.env.APP_ORIGIN ?? process.env.PUBLIC_ORIGIN)
function isLocalOperatorRequest(c: Context<AppEnv>): boolean {
  if (TRUST_PROXY) return false
  try {
    const addr = getConnInfo(c).remote.address ?? ''
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  } catch {
    return false
  }
}

// All profiles for the profile picker — never exposes pin hashes
auth.get('/profiles', async (c) => {
  const profiles = await db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      nickname: users.nickname,
      avatarUrl: users.avatarUrl,
      dicebearStyle: users.dicebearStyle,
      dicebearSeed: users.dicebearSeed,
      dicebearConfig: users.dicebearConfig,
    })
    .from(users)

  const pins = await db.select({ userId: profilePins.userId }).from(profilePins)
  const pinnedIds = new Set(pins.map((p) => p.userId))

  return c.json(profiles.map((p) => ({ ...p, hasPin: pinnedIds.has(p.id) })))
})

// Select a PIN-free profile
auth.post('/select', async (c) => {
  const { userId, pin: newPin } = (await c.req.json()) as { userId: string; pin?: string }

  const [user] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (!user) return c.json({ error: 'Profile not found' }, 404)

  // Admins must authenticate with a PIN. Without this guard, a PIN-free admin
  // profile would be a one-request takeover for anyone who can reach the API.
  if (user.role === 'admin') {
    const [existingPin] = await db
      .select({ id: profilePins.id })
      .from(profilePins)
      .where(eq(profilePins.userId, userId))
      .limit(1)

    if (existingPin) return c.json({ error: 'PIN required' }, 400)

    // Admin exists but has no PIN on record — a broken/legacy state (setup now always
    // sets one). Recovering by setting a PIN here also mints an admin session, so it is
    // an unauthenticated privilege grant: allow it ONLY from a loopback peer with no
    // reverse proxy configured (the operator physically on the box). A remote client —
    // LAN or internet — is refused, closing the one-request admin-takeover.
    if (!isLocalOperatorRequest(c)) {
      return c.json({ error: 'Admin PIN recovery must be done from the server itself.' }, 403)
    }
    if (!newPin) return c.json({ error: 'PIN required', needsPinSetup: true }, 400)
    if (!/^\d{4,6}$/.test(newPin)) return c.json({ error: 'PIN must be 4–6 digits' }, 400)

    const now = new Date()
    await db.insert(profilePins).values({
      id: crypto.randomUUID(),
      userId,
      pinHash: await hashPin(newPin),
      failedAttempts: 0,
      createdAt: now,
      updatedAt: now,
    })
    await issueSession(c, userId)
    return c.json({ success: true })
  }

  const [pin] = await db
    .select({ id: profilePins.id })
    .from(profilePins)
    .where(eq(profilePins.userId, userId))
    .limit(1)

  if (pin) return c.json({ error: 'PIN required' }, 400)

  await issueSession(c, userId)
  return c.json({ success: true })
})

// Select a PIN-protected profile
auth.post('/verify-pin', async (c) => {
  const { userId, pin } = (await c.req.json()) as { userId: string; pin: string }

  // Global per-IP throttle on top of the per-profile lockout below, so one host
  // can't brute-force every profile in parallel.
  const ip = getClientIp(c)
  const throttled = pinThrottleCheck(ip)
  if (throttled.blocked) {
    return c.json({ error: 'Too many attempts', retryAfter: throttled.retryAfter }, 429)
  }

  const [record] = await db
    .select()
    .from(profilePins)
    .where(eq(profilePins.userId, userId))
    .limit(1)

  if (!record) return c.json({ error: 'No PIN set' }, 400)

  if (record.lockedUntil && record.lockedUntil > new Date()) {
    const retryAfter = Math.ceil((record.lockedUntil.getTime() - Date.now()) / 1000)
    return c.json({ error: 'Too many attempts', retryAfter }, 429)
  }

  const valid = await verifyPin(pin, record.pinHash)
  const now = new Date()

  if (!valid) {
    pinThrottleFail(ip)
    const newAttempts = record.failedAttempts + 1
    const lockedUntil = newAttempts >= 5 ? new Date(Date.now() + lockoutDuration(newAttempts)) : null
    await db
      .update(profilePins)
      .set({ failedAttempts: newAttempts, lockedUntil, updatedAt: now })
      .where(eq(profilePins.userId, userId))
    return c.json({ error: 'Invalid PIN', attemptsLeft: Math.max(0, 5 - newAttempts) }, 401)
  }

  pinThrottleReset(ip)
  await db
    .update(profilePins)
    .set({ failedAttempts: 0, lockedUntil: null, updatedAt: now })
    .where(eq(profilePins.userId, userId))

  await issueSession(c, userId)
  return c.json({ success: true })
})

auth.get('/me', requireAuth, async (c) => {
  const user = c.get('user')
  const [pin] = await db
    .select({ id: profilePins.id })
    .from(profilePins)
    .where(eq(profilePins.userId, user.id))
    .limit(1)
  let dicebearConfig: Record<string, unknown> | null = null
  try { if (user.dicebearConfig) dicebearConfig = JSON.parse(user.dicebearConfig) as Record<string, unknown> } catch { /* */ }
  return c.json({ ...user, hasPin: !!pin, dicebearConfig })
})

auth.post('/logout', requireAuth, async (c) => {
  const token = getCookie(c, 'session')
  if (token) {
    await db.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)))
    invalidateSessionCache(token)
  }
  deleteCookie(c, 'session', { path: '/' })
  return c.json({ success: true })
})

export { auth }
