// Live data feed for the NATIVE LVGL device dashboard (renderer: 'lvgl').
//
// A native device draws its own clock/date from on-board SNTP, but it can't reach
// open-meteo from behind the home LAN — so the server fetches the weather for the
// device's user location and pushes it (plus whether a family photo is configured)
// over the gateway as a `display.data` user-event. Pushed on (re)connect, whenever the
// device's layout changes, and on a slow refresh timer. The JPEG path doesn't use this
// (the React /display page fetches its own weather in the headless tab).

import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { devices, userPreferences } from '@/db/schema'
import { logger } from '@/lib/logger'
import { weatherSnapshot, type WeatherSnapshot } from '@/lib/briefing/sources/weather'
import { dataToDevice, connectedDeviceIds } from '@/lib/pod/registry'
import { rendererForTemplateId, DEFAULT_TEMPLATE_ID } from '@/lib/pod/deviceStudio'
import { deviceByHwid } from '@/lib/pod/displayRenderer'
import { getNowPlaying } from '@/lib/pod/nowPlaying'

// The media shape the device's native player bar consumes. `rev` only changes on a NEW
// track (so the device can re-show a dismissed bar), not on every position update.
export interface DeviceMedia {
  title: string
  artist: string
  isPlaying: boolean
  position: number
  duration: number
  canSeek: boolean
  cover: boolean       // art available → the device fetches it from /api/pod/cover/:hwid
  rev: number
}

export interface DisplayDataPayload {
  weather: {
    location: string
    temp: number
    high: number
    low: number
    code: number
    is_day: boolean
    text: string
    unit: string
  } | null
  photo: boolean       // a family photo is configured for this device → device fetches it
  photo_rev: number    // changes when the configured photo changes (cache-bust)
  media: DeviceMedia | null   // the user's current playback (for the native player bar)
}

/** Fold an arbitrary id into a small stable uint32 — the firmware reads `rev` into a plain
 *  `int`, so this keeps it well within range regardless of what's hashed. */
function trackRev(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (Math.imul(31, h) + id.charCodeAt(i)) | 0
  return h >>> 0
}

// Per-location weather cache (open-meteo is slow + rate-limited; the dashboard only
// needs ~10-minute freshness). Keyed by the location's displayName.
const WEATHER_TTL_MS = 10 * 60 * 1000
const weatherCache = new Map<string, { at: number; snap: WeatherSnapshot }>()

// The `user.location` preference (set by the web app's location picker).
export interface UserLocationPref { lat?: number; lng?: number; displayName?: string }

/** Exported for reuse by nightMode.ts (sunset needs the same per-user lat/lng). */
export async function userLocation(userId: string): Promise<UserLocationPref | null> {
  const [row] = await db.select({ value: userPreferences.value }).from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, 'user.location')))
  if (!row?.value) return null
  try {
    const loc = JSON.parse(row.value) as UserLocationPref
    return loc && (loc.displayName || (loc.lat != null && loc.lng != null)) ? loc : null
  } catch { return null }
}

async function weatherForLocation(loc: UserLocationPref): Promise<WeatherSnapshot | null> {
  const key = (loc.displayName || `${loc.lat},${loc.lng}`).trim().toLowerCase()
  if (!key) return null
  const hit = weatherCache.get(key)
  if (hit && Date.now() - hit.at < WEATHER_TTL_MS) return hit.snap
  try {
    const snap = await weatherSnapshot({ location: loc.displayName, lat: loc.lat, lng: loc.lng, unit: 'fahrenheit' })
    weatherCache.set(key, { at: Date.now(), snap })
    return snap
  } catch (e) {
    logger.warn(`[pod] weather fetch failed for "${key}": ${(e as Error).message}`)
    return hit?.snap ?? null   // serve a stale value over nothing
  }
}

/** Non-blocking variant for latency-sensitive pushes (a fresh play should show up on the
 *  device instantly, not wait on a cold open-meteo round trip). Serves whatever's cached —
 *  even past its TTL — and kicks a background refresh; never awaits the network itself.
 *  The 30s connected-device refresher (below) converges on fresh weather shortly after. */
function weatherForLocationFast(loc: UserLocationPref): WeatherSnapshot | null {
  const key = (loc.displayName || `${loc.lat},${loc.lng}`).trim().toLowerCase()
  if (!key) return null
  const hit = weatherCache.get(key)
  if (!hit || Date.now() - hit.at >= WEATHER_TTL_MS) void weatherForLocation(loc).catch(() => {})
  return hit?.snap ?? null
}

/** The family-photo URL configured for a device (by hwid), or null. Used by the image
 *  endpoint the device fetches. Single image today; the same channel will serve a
 *  THUMBNAIL ATLAS for the stream-deck controller (one fetch, many tiles) — see
 *  /api/pod/image route. */
