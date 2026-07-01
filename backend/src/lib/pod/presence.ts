// Unified per-user presence store for screen Pod display modes.
//
// Four distinct registers:
//   STATUS   — deliberate broadcast (Available/Busy/DND/etc.). Persisted in user_preferences
//              (key 'pod.status') so it survives restarts. Mirrored in statusCache for fast reads.
//   SLEEP    — dim/blank + optional ambient sound. Persisted (key 'pod.sleep').
//   ACTIVITY — auto-derived from the browser's now-playing push + the Plex session poller.
//              In-memory only (nowPlaying.ts).
//
// The display SPA polls GET /api/pod/presence?deviceId= every 5 s. This module is the
// single read path; routes/pod.ts (or deviceStudio.ts) wraps it in the endpoint.

import { db } from '@/db'
import { userPreferences } from '@/db/schema'
import { and, eq } from 'drizzle-orm'
import { getNowPlaying, getPlexActivity, type NowPlaying, type PlexActivity } from './nowPlaying'

// ── Status ────────────────────────────────────────────────────────────────────────

export type StatusState =
  | 'available' | 'busy' | 'dnd' | 'on_call'
  | 'in_meeting' | 'focusing' | 'brb' | 'away' | 'custom'

export const STATUS_COLORS: Record<StatusState, string> = {
  available: '#22c55e',   // green-500
  busy: '#ef4444',        // red-500
  dnd: '#7c3aed',         // violet-600
  on_call: '#f97316',     // orange-500
  in_meeting: '#f97316',  // orange-500
  focusing: '#3b82f6',    // blue-500
  brb: '#eab308',         // yellow-500
  away: '#6b7280',        // gray-500
  custom: '#6b7280',
}

export const STATUS_LABELS: Record<StatusState, string> = {
  available: 'Available',
  busy: 'Busy',
  dnd: 'Do Not Disturb',
  on_call: 'On a Call',
  in_meeting: 'In a Meeting',
  focusing: 'Focusing',
  brb: 'BRB',
  away: 'Away',
  custom: '',
}

export interface UserStatus {
  state: StatusState
  label: string           // display label (may override STATUS_LABELS default)
  color: string           // hex color
  timerEndsAt: number | null  // epoch ms; null = no expiry
  source: 'manual' | 'companion' | 'api'
  setAt: number
}

// In-memory cache — hydrated from DB on first read per user + on write
const statusCache = new Map<string, UserStatus | null>()

async function readStatusFromDb(userId: string): Promise<UserStatus | null> {
  const [row] = await db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, 'pod.status')))
    .limit(1)
  if (!row) return null
  try {
    const parsed = JSON.parse(row.value) as Partial<UserStatus>
    if (!parsed.state) return null
    // Auto-clear expired statuses — don't serve stale ones after a restart.
    if (parsed.timerEndsAt && Date.now() > parsed.timerEndsAt) {
      void clearUserStatus(userId)
      return null
    }
    return {
      state: parsed.state,
      label: parsed.label ?? STATUS_LABELS[parsed.state] ?? parsed.state,
      color: parsed.color ?? STATUS_COLORS[parsed.state] ?? '#6b7280',
      timerEndsAt: parsed.timerEndsAt ?? null,
      source: parsed.source ?? 'manual',
      setAt: parsed.setAt ?? Date.now(),
    }
  } catch {
    return null
  }
}

export async function getUserStatus(userId: string): Promise<UserStatus | null> {
  if (!statusCache.has(userId)) {
    statusCache.set(userId, await readStatusFromDb(userId))
  }
  const s = statusCache.get(userId) ?? null
  // Clear if the timer has expired since we last cached it.
  if (s?.timerEndsAt && Date.now() > s.timerEndsAt) {
    void clearUserStatus(userId)
    return null
  }
  return s
}

export async function setUserStatus(userId: string, update: {
  state: StatusState
  label?: string
  color?: string
  durationMin?: number
  source?: UserStatus['source']
}): Promise<UserStatus> {
  const setAt = Date.now()
  const timerEndsAt = update.durationMin ? setAt + update.durationMin * 60_000 : null
  const status: UserStatus = {
    state: update.state,
    label: update.label ?? STATUS_LABELS[update.state] ?? update.state,
    color: update.color ?? STATUS_COLORS[update.state] ?? '#6b7280',
    timerEndsAt,
    source: update.source ?? 'manual',
    setAt,
  }
  statusCache.set(userId, status)
  if (timerEndsAt) {
    timedStatusExpiry.set(userId, { endsAt: timerEndsAt, state: update.state })
  } else {
    timedStatusExpiry.delete(userId)
  }
  await upsertPref(userId, 'pod.status', status)
  return status
}

