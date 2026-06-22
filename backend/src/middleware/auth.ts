import { createMiddleware } from 'hono/factory'
import { getCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { sessions, users } from '@/db/schema'
import { hashSessionToken } from '@/lib/session'
import type { AppEnv } from '@/types'

export async function resolveSession(token: string) {
  const tokenHash = hashSessionToken(token)
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
