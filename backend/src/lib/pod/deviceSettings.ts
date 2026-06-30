// Central device settings, organized as groups.
//
//   • A built-in "Default" group (id 'default', is_default=1) holds the baseline.
//   • Admin-created groups override specific keys; what they don't set inherits Default.
//   • Each device belongs to exactly one group (devices.group_id null → Default).
//   • A device's EFFECTIVE settings = Default merged with its group's overrides.
//
// Settings are delivered to devices over the live gateway (deviceConfig event), so
// changing a group re-deploys to every online device in it, and a device that was
// offline pulls its group's current settings the moment it (re)connects. No re-flash.

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { deviceGroups, devices } from '@/db/schema'
import { configToDevice } from '@/lib/pod/registry'
import { logger } from '@/lib/logger'

// The settings a device understands. Extend as we add more (volume, brightness, …).
export type ResponseLength = 'inherit' | 'auto' | 'brief' | 'balanced' | 'detailed'
export const RESPONSE_LENGTHS: ResponseLength[] = ['inherit', 'auto', 'brief', 'balanced', 'detailed']

export interface DeviceSettings {
  /** Dim the screen after a period of no interaction (screen devices only). */
  dimEnabled: boolean
  /** Idle brightness as a percent (0–100). */
  dimPercent: number
  /** Seconds of no interaction before dimming. */
  dimAfterS: number
  /** Reply length for conversations on this device — overrides the companion's own
   *  reply style ('inherit' = leave the companion's choice). */
  responseLength: ResponseLength
  /** Show the companion's reply as text on this screen device (false = voice only). */
  showReplyText: boolean
  /** Override the wake-word detector's threshold (0.1–0.99). Null = use the model's
   *  calibrated value (from train_wakeword.py FA/hr calibration). Raise for noisy rooms
   *  where music/TV triggers false wakes; lower if the phrase stops being detected. */
  wakeThreshold: number | null
}

export const DEFAULT_SETTINGS: DeviceSettings = { dimEnabled: false, dimPercent: 30, dimAfterS: 60, responseLength: 'inherit', showReplyText: true, wakeThreshold: null }

const DEFAULT_GROUP_ID = 'default'

/** Clamp + whitelist an incoming (possibly partial) settings patch. */
export function sanitizeSettings(p: Record<string, unknown>): Partial<DeviceSettings> {
  const out: Partial<DeviceSettings> = {}
  if (typeof p.dimEnabled === 'boolean') out.dimEnabled = p.dimEnabled
  if (typeof p.dimPercent === 'number') out.dimPercent = Math.max(0, Math.min(100, Math.round(p.dimPercent)))
  if (typeof p.dimAfterS === 'number') out.dimAfterS = Math.max(5, Math.min(3600, Math.round(p.dimAfterS)))
  if (typeof p.responseLength === 'string' && RESPONSE_LENGTHS.includes(p.responseLength as ResponseLength))
    out.responseLength = p.responseLength as ResponseLength
  if (typeof p.showReplyText === 'boolean') out.showReplyText = p.showReplyText
  if (p.wakeThreshold === null) out.wakeThreshold = null
  else if (typeof p.wakeThreshold === 'number' && Number.isFinite(p.wakeThreshold))
    out.wakeThreshold = Math.max(0.1, Math.min(0.99, p.wakeThreshold))
  return out
}

function parseSettings(json: string): Partial<DeviceSettings> {
  try { return sanitizeSettings(JSON.parse(json) as Record<string, unknown>) } catch { return {} }
}

export interface DeviceGroup {
  id: string
  name: string
  isDefault: boolean
  /** For the Default group this is the full baseline; for others it's the overrides. */
  settings: Partial<DeviceSettings>
  createdAt: number
}

function rowToGroup(r: typeof deviceGroups.$inferSelect): DeviceGroup {
  return {
    id: r.id,
    name: r.name,
    isDefault: !!r.isDefault,
    settings: parseSettings(r.settings),
    createdAt: r.createdAt instanceof Date ? r.createdAt.getTime() : Number(r.createdAt),
  }
}

export async function listGroups(): Promise<DeviceGroup[]> {
  const rows = await db.select().from(deviceGroups)
  // Default first, then by name.
  return rows.map(rowToGroup).sort((a, b) =>
    a.isDefault === b.isDefault ? a.name.localeCompare(b.name) : a.isDefault ? -1 : 1)
}

/** Baseline = hardcoded defaults overlaid with the Default group's stored values. */
export async function getDefaultSettings(): Promise<DeviceSettings> {
  const [d] = await db.select().from(deviceGroups).where(eq(deviceGroups.id, DEFAULT_GROUP_ID)).limit(1)
  return { ...DEFAULT_SETTINGS, ...(d ? parseSettings(d.settings) : {}) }
}

