// Auto-dim after local sunset — the honest substitute for "dim when the room goes dark":
// the Tab5 camera is MIPI-CSI (ESPHome has no capture platform for it, so it can't act as
// a light sensor) and the board has no ambient-light sensor. Time-of-day is what we've got.
//
// Reuses the EXISTING device-settings push channel (deviceSettings.ts → configToDevice) —
// no firmware change needed. This is a TRANSIENT override on top of a device's configured
// dimPercent: applied at sunset, reverted at sunrise, never written to the DB (so it can't
// clobber what the user actually configured).

import { db } from '@/db'
import { devices } from '@/db/schema'
import { effectiveSettings } from '@/lib/pod/deviceSettings'
import { configToDevice } from '@/lib/pod/registry'
import { userLocation } from '@/lib/pod/displayData'
import { isNightAt } from '@/lib/pod/sunTimes'
import { logger } from '@/lib/logger'

const CHECK_INTERVAL_MS = 5 * 60_000   // sunset/sunrise don't need second-by-second precision

// deviceId → whether night-dim is CURRENTLY applied (in-memory only; a restart just
// re-evaluates and re-applies on the next tick, which is harmless — dim is idempotent).
const applied = new Map<string, boolean>()

async function checkDevice(deviceId: string, userId: string, groupId: string | null): Promise<void> {
  const settings = await effectiveSettings(groupId)
  if (!settings.nightDimEnabled) {
    if (applied.has(deviceId)) applied.delete(deviceId)   // was on, admin/user turned it off — nothing to revert, next real config push wins
    return
  }
  const loc = await userLocation(userId)
  if (loc?.lat == null || loc?.lng == null) return   // no known location — can't compute sunset, skip quietly

  const night = isNightAt(loc.lat, loc.lng)
  const was = applied.get(deviceId) ?? false
  if (night === was) return   // no transition — don't re-push every tick

  applied.set(deviceId, night)
  const push = night
    ? { ...settings, dimEnabled: true, dimPercent: settings.nightDimPercent }
    : settings   // back to the device's normal (day) effective settings
  configToDevice(deviceId, push as unknown as Record<string, unknown>)
  logger.info(`[night-mode] device ${deviceId} → ${night ? 'night' : 'day'} (dim ${night ? settings.nightDimPercent : settings.dimPercent}%)`)
}

async function tick(): Promise<void> {
  try {
    const rows = await db.select({ id: devices.id, userId: devices.userId, groupId: devices.groupId }).from(devices)
    for (const r of rows) await checkDevice(r.id, r.userId, r.groupId)
  } catch (e) {
    logger.warn(`[night-mode] tick failed: ${(e as Error).message}`)
  }
}

let started = false
export function startNightMode(): void {
  if (started) return
  started = true
  void tick()
  setInterval(() => void tick(), CHECK_INTERVAL_MS)
}
