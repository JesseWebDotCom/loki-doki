// Family audio controls: the per-profile guardrail layer for music + podcasts.
//
// Four dials, all admin-managed (routes/adminFamilyAudio.ts):
//   • allowlist-only mode: the profile can only see/play explicitly approved artists,
//     stations, playlists, and podcast shows.
//   • blocklist: approved-by-default profiles can still have specific items removed.
//   • time budget + quiet hours: a daily audio-minutes allowance (accrued from the
//     players' now-playing heartbeats) and a nightly no-audio window.
//   • volume cap: clamped client-side by the players from /api/family-audio/me.
//
// Enforcement is server-side at the playback seams (queue build, resolve, podcast
// stream, directory/search/rails) with the same fail-open posture as the advisory and
// policyTier layers: an error in THIS layer never silences an unrestricted adult.

import { db } from '@/db'
import {
  familyAudioSettings, familyAudioEntries, familyAudioUsage, familyAudioEvents,
  podcastShows,
} from '@/db/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { logger } from '@/lib/logger'

export type FamilyEntryKind = 'artist' | 'playlist' | 'station' | 'podcastShow'
export type FamilyList = 'allow' | 'block'

export interface FamilyAudioSettings {
  allowlistOnly: boolean
  dailyAudioMinutes: number | null
  quietHoursStart: string | null
  quietHoursEnd: string | null
  maxVolumePercent: number | null
}

export interface FamilyEntry {
  id: string
  list: FamilyList
  kind: FamilyEntryKind
  ref: string
  altRef: string | null
  label: string
}

export interface FamilyEntrySets {
  allowlistOnly: boolean
  hasAny: boolean
  allow: FamilyEntry[]
  block: FamilyEntry[]
}

export const OPEN_SETTINGS: FamilyAudioSettings = {
  allowlistOnly: false, dailyAudioMinutes: null,
  quietHoursStart: null, quietHoursEnd: null, maxVolumePercent: null,
}

// ── Normalization ─────────────────────────────────────────────────────────────────────

/** The artist identity key: lowercase, diacritics stripped, punctuation collapsed.
 *  "Beyoncé" and "beyonce" match; " The Beatles " and "The Beatles" match. */
export function normArtistKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// ── Cached loads (same process handles admin writes, so invalidation is exact) ────────

const TTL_MS = 15_000
const settingsCache = new Map<string, { at: number; v: FamilyAudioSettings }>()
const entriesCache = new Map<string, { at: number; v: { allow: FamilyEntry[]; block: FamilyEntry[] } }>()

export function invalidateFamilyAudio(userId: string): void {
  settingsCache.delete(userId)
  entriesCache.delete(userId)
}

