// Listening Together: typed client for /api/together (presence, devices, remote
// commands, Family Jam). Command shape mirrors backend/src/lib/together/commands.ts.

export type PlayerSource = 'radio' | 'liveRadio' | 'podcast'

export interface PlayerSnapshot {
  source: PlayerSource
  title: string
  artist: string | null
  cover: string
  positionSec: number
  durationSec: number
  playing: boolean
  volume: number
}

export interface TogetherDevice {
  deviceId: string
  userId: string
  userName: string
  label: string
  name: string
  named: boolean
  state: PlayerSnapshot | null
  lastSeenMs: number
}

export type TogetherCommandKind =
  | 'toggle' | 'play' | 'pause' | 'next' | 'seek' | 'volume' | 'stop'
  | 'play_station' | 'play_video' | 'play_episode'
  | 'queue_track' | 'queue_episode'

export interface TogetherCommand {
  kind: TogetherCommandKind
  positionSec?: number
  volume?: number
  stationId?: string
  seedType?: 'artist' | 'song' | 'genre'
  seed?: string
  videoId?: string
  title?: string
  artist?: string | null
  thumbnail?: string
  episodeId?: string
  showId?: string
  showName?: string
  coverUrl?: string
  fromName?: string
}

export interface JamItem {
  id: string
  videoId: string
  title: string
  author: string | null
  thumbnail: string
  addedByName: string
}

export interface Jam {
  id: string
  name: string
  hostUserId: string
  hostName: string
  hostDeviceId: string
  createdAt: number
  items: JamItem[]
}

async function tfetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/together${path}`, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? `together ${path} -> ${res.status}`)
  }
  return res.json() as Promise<T>
}
const body = (v: unknown) => JSON.stringify(v)

// ── Presence ─────────────────────────────────────────────────────────────────────
export function reportPresence(deviceId: string, label: string, state: PlayerSnapshot | null) {
  return tfetch<{ ok: boolean }>('/presence', { method: 'POST', body: body({ deviceId, label, state }) })
}

/** Best-effort pagehide beacon so a closed tab leaves the device list promptly. */
export function clearPresenceBeacon(deviceId: string): void {
  try {
    navigator.sendBeacon(
      '/api/together/presence/clear',
      new Blob([JSON.stringify({ deviceId })], { type: 'application/json' }),
    )
  } catch { /* best-effort */ }
}

export function listDevices() {
  return tfetch<{ devices: TogetherDevice[] }>('/devices')
}

export function renameDevice(deviceId: string, name: string) {
  return tfetch<{ ok: boolean; name: string }>(`/devices/${deviceId}/name`, { method: 'PUT', body: body({ name }) })
}

// ── Remote commands ──────────────────────────────────────────────────────────────
export function sendCommand(deviceId: string, command: TogetherCommand) {
  return tfetch<{ ok: boolean; delivered: boolean }>('/command', { method: 'POST', body: body({ deviceId, command }) })
}

// ── Family Jam ───────────────────────────────────────────────────────────────────
export function getJam() {
  return tfetch<{ jam: Jam | null }>('/jam')
}

export function startJam(deviceId: string, queue: Array<{ videoId: string; title: string; author: string | null; thumbnail: string }>) {
  return tfetch<{ jam: Jam }>('/jam/start', { method: 'POST', body: body({ deviceId, queue }) })
}

export function endJam() {
  return tfetch<{ ok: boolean }>('/jam/end', { method: 'POST', body: body({}) })
}

export function addJamItem(track: { videoId: string; title: string; author: string | null; thumbnail: string }) {
  return tfetch<{ jam: Jam }>('/jam/items', { method: 'POST', body: body(track) })
}

export function reorderJam(itemIds: string[]) {
  return tfetch<{ jam: Jam }>('/jam/reorder', { method: 'PUT', body: body({ itemIds }) })
}

export function removeJamItem(itemId: string) {
  return tfetch<{ jam: Jam }>(`/jam/items/${itemId}`, { method: 'DELETE' })
}

export function consumeJamItem(itemId: string) {
  return tfetch<{ jam: Jam }>('/jam/consume', { method: 'POST', body: body({ itemId }) })
}