/** Effective settings for a group id (null/'default' → just the baseline). */
export async function effectiveSettings(groupId: string | null | undefined): Promise<DeviceSettings> {
  const base = await getDefaultSettings()
  if (!groupId || groupId === DEFAULT_GROUP_ID) return base
  const [g] = await db.select().from(deviceGroups).where(eq(deviceGroups.id, groupId)).limit(1)
  return { ...base, ...(g ? parseSettings(g.settings) : {}) }
}

// ── group CRUD ──────────────────────────────────────────────────────────────

export async function createGroup(name: string): Promise<DeviceGroup> {
  const id = crypto.randomUUID()
  await db.insert(deviceGroups).values({ id, name: name.trim() || 'Group', isDefault: false, settings: '{}', createdAt: new Date() })
  const [r] = await db.select().from(deviceGroups).where(eq(deviceGroups.id, id)).limit(1)
  return rowToGroup(r!)
}

/** Update a group's name and/or settings overrides; re-deploys to its devices and
 *  reports how many were online (vs. will sync on reconnect). */
export async function updateGroup(
  id: string,
  patch: { name?: string; settings?: Record<string, unknown> },
): Promise<{ group: DeviceGroup; deploy: DeployResult } | null> {
  const [existing] = await db.select().from(deviceGroups).where(eq(deviceGroups.id, id)).limit(1)
  if (!existing) return null
  const set: Partial<typeof deviceGroups.$inferInsert> = {}
  if (patch.name !== undefined) set.name = patch.name.trim() || existing.name
  if (patch.settings !== undefined) {
    // Merge the patch into the group's existing overrides (so a single toggle PUT works).
    set.settings = JSON.stringify({ ...parseSettings(existing.settings), ...sanitizeSettings(patch.settings) })
  }
  if (Object.keys(set).length) await db.update(deviceGroups).set(set).where(eq(deviceGroups.id, id))
  const [r] = await db.select().from(deviceGroups).where(eq(deviceGroups.id, id)).limit(1)
  // Changing the Default group affects every device; a custom group only its members.
  const deploy = id === DEFAULT_GROUP_ID ? await deployToAll() : await deployToGroup(id)
  return { group: rowToGroup(r!), deploy }
}

export async function deleteGroup(id: string): Promise<boolean> {
  if (id === DEFAULT_GROUP_ID) return false  // can't delete the built-in Default
  // Move its devices back to Default, then drop the group + re-deploy them.
  const members = await db.select({ id: devices.id }).from(devices).where(eq(devices.groupId, id))
  await db.update(devices).set({ groupId: null }).where(eq(devices.groupId, id))
  await db.delete(deviceGroups).where(eq(deviceGroups.id, id))
  for (const m of members) await deployToDevice(m.id)
  return true
}

/** Move a device into a group (null → Default); re-deploys that device immediately. */
export async function assignDeviceGroup(deviceId: string, groupId: string | null): Promise<void> {
  await db.update(devices).set({ groupId: groupId === DEFAULT_GROUP_ID ? null : groupId }).where(eq(devices.id, deviceId))
  await deployToDevice(deviceId)
}

// ── deployment (push effective settings over the gateway) ─────────────────────

/** How a deploy landed: `online` devices got it now; the rest sync when they connect. */
export interface DeployResult { online: number; total: number }

/** Push a single device's effective settings to its live session. Returns true if the
 *  device was online and received it now. */
export async function deployToDevice(deviceId: string): Promise<boolean> {
  const [d] = await db.select({ groupId: devices.groupId }).from(devices).where(eq(devices.id, deviceId)).limit(1)
  if (!d) return false
  const settings = await effectiveSettings(d.groupId)
  return configToDevice(deviceId, settings as unknown as Record<string, unknown>)
}

/** Re-deploy to every device in a group; reports how many were online. */
export async function deployToGroup(groupId: string): Promise<DeployResult> {
  const members = await db.select({ id: devices.id }).from(devices).where(eq(devices.groupId, groupId))
  let online = 0
  for (const m of members) if (await deployToDevice(m.id)) online++
  return { online, total: members.length }
}

/** Re-deploy to every device (used when the Default group changes). */
export async function deployToAll(): Promise<DeployResult> {
  const all = await db.select({ id: devices.id }).from(devices)
  let online = 0
  for (const m of all) if (await deployToDevice(m.id)) online++
  logger.info(`[pod-settings] re-deployed Default settings (${online}/${all.length} online)`)
  return { online, total: all.length }
}