export async function familyAudioSettingsFor(userId: string): Promise<FamilyAudioSettings> {
  const hit = settingsCache.get(userId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v
  try {
    const [row] = await db.select().from(familyAudioSettings)
      .where(eq(familyAudioSettings.userId, userId)).limit(1)
    const v: FamilyAudioSettings = row
      ? {
          allowlistOnly: !!row.allowlistOnly,
          dailyAudioMinutes: row.dailyAudioMinutes,
          quietHoursStart: row.quietHoursStart,
          quietHoursEnd: row.quietHoursEnd,
          maxVolumePercent: row.maxVolumePercent,
        }
      : { ...OPEN_SETTINGS }
    settingsCache.set(userId, { at: Date.now(), v })
    return v
  } catch (err) {
    logger.debug(`[familyAudio] settings load failed (open): ${String(err)}`)
    return { ...OPEN_SETTINGS }
  }
}

async function loadEntries(userId: string): Promise<{ allow: FamilyEntry[]; block: FamilyEntry[] }> {
  const hit = entriesCache.get(userId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v
  const rows = await db.select().from(familyAudioEntries).where(eq(familyAudioEntries.userId, userId))
  const v: { allow: FamilyEntry[]; block: FamilyEntry[] } = {
    allow: rows.filter(r => r.list === 'allow'),
    block: rows.filter(r => r.list === 'block'),
  }
  entriesCache.set(userId, { at: Date.now(), v })
  return v
}

/** The full per-user policy snapshot the enforcement points work from. */
export async function familyEntrySetsFor(userId: string): Promise<FamilyEntrySets> {
  try {
    const [settings, entries] = await Promise.all([familyAudioSettingsFor(userId), loadEntries(userId)])
    return {
      allowlistOnly: settings.allowlistOnly,
      hasAny: settings.allowlistOnly || entries.block.length > 0,
      allow: entries.allow,
      block: entries.block,
    }
  } catch (err) {
    logger.debug(`[familyAudio] entries load failed (open): ${String(err)}`)
    return { allowlistOnly: false, hasAny: false, allow: [], block: [] }
  }
}

// ── Matching ──────────────────────────────────────────────────────────────────────────

function refsOf(entries: FamilyEntry[], kind: FamilyEntryKind): Set<string> {
  const out = new Set<string>()
  for (const e of entries) {
    if (e.kind !== kind) continue
    out.add(e.ref)
    if (e.altRef) out.add(e.altRef)
  }
  return out
}

/** Is this artist name allowed for the user? Allowlist mode: must be an allowlisted
 *  artist. Otherwise: must not be blocklisted. */
export function artistAllowed(sets: FamilyEntrySets, artist: string | null | undefined): boolean {
  const key = normArtistKey(artist ?? '')
  if (key && refsOf(sets.block, 'artist').has(key)) return false
  if (!sets.allowlistOnly) return true
  return !!key && refsOf(sets.allow, 'artist').has(key)
}

export function stationAllowed(sets: FamilyEntrySets, stationId: string): boolean {
  if (refsOf(sets.block, 'station').has(stationId)) return false
  if (!sets.allowlistOnly) return true
  return refsOf(sets.allow, 'station').has(stationId)
}

export function playlistAllowed(sets: FamilyEntrySets, playlistId: string): boolean {
  if (refsOf(sets.block, 'playlist').has(playlistId)) return false
  if (!sets.allowlistOnly) return true
  return refsOf(sets.allow, 'playlist').has(playlistId)
}

export interface ShowIdentity { id?: string | null; feedUrl?: string | null; itunesId?: number | null }

function showRefs(show: ShowIdentity): string[] {
  const refs: string[] = []
  if (show.id) refs.push(show.id)
  if (show.feedUrl) refs.push(show.feedUrl)
  if (show.itunesId != null) refs.push(`itunes:${show.itunesId}`)
  return refs
}

export function podcastShowAllowed(sets: FamilyEntrySets, show: ShowIdentity): boolean {
  const refs = showRefs(show)
  const blocked = refsOf(sets.block, 'podcastShow')
  if (refs.some(r => blocked.has(r))) return false
  if (!sets.allowlistOnly) return true
  const allowed = refsOf(sets.allow, 'podcastShow')
  return refs.some(r => allowed.has(r))
}

/** Show-id gate for playback routes: resolves the show row so feed-URL/iTunes entries
 *  match even when the entry was added before the show existed locally. */
export async function podcastShowAllowedById(userId: string, showId: string): Promise<boolean> {
  const sets = await familyEntrySetsFor(userId)
  if (!sets.hasAny) return true
  try {
    const [show] = await db.select({ id: podcastShows.id, feedUrl: podcastShows.feedUrl })
      .from(podcastShows).where(eq(podcastShows.id, showId)).limit(1)
    return podcastShowAllowed(sets, show ?? { id: showId })
  } catch {
    return podcastShowAllowed(sets, { id: showId })
  }
}

/** Drop tracks by blocked artists; in allowlist mode keep only allowlisted artists
 *  unless `containerApproved` (the track came from an allowlisted station/playlist,
 *  which is the parent's unit of approval). */
export function filterTracksBySets<T extends { artist?: string | null }>(
  sets: FamilyEntrySets, tracks: T[], containerApproved = false,
): T[] {
  if (!sets.hasAny) return tracks
  return tracks.filter(t => {
    const key = normArtistKey(t.artist ?? '')
    if (key && refsOf(sets.block, 'artist').has(key)) return false
    if (!sets.allowlistOnly || containerApproved) return true
    return !!key && refsOf(sets.allow, 'artist').has(key)
  })
}

// ── Time budget + quiet hours ─────────────────────────────────────────────────────────

export interface AudioGate {
  allowed: boolean
  reason: 'quiet_hours' | 'time_budget' | null
  /** Minutes left today; null = unlimited. */
  remainingMinutes: number | null
  usedMinutesToday: number
  allowlistOnly: boolean
  maxVolumePercent: number | null
  quietHoursStart: string | null
  quietHoursEnd: string | null
}

export function localDayKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function parseHm(s: string | null): number | null {
  if (!s) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  const h = Number(m[1]); const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** Inside the quiet window? Handles overnight windows (21:00 to 07:00). An equal
 *  start/end means "no window", not "always quiet". */
export function inQuietHours(startStr: string | null, endStr: string | null, now = new Date()): boolean {
  const start = parseHm(startStr)
  const end = parseHm(endStr)
  if (start == null || end == null || start === end) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  if (start < end) return cur >= start && cur < end
  return cur >= start || cur < end
}

export async function usedSecondsToday(userId: string): Promise<number> {
  const rows = await db.select({ seconds: familyAudioUsage.seconds })
    .from(familyAudioUsage)
    .where(and(eq(familyAudioUsage.userId, userId), eq(familyAudioUsage.day, localDayKey())))
  return rows.reduce((sum, r) => sum + (r.seconds ?? 0), 0)
}

/** The one "may this profile play audio right now" answer. Fails open. */
export async function audioGateFor(userId: string): Promise<AudioGate> {
  const base: AudioGate = {
    allowed: true, reason: null, remainingMinutes: null, usedMinutesToday: 0,
    allowlistOnly: false, maxVolumePercent: null, quietHoursStart: null, quietHoursEnd: null,
  }
  try {
    const settings = await familyAudioSettingsFor(userId)
    base.allowlistOnly = settings.allowlistOnly
    base.maxVolumePercent = settings.maxVolumePercent
    base.quietHoursStart = settings.quietHoursStart
    base.quietHoursEnd = settings.quietHoursEnd
    if (inQuietHours(settings.quietHoursStart, settings.quietHoursEnd)) {
      return { ...base, allowed: false, reason: 'quiet_hours' }
    }
    if (settings.dailyAudioMinutes != null) {
      const used = await usedSecondsToday(userId)
      base.usedMinutesToday = Math.floor(used / 60)
      const remaining = Math.max(0, settings.dailyAudioMinutes - used / 60)
      base.remainingMinutes = Math.floor(remaining)
      if (remaining <= 0) return { ...base, allowed: false, reason: 'time_budget' }
    }
    return base
  } catch (err) {
    logger.debug(`[familyAudio] audioGateFor failed (open): ${String(err)}`)
    return base
  }
}

// ── Usage accrual (from now-playing heartbeats) ───────────────────────────────────────

// Heartbeats land every ~4-5s per playing session; the delta since the previous beat is
// what actually elapsed. Capped so a laptop waking from sleep can't backfill an hour.
const MAX_DELTA_SEC = 20
const DEFAULT_DELTA_SEC = 5
const lastBeat = new Map<string, number>()

export async function accrueUsageFromHeartbeat(
  userId: string, sessionId: string, medium: 'music' | 'podcast',
): Promise<void> {
  try {
    const key = `${userId}:${sessionId}`
    const now = Date.now()
    const prev = lastBeat.get(key)
    lastBeat.set(key, now)
    if (lastBeat.size > 2000) {
      // Prune stale sessions so the map never grows unboundedly.
      for (const [k, t] of lastBeat) { if (now - t > 10 * 60_000) lastBeat.delete(k) }
    }
    const delta = prev == null
      ? DEFAULT_DELTA_SEC
      : Math.min(MAX_DELTA_SEC, Math.max(0, Math.round((now - prev) / 1000)))
    if (delta <= 0) return
    const day = localDayKey()
    const ts = new Date()
    await db.insert(familyAudioUsage)
      .values({ id: crypto.randomUUID(), userId, day, medium, seconds: delta, updatedAt: ts })
      .onConflictDoUpdate({
        target: [familyAudioUsage.userId, familyAudioUsage.day, familyAudioUsage.medium],
        set: { seconds: sqlIncrement(delta), updatedAt: ts },
      })
  } catch (err) {
    logger.debug(`[familyAudio] accrue failed: ${String(err)}`)
  }
}

function sqlIncrement(by: number) {
  return sql`${familyAudioUsage.seconds} + ${by}`
}

// ── Guardrail event log (feeds the weekly digest) ─────────────────────────────────────

const recentEvents = new Map<string, number>()

export function logFamilyAudioEvent(
  userId: string,
  kind: 'blocked_play' | 'budget_exhausted' | 'quiet_hours_block',
  detail?: { label?: string; medium?: string; reason?: string },
): void {
  // Debounce: a player retrying a blocked start shouldn't spam one row per attempt.
  const key = `${userId}:${kind}:${detail?.label ?? ''}`
  const now = Date.now()
  const last = recentEvents.get(key)
  if (last && now - last < 60_000) return
  recentEvents.set(key, now)
  if (recentEvents.size > 1000) {
    for (const [k, t] of recentEvents) { if (now - t > 10 * 60_000) recentEvents.delete(k) }
  }
  void db.insert(familyAudioEvents)
    .values({ id: crypto.randomUUID(), userId, kind, detail: detail ? JSON.stringify(detail) : null, createdAt: new Date() })
    .catch((err) => logger.debug(`[familyAudio] event log failed: ${String(err)}`))
}

// ── Admin helpers ─────────────────────────────────────────────────────────────────────

export async function entriesForUsers(userIds: string[]): Promise<Map<string, { allow: number; block: number }>> {
  const out = new Map<string, { allow: number; block: number }>()
  if (!userIds.length) return out
  const rows = await db.select({ userId: familyAudioEntries.userId, list: familyAudioEntries.list })
    .from(familyAudioEntries).where(inArray(familyAudioEntries.userId, userIds))
  for (const r of rows) {
    const cur = out.get(r.userId) ?? { allow: 0, block: 0 }
    if (r.list === 'allow') cur.allow++
    else cur.block++
    out.set(r.userId, cur)
  }
  return out
}
