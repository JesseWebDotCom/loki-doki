// State + auth helpers for the gPodder-compatible sync API (routes/gpodder.ts).
//
// Auth is a per-user APP PASSWORD (generated in Podcast settings, hashed with the same
// Argon2id path as PINs), never the profile PIN itself. The gpodder username is the
// user's nickname, mirroring the KOSync convention. Deliberately import-light (db +
// schema only) so lib/podcast/feeds.ts can log subscription tombstones without a cycle.

import { randomUUID, randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { gpodderDevices, gpodderSubscriptionLog, userPreferences, users } from '@/db/schema'

const GPODDER_PASSWORD_PREF = 'podcasts.gpodder_password_hash'

export const nowEpochSec = (): number => Math.floor(Date.now() / 1000)

/** Record a subscribe/unsubscribe (in-app or device-driven) so gpodder clients can
 *  diff "what changed since T". Best-effort; callers swallow failures. */
export async function logSubscriptionChange(
  userId: string,
  feedUrl: string,
  action: 'subscribe' | 'unsubscribe',
  deviceId?: string | null,
): Promise<void> {
  await db.insert(gpodderSubscriptionLog).values({
    id: randomUUID(), userId, feedUrl, action,
    deviceId: deviceId ?? null,
    timestamp: nowEpochSec(),
    createdAt: new Date(),
  })
}

/** Generate (or replace) the user's gpodder app password. Returns the PLAINTEXT once;
 *  only the Argon2id hash is stored. */
export async function generateGpodderPassword(userId: string): Promise<string> {
  // 20 chars from an unambiguous alphabet: easy to type into a phone once.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = randomBytes(20)
  let password = ''
  for (let i = 0; i < bytes.length; i++) password += alphabet[bytes[i]! % alphabet.length]
  const hash = await Bun.password.hash(password, { algorithm: 'argon2id' })
  const now = new Date()
  await db.insert(userPreferences).values({
    id: randomUUID(), userId, key: GPODDER_PASSWORD_PREF, value: JSON.stringify(hash), updatedAt: now,
  }).onConflictDoUpdate({
    target: [userPreferences.userId, userPreferences.key],
    set: { value: JSON.stringify(hash), updatedAt: now },
  })
  return password
}

export async function revokeGpodderPassword(userId: string): Promise<void> {
  await db.delete(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, GPODDER_PASSWORD_PREF)))
}

export async function gpodderPasswordSet(userId: string): Promise<boolean> {
  const [row] = await db.select({ value: userPreferences.value }).from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, GPODDER_PASSWORD_PREF))).limit(1)
  return Boolean(row?.value)
}

/** Resolve a Basic-auth username/password pair to a user id. Username matches the
 *  user's nickname case-insensitively; password verifies against the stored app
 *  password hash. Null on any mismatch (never throws). */
export async function verifyGpodderCredentials(username: string, password: string): Promise<string | null> {
  if (!username || !password) return null
  const rows = await db.select({ id: users.id, nickname: users.nickname }).from(users)
  const user = rows.find(u => u.nickname.toLowerCase() === username.toLowerCase())
  if (!user) return null
  const [pref] = await db.select({ value: userPreferences.value }).from(userPreferences)
    .where(and(eq(userPreferences.userId, user.id), eq(userPreferences.key, GPODDER_PASSWORD_PREF))).limit(1)
  if (!pref?.value) return null
  let hash: string
  try { hash = JSON.parse(pref.value) as string } catch { return null }
  try {
    return (await Bun.password.verify(password, hash)) ? user.id : null
  } catch {
    return null
  }
}

/** Upsert a device row (registration + heartbeat on every authenticated call). */
export async function touchDevice(userId: string, deviceId: string, data?: { caption?: string; type?: string }): Promise<void> {
  const now = new Date()
  await db.insert(gpodderDevices).values({
    id: randomUUID(), userId, deviceId,
    caption: data?.caption?.slice(0, 120) ?? null,
    type: data?.type?.slice(0, 40) ?? null,
    lastSeenAt: now, createdAt: now,
  }).onConflictDoUpdate({
    target: [gpodderDevices.userId, gpodderDevices.deviceId],
    set: {
      lastSeenAt: now,
      ...(data?.caption !== undefined ? { caption: data.caption.slice(0, 120) } : {}),
      ...(data?.type !== undefined ? { type: data.type.slice(0, 40) } : {}),
    },
  })
}

export async function listDevices(userId: string) {
  return db.select().from(gpodderDevices).where(eq(gpodderDevices.userId, userId))
}
