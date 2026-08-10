// Per-device credentials that outlive a change of address.
//
// The session cookie is scoped to one origin. A native client that fails over from
// https://hub.example.com to http://192.168.1.50:3000 lands on an empty cookie jar and
// looks signed out, which turns "the internet is down" into "everyone has to log in
// again". So native clients keep a long-lived device token in the OS keystore
// (Keychain / Electron safeStorage) and trade it for a session cookie on whichever
// address answered.
//
// The token is bound to the hub instance id: a token minted by this hub is refused
// anywhere else, and a client that has been re-pointed at a different hub gets a clean
// 401 instead of a confusing partial session.

import { randomBytes, createHash } from 'node:crypto'
import { and, eq, lt } from 'drizzle-orm'
import { db } from '@/db'
import { deviceTokens } from '@/db/schema'

const TTL_MS = 365 * 24 * 60 * 60 * 1000  // a year; a family TV should not be re-paired quarterly
const MAX_PER_USER = 20

export type DevicePlatform = 'desktop' | 'tv' | 'phone'

export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Mint a device token. The raw value is returned exactly once; only its hash is stored. */
export async function issueDeviceToken(
  userId: string,
  label: string,
  platform: DevicePlatform,
): Promise<{ token: string; expiresAt: Date }> {
  await pruneExpiredDeviceTokens()

  // Bound the per-user set so a client stuck in a re-pair loop cannot grow the table
  // without limit. Oldest first, and never touch the one we are about to write.
  const existing = await db.select({ id: deviceTokens.id, createdAt: deviceTokens.createdAt })
    .from(deviceTokens)
    .where(eq(deviceTokens.userId, userId))
  if (existing.length >= MAX_PER_USER) {
    const oldest = existing.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, existing.length - MAX_PER_USER + 1)
    for (const row of oldest) await db.delete(deviceTokens).where(eq(deviceTokens.id, row.id))
  }

  const token = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + TTL_MS)
  await db.insert(deviceTokens).values({
    id: crypto.randomUUID(),
    userId,
    tokenHash: hashDeviceToken(token),
    label: label.trim().slice(0, 60) || 'A device',
    platform,
    lastSeenAt: new Date(),
    lastSeenUrl: null,
    expiresAt,
    createdAt: new Date(),
  })
  return { token, expiresAt }
}

/** Resolve a device token to its user, stamping where it came in from. Returns null for
 *  unknown or expired tokens (the client's cue to walk the user through pairing again). */
export async function redeemDeviceToken(
  token: string,
  seenUrl: string | null,
): Promise<{ userId: string } | null> {
  const tokenHash = hashDeviceToken(token)
  const [row] = await db.select().from(deviceTokens)
    .where(eq(deviceTokens.tokenHash, tokenHash))
    .limit(1)
  if (!row) return null
  if (row.expiresAt < new Date()) {
    await db.delete(deviceTokens).where(eq(deviceTokens.id, row.id))
    return null
  }
  await db.update(deviceTokens)
    .set({ lastSeenAt: new Date(), lastSeenUrl: seenUrl })
    .where(eq(deviceTokens.id, row.id))
  return { userId: row.userId }
}

export async function listDeviceTokens(userId: string) {
  return db.select({
    id: deviceTokens.id,
    label: deviceTokens.label,
    platform: deviceTokens.platform,
    lastSeenAt: deviceTokens.lastSeenAt,
    lastSeenUrl: deviceTokens.lastSeenUrl,
    createdAt: deviceTokens.createdAt,
  }).from(deviceTokens).where(eq(deviceTokens.userId, userId))
}

export async function revokeDeviceToken(id: string, userId: string): Promise<boolean> {
  const res = await db.delete(deviceTokens)
    .where(and(eq(deviceTokens.id, id), eq(deviceTokens.userId, userId)))
  return (res as unknown as { changes?: number }).changes !== 0
}

export async function pruneExpiredDeviceTokens(): Promise<void> {
  await db.delete(deviceTokens).where(lt(deviceTokens.expiresAt, new Date()))
}
