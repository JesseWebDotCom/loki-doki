// Device identity for Pods. A device is bound to a user (and optional companion +
// wake word) and authenticates the Wyoming gateway socket with a long-lived token.
//
// Pairing flow (mirrors how the hardware will provision):
//   1. Admin creates a device → gets a short pairing CODE (shown to the installer).
//   2. BLE provisioning hands the Pod the code; the Pod POSTs it to /api/pod/pair.
//   3. The server mints a device TOKEN (stored hashed), returns it once.
//   4. The Pod stores the token in flash and sends it on every gateway connect.

import { randomBytes, createHash } from 'node:crypto'
import { eq, and, gt } from 'drizzle-orm'
import { db } from '@/db'
import { devices } from '@/db/schema'

export type DeviceRow = typeof devices.$inferSelect

const PAIRING_TTL_MS = 15 * 60 * 1000 // a pairing code is valid for 15 minutes

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 6-char human-typeable pairing code (no ambiguous chars). */
function generatePairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(6)
  let out = ''
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i]! % alphabet.length]
  return out
}

export interface CreateDeviceInput {
  userId: string
  name: string
  kind?: string
  characterId?: string | null
  wakeWord?: string | null
}

/** Create a device and return it plus a fresh pairing code (not yet paired). */
export async function createDevice(input: CreateDeviceInput): Promise<{ device: DeviceRow; pairingCode: string }> {
  const now = new Date()
  const pairingCode = generatePairingCode()
  const id = crypto.randomUUID()
  await db.insert(devices).values({
    id,
    userId: input.userId,
    characterId: input.characterId ?? null,
    name: input.name,
    kind: input.kind ?? 'pod',
    wakeWord: input.wakeWord ?? null,
    tokenHash: null,
    pairingCode,
    pairingExpiresAt: new Date(now.getTime() + PAIRING_TTL_MS),
    capabilities: null,
    lastSeenAt: null,
    createdAt: now,
  })
  const [device] = await db.select().from(devices).where(eq(devices.id, id)).limit(1)
  return { device: device!, pairingCode }
}

/** Issue a fresh pairing code for an existing device (e.g. re-pair after reset). */
export async function refreshPairingCode(deviceId: string): Promise<string | null> {
  const code = generatePairingCode()
  const res = await db
    .update(devices)
    .set({ pairingCode: code, pairingExpiresAt: new Date(Date.now() + PAIRING_TTL_MS), tokenHash: null })
    .where(eq(devices.id, deviceId))
    .returning({ id: devices.id })
  return res.length ? code : null
}

export interface PairResult {
  deviceId: string
  token: string
  userId: string
  name: string
}

/**
 * Redeem a pairing code → mint a device token (returned ONCE, stored hashed).
 * Returns null if the code is unknown or expired.
 */
export async function redeemPairingCode(code: string, capabilities?: unknown): Promise<PairResult | null> {
  const normalized = code.trim().toUpperCase()
  const [device] = await db
    .select()
    .from(devices)
    .where(and(eq(devices.pairingCode, normalized), gt(devices.pairingExpiresAt, new Date())))
    .limit(1)
  if (!device) return null

  const token = randomBytes(32).toString('hex')
  await db
    .update(devices)
    .set({
      tokenHash: hashToken(token),
      pairingCode: null,
      pairingExpiresAt: null,
      capabilities: capabilities != null ? JSON.stringify(capabilities) : device.capabilities,
    })
    .where(eq(devices.id, device.id))

  return { deviceId: device.id, token, userId: device.userId, name: device.name }
}

/** Resolve a device by its token (gateway auth). Touches last_seen. Null if invalid. */
export async function authenticateDeviceToken(token: string): Promise<DeviceRow | null> {
  if (!token) return null
  const [device] = await db.select().from(devices).where(eq(devices.tokenHash, hashToken(token))).limit(1)
  if (!device) return null
  db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, device.id)).catch(() => {})
  return device
}

export async function listDevices(): Promise<DeviceRow[]> {
  return db.select().from(devices).orderBy(devices.createdAt)
}

export async function deleteDevice(id: string): Promise<void> {
  await db.delete(devices).where(eq(devices.id, id))
}
