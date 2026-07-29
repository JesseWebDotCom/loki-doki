import { Hono } from 'hono'
import { getCookie, deleteCookie } from 'hono/cookie'
import { getConnInfo } from 'hono/bun'
import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { users, sessions, profilePins } from '@/db/schema'
import { hashSessionToken, issueSession } from '@/lib/session'
import {
  approveQuickConnect, consumeQuickConnect, createQuickConnect, getQuickConnect, listPendingQuickConnects,
} from '@/lib/quickConnect'
import { verifyPin, hashPin, lockoutDuration } from '@/lib/pin'
import { getClientIp, pinThrottleCheck, pinThrottleFail, pinThrottleReset } from '@/lib/pinThrottle'
import { requireAuth, invalidateSessionCache } from '@/middleware/auth'
import { buildDicebearSvg, buildInitialsSvg, rasterizeSvgToPng, type AvatarUser } from '@/lib/avatar'
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

// Server-side rasterized avatar for native clients (tvOS) that can't run the
// browser's DiceBear renderer. PUBLIC and read-only, exactly like /profiles: it
// only exposes the avatar, which /profiles already returns to the lock screen.
// GET /api/auth/avatar/:userId(.png)?size=200  ->  square PNG (SVG on fallback).
const AVATAR_SIZE_MIN = 64
const AVATAR_SIZE_MAX = 512
const AVATAR_SIZE_DEFAULT = 200

// avatars change rarely, so keep the rendered PNGs in memory keyed by identity.
const avatarPngCache = new Map<string, Uint8Array>()
const AVATAR_CACHE_MAX = 512

auth.get('/avatar/:userId', async (c) => {
  // Accept the userId with or without a `.png` suffix (the ergonomic URL is
  // `/avatar/<id>.png` so the client treats it as an image file).
  const rawParam = c.req.param('userId')
  const userId = rawParam.endsWith('.png') ? rawParam.slice(0, -4) : rawParam

  const sizeParam = Number.parseInt(c.req.query('size') ?? '', 10)
  const size = Number.isFinite(sizeParam)
    ? Math.min(AVATAR_SIZE_MAX, Math.max(AVATAR_SIZE_MIN, sizeParam))
    : AVATAR_SIZE_DEFAULT

  const [user] = await db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      avatarUrl: users.avatarUrl,
      dicebearStyle: users.dicebearStyle,
      dicebearSeed: users.dicebearSeed,
      dicebearConfig: users.dicebearConfig,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (!user) return c.json({ error: 'Profile not found' }, 404)

  // A user-set avatar image wins: it's already a real raster image, so hand the
  // client straight to it (relative or absolute URL) rather than re-encoding.
  if (user.avatarUrl) {
    c.header('Cache-Control', 'public, max-age=3600')
    return c.redirect(user.avatarUrl, 302)
  }

  const avatarUser: AvatarUser = user

  // config-hash so a changed avatar (or size) misses the cache and re-renders.
  const identity = `${user.dicebearStyle ?? ''}|${user.dicebearSeed ?? ''}|${user.dicebearConfig ?? ''}`
  const cacheKey = `${user.id}:${size}:${Bun.hash(identity).toString(36)}`

  const cached = avatarPngCache.get(cacheKey)
  if (cached) {
    return new Response(cached, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' },
    })
  }

  // DiceBear when we have a seed; otherwise a colored initials square. DiceBear
  // rendering is best-effort — if it throws (missing/broken dep), fall back to
  // the dependency-free initials square rather than erroring.
  let svg: string
  if (user.dicebearSeed) {
    try {
      svg = await buildDicebearSvg(avatarUser)
    } catch {
      svg = buildInitialsSvg(avatarUser, size)
    }
  } else {
    svg = buildInitialsSvg(avatarUser, size)
  }

  const png = await rasterizeSvgToPng(svg, size)

  if (!png) {
    // Rasterizer unavailable: serve the raw SVG so the endpoint never crashes.
    // (tvOS AsyncImage can't render SVG, but this keeps the API contract intact.)
    return new Response(svg, {
      headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
    })
  }

  const bytes = new Uint8Array(png)
  if (avatarPngCache.size >= AVATAR_CACHE_MAX) {
    const oldest = avatarPngCache.keys().next().value
    if (oldest !== undefined) avatarPngCache.delete(oldest)
  }
  avatarPngCache.set(cacheKey, bytes)

  return new Response(bytes, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' },
  })
})

