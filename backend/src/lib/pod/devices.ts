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
import { invalidateHwidCache } from '@/lib/pod/displayRenderer'

export type DeviceRow = typeof devices.$inferSelect

const PAIRING_TTL_MS = 15 * 60 * 1000 // a pairing code is valid for 15 minutes

// Form-factor kind per known model id (mirrors the frontend catalog's `kind`). Used
// so a claimed/created device records the right kind instead of the generic 'dot' —
// which gates screen-only UI like the Testing tab. Unknown models fall back to 'pod'.
const MODEL_KIND: Record<string, string> = { 'atom-echo': 'dot', tab5: 'tablet' }
function kindForModel(model?: string | null): string | undefined {
  return model ? MODEL_KIND[model] : undefined
}

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
  model?: string | null
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
    model: input.model ?? null,
    tokenHash: null,
    pairingCode,
    pairingExpiresAt: new Date(now.getTime() + PAIRING_TTL_MS),
    capabilities: null,
    lastSeenAt: null,
    createdAt: now,
  })
  const [device] = await db.select().from(devices).where(eq(devices.id, id)).limit(1)
  invalidateHwidCache()
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

export interface ClaimDeviceInput {
  hwid: string
  userId: string
  name: string
  kind?: string
  characterId?: string | null
  wakeWord?: string | null
  model?: string | null
}

/**
 * One-tap claim for a screenless device that announced its hardware id: bind it to
 * a user and mint a token directly (no pairing code round-trip). Reuses the row for
 * a known hwid (re-claim after factory reset) so we don't accumulate duplicates.
 * The token is returned once; only its hash is stored.
 */
export async function claimDevice(input: ClaimDeviceInput): Promise<{ device: DeviceRow; token: string }> {
  const token = randomBytes(32).toString('hex')
  const tokenHash = hashToken(token)
  const [existing] = await db.select().from(devices).where(eq(devices.hwid, input.hwid)).limit(1)

  let id: string
  if (existing) {
    id = existing.id
    await db.update(devices).set({
      userId: input.userId,
      name: input.name,
      // Prefer an explicit kind; else derive from the model (fixing legacy 'dot' rows);
      // else keep what's there.
      kind: input.kind ?? kindForModel(input.model) ?? existing.kind,
      characterId: input.characterId ?? null,
      wakeWord: input.wakeWord ?? null,
      model: input.model ?? existing.model,
      tokenHash,
      pairingCode: null,
      pairingExpiresAt: null,
    }).where(eq(devices.id, id))
  } else {
    id = crypto.randomUUID()
    await db.insert(devices).values({
      id,
      userId: input.userId,
      characterId: input.characterId ?? null,
      name: input.name,
      kind: input.kind ?? kindForModel(input.model) ?? 'dot',
      wakeWord: input.wakeWord ?? null,
      model: input.model ?? null,
      hwid: input.hwid,
      tokenHash,
      pairingCode: null,
      pairingExpiresAt: null,
      capabilities: null,
      lastSeenAt: null,
      createdAt: new Date(),
    })
  }
  const [device] = await db.select().from(devices).where(eq(devices.id, id)).limit(1)
  invalidateHwidCache()
  return { device: device!, token }
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
  invalidateHwidCache()
}

export interface UpdateDeviceInput {
  name?: string
  userId?: string
  characterId?: string | null
  wakeWord?: string | null
  orientation?: number
}

/** Edit a device's settings (name, owner, companion, wake word). Only provided
 *  fields are changed. Returns the updated row, or null if the id is unknown. */
export async function updateDevice(id: string, input: UpdateDeviceInput): Promise<DeviceRow | null> {
  const patch: Partial<typeof devices.$inferInsert> = {}
  if (input.name !== undefined) patch.name = input.name
  if (input.userId !== undefined) patch.userId = input.userId
  if (input.characterId !== undefined) patch.characterId = input.characterId
  if (input.wakeWord !== undefined) patch.wakeWord = input.wakeWord
  if (input.orientation !== undefined) patch.orientation = input.orientation
  if (Object.keys(patch).length === 0) {
    const [row] = await db.select().from(devices).where(eq(devices.id, id)).limit(1)
    return row ?? null
  }
  const [row] = await db.update(devices).set(patch).where(eq(devices.id, id)).returning()
  invalidateHwidCache()
  return row ?? null
}
