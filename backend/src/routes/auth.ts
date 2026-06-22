import { Hono } from 'hono'
import { getCookie, deleteCookie } from 'hono/cookie'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { users, sessions, profilePins } from '@/db/schema'
import { hashSessionToken, issueSession } from '@/lib/session'
import { verifyPin, lockoutDuration } from '@/lib/pin'
import { getClientIp, pinThrottleCheck, pinThrottleFail, pinThrottleReset } from '@/lib/pinThrottle'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'

const auth = new Hono<AppEnv>()

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
  const { userId } = (await c.req.json()) as { userId: string }

  const [user] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (!user) return c.json({ error: 'Profile not found' }, 404)

  // Admins must authenticate with a PIN. Without this guard, a PIN-free admin
  // profile would be a one-request takeover for anyone who can reach the API.
  if (user.role === 'admin') return c.json({ error: 'PIN required' }, 400)

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
  }
  deleteCookie(c, 'session', { path: '/' })
  return c.json({ success: true })
})

export { auth }