export async function resolveDevicePhotoUrl(hwid: string): Promise<string | null> {
  const dev = await deviceByHwid(hwid)
  if (!dev) return null
  const [row] = await db.select({ ov: devices.layoutOverrides }).from(devices).where(eq(devices.id, dev.id))
  const url = parseOverrides(row?.ov).photoUrl?.trim()
  return url || null
}

/** A small stable number that changes whenever the configured photo URL changes, so
 *  the device knows to re-fetch (used as a ?rev= cache-buster on the image request). */
function revOf(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h >>> 0
}

interface LayoutOverrides { photoUrl?: string }
function parseOverrides(s: string | null | undefined): LayoutOverrides {
  try { return s ? (JSON.parse(s) as LayoutOverrides) : {} } catch { return {} }
}

/** Build the `display.data` payload for a device (its user's weather + photo state).
 *  `fast: true` never blocks on a cold weather fetch — used for now-playing-triggered
 *  pushes, where the media update needs to land instantly and weather can lag a beat. */
export async function buildDisplayData(deviceId: string, opts?: { fast?: boolean }): Promise<DisplayDataPayload | null> {
  const [dev] = await db.select().from(devices).where(eq(devices.id, deviceId))
  if (!dev) return null
  const photoUrl = parseOverrides(dev.layoutOverrides).photoUrl?.trim() || ''
  let weather: DisplayDataPayload['weather'] = null
  const loc = await userLocation(dev.userId)
  if (loc) {
    const snap = opts?.fast ? weatherForLocationFast(loc) : await weatherForLocation(loc)
    if (snap) {
      weather = {
        location: snap.location, temp: snap.temp, high: snap.high, low: snap.low,
        code: snap.code, is_day: snap.isDay, text: snap.text, unit: snap.unit,
      }
    }
  }
  const np = getNowPlaying(dev.userId)
  const media: DeviceMedia | null = np ? {
    title: np.title,
    artist: np.artist ?? '',
    isPlaying: np.playing,
    position: Math.round(np.positionSec),
    duration: Math.round(np.durationSec),
    canSeek: np.durationSec > 0,
    cover: !!np.cover?.trim(),
    // sessionId is a fresh id per play session (see nowPlaying.ts), so replaying the same
    // track after a device-side dismiss still un-hides the bar — a pure track-identity hash
    // would stay hidden forever for a repeated title/videoId.
    rev: trackRev(np.sessionId),
  } : null
  return { weather, photo: !!photoUrl, photo_rev: photoUrl ? revOf(photoUrl) : 0, media }
}

/** Push the live data feed to every connected LVGL device owned by a user (used when the
 *  user's media playback changes, so their device player updates immediately). Always
 *  `fast` — a play/pause/track-change should land on-screen without waiting on weather. */
export async function pushDisplayDataForUser(userId: string): Promise<void> {
  const ids = connectedDeviceIds()
  if (!ids.size) return
  const rows = await db.select({ id: devices.id, tpl: devices.layoutTemplateId, uid: devices.userId }).from(devices)
  for (const r of rows) {
    if (r.uid === userId && ids.has(r.id) && isLvglDevice(r.tpl)) await pushDisplayData(r.id, { fast: true })
  }
}

/** True when this device is currently assigned a native-LVGL template. */
function isLvglDevice(layoutTemplateId: string | null): boolean {
  return rendererForTemplateId(layoutTemplateId ?? DEFAULT_TEMPLATE_ID) === 'lvgl'
}

/** Push the live data feed to a device (no-op if it isn't connected). Safe to call
 *  for any device — only LVGL devices act on it, but it's cheap and harmless either way. */
export async function pushDisplayData(deviceId: string, opts?: { fast?: boolean }): Promise<void> {
  try {
    const payload = await buildDisplayData(deviceId, opts)
    if (payload) dataToDevice(deviceId, payload as unknown as Record<string, unknown>)
  } catch (e) {
    logger.warn(`[pod] pushDisplayData failed: ${(e as Error).message}`)
  }
}

// ── Slow refresher: re-push weather to every connected LVGL device ────────────────
let timer: ReturnType<typeof setInterval> | null = null
// 30s (not 10min): a device that missed a now-playing push — so its media bar is wrongly
// hidden, or its weather is stale — self-heals within one cycle. Weather is cached, so this
// is cheap. (The now-playing itself is only re-pushed here; the atlas self-heals device-side.)
const REFRESH_MS = 30 * 1000

export function startDisplayDataRefresher(): void {
  if (timer) return
  timer = setInterval(() => { void refreshConnected() }, REFRESH_MS)
  if (typeof timer.unref === 'function') timer.unref()
}

async function refreshConnected(): Promise<void> {
  const ids = connectedDeviceIds()
  if (!ids.size) return
  const rows = await db.select({ id: devices.id, tpl: devices.layoutTemplateId }).from(devices)
  for (const r of rows) {
    if (ids.has(r.id) && isLvglDevice(r.tpl)) await pushDisplayData(r.id)
  }
}
