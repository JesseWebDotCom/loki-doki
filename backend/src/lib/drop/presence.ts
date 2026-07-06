// Live registry of a user's connected browser "devices" for the Drop app. Unlike
// browserSession.ts (which targets only the most-recent tab), Drop needs to address a
// SPECIFIC device — "send to my tablet" — so we key by a stable per-device id the
// browser persists in localStorage. Each connection holds an SSE writer; producers
// look a device up by id and push it a DropEvent.

import { logger } from '@/lib/logger'

export interface DropEvent {
  type: 'incoming' | 'claimed' | 'hello' | 'ping'
  /** For 'incoming'/'claimed': the drop id + a lightweight preview. */
  drop?: {
    id: string
    kind: 'file' | 'text'
    fileName?: string | null
    mime?: string | null
    sizeBytes?: number | null
    body?: string | null
    senderLabel: string
    createdAt: number
  }
}

interface LiveDevice {
  label: string
  send: (evt: DropEvent) => void
  lastSeen: number
}

// userId → (deviceId → live connection). A device may briefly have two connections
// during a reconnect; last registration wins (its `send` overwrites the map entry).
const online = new Map<string, Map<string, LiveDevice>>()

/** Register a browser device's live SSE stream. Returns an unregister function. */
export function registerDropDevice(
  userId: string,
  deviceId: string,
  label: string,
  send: (evt: DropEvent) => void,
): () => void {
  if (!online.has(userId)) online.set(userId, new Map())
  const devices = online.get(userId)!
  const entry: LiveDevice = { label, send, lastSeen: Date.now() }
  devices.set(deviceId, entry)
  logger.info(`[drop] device online userId=${userId} device=${deviceId} (${label})`)
  return () => {
    const set = online.get(userId)
    if (set && set.get(deviceId) === entry) {
      // Only remove if we're still the current entry (don't clobber a reconnect).
      set.delete(deviceId)
      if (set.size === 0) online.delete(userId)
      logger.info(`[drop] device offline userId=${userId} device=${deviceId}`)
    }
  }
}

/** Online browser devices for a user, for the device picker. */
export function listDropDevices(userId: string): Array<{ deviceId: string; label: string }> {
  const set = online.get(userId)
  if (!set) return []
  return Array.from(set.entries()).map(([deviceId, d]) => ({ deviceId, label: d.label }))
}

export function isDeviceOnline(userId: string, deviceId: string): boolean {
  return !!online.get(userId)?.has(deviceId)
}

/** Push an event to one device, or (deviceId=null) to all of the user's devices
 *  except `exceptDeviceId` (the sender). Returns how many live streams received it. */
export function sendToDropDevice(
  userId: string,
  deviceId: string | null,
  evt: DropEvent,
  exceptDeviceId?: string,
): number {
  const set = online.get(userId)
  if (!set) return 0
  let reached = 0
  for (const [id, d] of set) {
    if (deviceId ? id !== deviceId : id === exceptDeviceId) continue
    try { d.send(evt); reached++ } catch { /* dead stream; unregister runs on close */ }
  }
  return reached
}
