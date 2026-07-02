import { createMiddleware } from 'hono/factory'
import { getCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { sessions, users } from '@/db/schema'
import { hashSessionToken } from '@/lib/session'
import type { AppEnv } from '@/types'

// In-memory TTL cache for session resolution — every authed request otherwise costs two DB
// queries and ~30 fire per home-page load. Keyed by token HASH (never hold raw tokens in
// memory). Only successful resolutions are cached, so invalid/expired tokens behave exactly
// as before; a cached session's own expiresAt is still checked per hit. The 10s TTL bounds
// staleness of user-row edits (profile changes); explicit invalidation covers logout,
// session revocation, and user deletion.
const SESSION_CACHE_TTL_MS = 10_000
const SESSION_CACHE_MAX = 500
interface CachedAuth { user: typeof users.$inferSelect; sessionExpiresAt: Date; cachedAt: number }
const sessionCache = new Map<string, CachedAuth>()

/** Drop the cache entry for one session token (call wherever that session row is deleted). */
export function invalidateSessionCache(token: string): void {
  sessionCache.delete(hashSessionToken(token))
}

/** Drop every cache entry for a user (call on user deletion / role change). */
export function invalidateSessionCacheForUser(userId: string): void {
  for (const [key, entry] of sessionCache) {
    if (entry.user.id === userId) sessionCache.delete(key)
  }
}

export async function resolveSession(token: string) {
  const tokenHash = hashSessionToken(token)

  const cached = sessionCache.get(tokenHash)
  if (cached && Date.now() - cached.cachedAt <= SESSION_CACHE_TTL_MS) {
    if (cached.sessionExpiresAt < new Date()) {
      sessionCache.delete(tokenHash)
      return null
    }
    return cached.user
  }
  if (cached) sessionCache.delete(tokenHash)

  const [session] = await db
    .select({ userId: sessions.userId, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1)

  if (!session || session.expiresAt < new Date()) return null

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1)

  if (user) {
    if (sessionCache.size >= SESSION_CACHE_MAX) {
      // Simple oldest-first eviction: Map iteration order is insertion order.
      const oldest = sessionCache.keys().next().value
      if (oldest !== undefined) sessionCache.delete(oldest)
    }
    sessionCache.set(tokenHash, { user, sessionExpiresAt: session.expiresAt, cachedAt: Date.now() })
  }

  return user ?? null
}

// CSRF defense-in-depth on top of the SameSite=Strict cookie: for state-changing methods,
// reject a request whose Origin host is not one we serve. Skipped in development so the Vite
// dev server (cross-origin :5173 → backend) keeps working; a request with no Origin header
// (same-origin navigations, non-browser clients) is allowed.
//
// Behind a TLS-terminating reverse proxy the browser's Origin carries the PUBLIC host while
// the backend's Host header carries the internal one, so a bare Host comparison would 403
// every mutating request. Accept the Origin if it matches the Host, the proxy-supplied
// X-Forwarded-Host, or a configured APP_ORIGIN/PUBLIC_ORIGIN.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
function crossSiteRejected(c: Context<AppEnv>): boolean {
  if (process.env.NODE_ENV === 'development') return false
  if (SAFE_METHODS.has(c.req.method)) return false
  const origin = c.req.header('origin')
  if (!origin) return false

  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    return true
  }

  const allowed = new Set<string>()
  const host = c.req.header('host')
  if (host) allowed.add(host)
  const forwarded = c.req.header('x-forwarded-host')
  if (forwarded) forwarded.split(',').forEach((h) => allowed.add(h.trim()))
  const configured = process.env.APP_ORIGIN ?? process.env.PUBLIC_ORIGIN
  if (configured) {
    try { allowed.add(new URL(configured).host) } catch { /* ignore malformed env */ }
  }

  return !allowed.has(originHost)
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (crossSiteRejected(c)) return c.json({ error: 'Cross-site request blocked' }, 403)
  const token = getCookie(c, 'session')
  if (!token) return c.json({ error: 'Unauthorized' }, 401)

  const user = await resolveSession(token)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  c.set('user', user)
  await next()
})

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (crossSiteRejected(c)) return c.json({ error: 'Cross-site request blocked' }, 403)
  const token = getCookie(c, 'session')
  if (!token) return c.json({ error: 'Unauthorized' }, 401)

  const user = await resolveSession(token)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  if (user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)

  c.set('user', user)
  await next()
})