// PUBLIC, read-only: the household's Continue Watching row for the tvOS Top
// Shelf extension. App extensions can't share the app's session cookie, so this
// mirrors the avatar endpoint's stance: household-private server, low-sensitivity
// data (recent titles only — no per-user attribution), thumbnails on YouTube's
// public CDN so the extension can fetch them without auth either.
auth.get('/topshelf', async (c) => {
  const { ytWatchState, ytVideos } = await import('@/db/schema')
  const { and, desc, eq, gt } = await import('drizzle-orm')
  const rows = await db.select({
    videoId: ytWatchState.videoId,
    positionSec: ytWatchState.positionSec,
    completed: ytWatchState.completed,
    updatedAt: ytWatchState.updatedAt,
    title: ytVideos.title,
    author: ytVideos.author,
    durationSec: ytVideos.durationSec,
  })
    .from(ytWatchState)
    .leftJoin(ytVideos, eq(ytVideos.videoId, ytWatchState.videoId))
    .where(and(
      eq(ytWatchState.origin, 'youtube'),
      eq(ytWatchState.completed, false),
      gt(ytWatchState.positionSec, 10),
    ))
    .orderBy(desc(ytWatchState.updatedAt))
    .limit(60)

  const seen = new Set<string>()
  const items: object[] = []
  for (const r of rows) {
    if (seen.has(r.videoId) || !r.title) continue
    seen.add(r.videoId)
    items.push({
      videoId: r.videoId,
      title: r.title,
      author: r.author ?? null,
      thumbnailUrl: `https://i.ytimg.com/vi/${r.videoId}/hqdefault.jpg`,
      positionSec: r.positionSec,
      durationSec: r.durationSec ?? null,
    })
    if (items.length >= 10) break
  }
  return c.json({ items }, 200, { 'Cache-Control': 'public, max-age=300' })
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

// ── Quick Connect: sign a TV in from your phone ──────────────────────────────────
// Nobody wants to type a PIN with a TV remote. The TV asks for a code and polls; a
// signed-in phone approves it; the TV's next poll gets the session. See lib/quickConnect.

// Unauthenticated by design: this is the pre-login step. It hands out nothing but a
// random code, which is useless until someone with a real session approves it.
auth.post('/quick-connect', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { label?: string }
  const req = createQuickConnect(body.label ?? 'A device')
  return c.json({ code: req.code, expiresAt: req.expiresAt })
})

// The waiting device polls here. Once approved, this mints its session cookie, once.
auth.get('/quick-connect/:code', async (c) => {
  const code = c.req.param('code')
  const req = getQuickConnect(code)
  if (!req) return c.json({ status: 'expired' })
  if (req.consumed) return c.json({ status: 'expired' })
  if (!req.approvedUserId) return c.json({ status: 'pending' })
  const userId = consumeQuickConnect(code)
  if (!userId) return c.json({ status: 'expired' })
  await issueSession(c, userId)
  return c.json({ status: 'approved' })
})

// The approver's side: list what's waiting, and approve one as yourself.
auth.get('/quick-connect', requireAuth, (c) => {
  return c.json({ pending: listPendingQuickConnects() })
})

auth.post('/quick-connect/:code/approve', requireAuth, (c) => {
  const user = c.get('user')
  const ok = approveQuickConnect(c.req.param('code'), user.id)
  if (!ok) return c.json({ error: 'That code is not valid anymore.' }, 404)
  return c.json({ ok: true })
})

export { auth }
