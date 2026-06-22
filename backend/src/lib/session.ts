import type { Context } from 'hono'
import { setCookie } from 'hono/cookie'
import { lt } from 'drizzle-orm'
import { randomBytes, createHash } from 'node:crypto'
import { db } from '@/db'
import { sessions } from '@/db/schema'

export function generateSessionToken(): string {
  return randomBytes(32).toString('hex')
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function sessionExpiresAt(): Date {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
}

// Delete all sessions whose expiry is in the past. Expired sessions are otherwise never
// removed (they just stop authenticating), so the table grows unbounded. Caller wiring
// (e.g. a boot/interval sweep) is handled elsewhere.
export async function pruneExpiredSessions(): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()))
}

// Shared by auth.ts (verify-pin / pin-free select) and setup.ts (auto-login after admin creation)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function issueSession(c: Context<any>, userId: string): Promise<void> {
  const token = generateSessionToken()
  const expiresAt = sessionExpiresAt()

  await db.insert(sessions).values({
    id: crypto.randomUUID(),
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt,
    createdAt: new Date(),
  })

  // Set Secure automatically when the request arrived over HTTPS (directly or via a
  // TLS-terminating reverse proxy) — without breaking plain-HTTP-on-LAN deployments,
  // where a Secure cookie would simply never be sent.
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim()
    ?? new URL(c.req.url).protocol.replace(':', '')

  setCookie(c, 'session', token, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: proto === 'https',
    expires: expiresAt,
    path: '/',
  })
}
