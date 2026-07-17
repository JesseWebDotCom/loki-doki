// Cast manager: the discovered-device cache, one active session per user, and the
// short-lived media-token store that lets a Cast device fetch a track it could
// never authenticate to directly (see routes/cast.ts media proxy).

import { CastSession, type CastMediaInfo, type CastStatus } from './client'
import { discoverCastDevices, type CastDevice } from './discovery'
import { logger } from '@/lib/logger'

// ── Device cache ────────────────────────────────────────────────────────────
let deviceCache: CastDevice[] = []
let lastDiscovery = 0

export async function listDevices(force = false): Promise<CastDevice[]> {
  if (force || Date.now() - lastDiscovery > 30_000 || deviceCache.length === 0) {
    deviceCache = await discoverCastDevices()
    lastDiscovery = Date.now()
  }
  return deviceCache
}

function findDevice(deviceId: string): CastDevice | null {
  return deviceCache.find((d) => d.id === deviceId) ?? null
}

// ── Sessions (one active cast target per user) ──────────────────────────────
interface UserCast { session: CastSession; device: CastDevice }
const sessions = new Map<string, UserCast>()

export async function castToDevice(userId: string, deviceId: string, media: CastMediaInfo): Promise<CastStatus> {
  const device = findDevice(deviceId) ?? (await listDevices(true), findDevice(deviceId))
  if (!device) throw new Error('That Cast device is no longer on the network.')

  let entry = sessions.get(userId)
  // Reuse the session only if it's still pointed at the same, still-connected device.
  if (entry && (entry.device.id !== deviceId || !entry.session.status.connected)) {
    try { entry.session.close() } catch { /* */ }
    sessions.delete(userId)
    entry = undefined
  }
  if (!entry) {
    const session = new CastSession(device.host, device.port)
    await session.connect()
    entry = { session, device }
    sessions.set(userId, entry)
  }
  await entry.session.loadMedia(media)
  return entry.session.status
}

export function controlCast(userId: string, action: 'play' | 'pause' | 'stop'): CastStatus | null {
  const entry = sessions.get(userId)
  if (!entry) return null
  if (action === 'play') entry.session.play()
  else if (action === 'pause') entry.session.pause()
  else if (action === 'stop') entry.session.stop()
  return entry.session.status
}

export function setCastVolume(userId: string, level: number): CastStatus | null {
  const entry = sessions.get(userId)
  if (!entry) return null
  entry.session.setVolume(level)
  return entry.session.status
}

export function disconnectCast(userId: string): void {
  const entry = sessions.get(userId)
  if (!entry) return
  try { entry.session.stop() } catch { /* */ }
  try { entry.session.close() } catch { /* */ }
  sessions.delete(userId)
}

export function castStatus(userId: string): { device: CastDevice; status: CastStatus } | null {
  const entry = sessions.get(userId)
  if (!entry) return null
  return { device: entry.device, status: entry.session.status }
}

// ── Media tokens ────────────────────────────────────────────────────────────
// A token maps to a same-origin stream path plus the casting user's cookie, so the
// proxy can re-fetch the bytes server-side (over localhost) and stream them to the
// Cast device, which carries no session of its own. Short-lived, in-memory only.
interface MediaToken { path: string; cookie: string; contentType: string; expiresAt: number }
const mediaTokens = new Map<string, MediaToken>()
const MEDIA_TTL_MS = 6 * 60 * 60 * 1000

export function mintMediaToken(path: string, cookie: string, contentType: string): string {
  sweepTokens()
  const token = crypto.randomUUID().replace(/-/g, '')
  mediaTokens.set(token, { path, cookie, contentType, expiresAt: Date.now() + MEDIA_TTL_MS })
  return token
}

export function resolveMediaToken(token: string): MediaToken | null {
  const entry = mediaTokens.get(token)
  if (!entry) return null
  if (entry.expiresAt < Date.now()) { mediaTokens.delete(token); return null }
  return entry
}

function sweepTokens(): void {
  const now = Date.now()
  if (mediaTokens.size < 200) return
  for (const [k, v] of mediaTokens) if (v.expiresAt < now) mediaTokens.delete(k)
}

/** Drop every session at shutdown so speakers aren't left holding a dead socket. */
export function shutdownCast(): void {
  for (const [, entry] of sessions) {
    try { entry.session.close() } catch { /* */ }
  }
  sessions.clear()
  logger.info('[cast] all sessions closed')
}