export async function clearUserStatus(userId: string): Promise<void> {
  statusCache.set(userId, null)
  timedStatusExpiry.delete(userId)
  await db.delete(userPreferences).where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, 'pod.status')))
}

// ── Sleep ─────────────────────────────────────────────────────────────────────────

export interface SleepConfig {
  active: boolean
  dimBrightness: number                    // 0 = off, 0.05 = dim clock
  ambientSound: 'rain' | 'white_noise' | 'ocean' | 'fan' | null
  ambientVolume: number
  source: 'manual' | 'companion' | 'schedule'
  setAt: number
}

const sleepCache = new Map<string, SleepConfig | null>()

async function readSleepFromDb(userId: string): Promise<SleepConfig | null> {
  const [row] = await db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, 'pod.sleep')))
    .limit(1)
  if (!row) return null
  try { return JSON.parse(row.value) as SleepConfig } catch { return null }
}

export async function getUserSleep(userId: string): Promise<SleepConfig | null> {
  if (!sleepCache.has(userId)) {
    sleepCache.set(userId, await readSleepFromDb(userId))
  }
  return sleepCache.get(userId) ?? null
}

export async function setUserSleep(userId: string, opts: Partial<SleepConfig> & { active: boolean }): Promise<SleepConfig> {
  const config: SleepConfig = {
    active: opts.active,
    dimBrightness: opts.dimBrightness ?? (opts.active ? 0.05 : 1),
    ambientSound: opts.ambientSound ?? null,
    ambientVolume: opts.ambientVolume ?? 0.4,
    source: opts.source ?? 'manual',
    setAt: Date.now(),
  }
  sleepCache.set(userId, config)
  if (config.active) {
    await upsertPref(userId, 'pod.sleep', config)
  } else {
    await db.delete(userPreferences).where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, 'pod.sleep')))
    sleepCache.set(userId, null)
  }
  return config
}

// ── Alert (ephemeral overlay) ─────────────────────────────────────────────────────
//
// Alerts are in-memory only — they're transient notifications (timer done, download
// complete, doorbell, etc.) that overlay whatever display view is active for ≤60 s,
// then vanish. No DB persistence needed.

export interface Alert {
  emoji: string
  message: string
  color: string         // hex — background tint for the overlay
  source: string        // 'timer' | 'download' | 'companion' | 'ha' | …
  expiresAt: number     // epoch ms
}

const alertStore = new Map<string, Alert>()

export function setUserAlert(userId: string, alert: Omit<Alert, 'expiresAt'> & { ttlSec?: number }): Alert {
  const full: Alert = { ...alert, expiresAt: Date.now() + (alert.ttlSec ?? 30) * 1_000 }
  alertStore.set(userId, full)
  return full
}

export function getUserAlert(userId: string): Alert | null {
  const a = alertStore.get(userId)
  if (!a) return null
  if (Date.now() > a.expiresAt) { alertStore.delete(userId); return null }
  return a
}

export function clearUserAlert(userId: string): void {
  alertStore.delete(userId)
}

// ── Timed-status expiry registry ──────────────────────────────────────────────────
//
// The scheduler's 5-s tick reads this map and clears statuses whose timer has lapsed,
// firing the appropriate chime. Avoids a DB sweep on every tick.

export const timedStatusExpiry = new Map<string, { endsAt: number; state: StatusState }>()

// ── Unified presence read ─────────────────────────────────────────────────────────

export interface UserPresence {
  status: UserStatus | null
  sleep: SleepConfig | null
  nowPlaying: NowPlaying | null
  plexActivity: PlexActivity | null
  alert: Alert | null
}

export async function getUserPresence(userId: string): Promise<UserPresence> {
  const [status, sleep] = await Promise.all([getUserStatus(userId), getUserSleep(userId)])
  return {
    status,
    sleep,
    nowPlaying: getNowPlaying(userId),
    plexActivity: getPlexActivity(userId),
    alert: getUserAlert(userId),
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────────

async function upsertPref(userId: string, key: string, value: unknown): Promise<void> {
  const now = new Date()
  const [existing] = await db
    .select({ id: userPreferences.id })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, key)))
    .limit(1)
  const serialized = JSON.stringify(value)
  if (existing) {
    await db.update(userPreferences).set({ value: serialized, updatedAt: now }).where(eq(userPreferences.id, existing.id))
  } else {
    await db.insert(userPreferences).values({ id: crypto.randomUUID(), userId, key, value: serialized, updatedAt: now })
  }
}
