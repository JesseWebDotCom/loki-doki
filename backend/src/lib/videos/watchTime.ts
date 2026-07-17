// Kids video time budgets: a per-user daily minutes cap and an allowed-hours window,
// metered from the position heartbeats every video player already sends (~10s apart
// while actually playing, across YouTube, hub sources and Plex). No new client wiring:
// each watch-state/progress write calls recordWatchBeat, and the gate is checked both
// at watch start (item/meta endpoints 403) and on every heartbeat response so a player
// can wind down mid-video when the budget runs out.
//
// Counting model: a beat adds the wall-clock gap since the user's previous beat, clamped
// to 30s, so two players beating at once can't double-count much and a paused player
// (no timeupdate, no beats) adds nothing.

import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { getUserPref } from '@/lib/contentPolicy'
import { logger } from '@/lib/logger'

export interface VideoTimeBudget {
  /** Max minutes of video per day; null = no cap. */
  dailyMinutes: number | null
  /** Allowed viewing window, local server hours [start, end); both null = always. */
  startHour: number | null
  endHour: number | null
}

export interface VideoTimeGate {
  allowed: boolean
  reason?: 'budget' | 'hours'
  /** Seconds left in today's budget; null when no cap is set. */
  remainingSec: number | null
}

export const TIME_BUDGET_PREF = 'videos.timeBudget'
export const OPEN_GATE: VideoTimeGate = { allowed: true, remainingSec: null }

const budgetCache = new Map<string, { at: number; budget: VideoTimeBudget | null }>()
const CACHE_MS = 15_000

export function invalidateTimeBudget(userId?: string): void {
  if (userId) budgetCache.delete(userId)
  else budgetCache.clear()
}

export async function getTimeBudget(userId: string): Promise<VideoTimeBudget | null> {
  const hit = budgetCache.get(userId)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.budget
  let budget: VideoTimeBudget | null = null
  try {
    const raw = await getUserPref(userId, TIME_BUDGET_PREF) as Partial<VideoTimeBudget> | null
    if (raw && (typeof raw.dailyMinutes === 'number' || typeof raw.startHour === 'number')) {
      budget = {
        dailyMinutes: typeof raw.dailyMinutes === 'number' && raw.dailyMinutes > 0 ? raw.dailyMinutes : null,
        startHour: typeof raw.startHour === 'number' ? Math.min(23, Math.max(0, Math.floor(raw.startHour))) : null,
        endHour: typeof raw.endHour === 'number' ? Math.min(24, Math.max(0, Math.floor(raw.endHour))) : null,
      }
      if (budget.dailyMinutes == null && budget.startHour == null) budget = null
    }
  } catch (err) {
    logger.debug(`[videos/watchTime] budget read failed (none): ${String(err)}`)
  }
  budgetCache.set(userId, { at: Date.now(), budget })
  return budget
}

// ── Metering ─────────────────────────────────────────────────────────────────────

/** Local-date key, e.g. "2026-07-17" (server timezone: the household's timezone). */
function dayKey(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const lastBeat = new Map<string, number>()
const pendingSec = new Map<string, number>()
let flushTimer: ReturnType<typeof setInterval> | null = null

async function flushPending(): Promise<void> {
  if (pendingSec.size === 0) return
  const day = dayKey()
  const rows = Array.from(pendingSec.entries())
  pendingSec.clear()
  for (const [userId, seconds] of rows) {
    try {
      db.run(sql`
        INSERT INTO video_watch_time (user_id, day, seconds)
        VALUES (${userId}, ${day}, ${seconds})
        ON CONFLICT(user_id, day) DO UPDATE SET seconds = seconds + ${seconds}
      `)
    } catch (err) {
      logger.debug(`[videos/watchTime] flush failed for ${userId}: ${String(err)}`)
    }
  }
}

/** Called from every video position write. Cheap; flushes to SQLite once a minute. */
export function recordWatchBeat(userId: string): void {
  const now = Date.now()
  const prev = lastBeat.get(userId)
  lastBeat.set(userId, now)
  const deltaSec = prev != null ? Math.min((now - prev) / 1000, 30) : 10
  if (deltaSec <= 0) return
  pendingSec.set(userId, (pendingSec.get(userId) ?? 0) + deltaSec)
  if (!flushTimer) flushTimer = setInterval(() => { void flushPending() }, 60_000)
}

export async function getWatchSecondsToday(userId: string): Promise<number> {
  let stored = 0
  try {
    const row = db.get<{ seconds: number }>(sql`
      SELECT seconds FROM video_watch_time WHERE user_id = ${userId} AND day = ${dayKey()}
    `)
    stored = row?.seconds ?? 0
  } catch { /* table freshly created; treat as 0 */ }
  return stored + (pendingSec.get(userId) ?? 0)
}

// ── The gate ─────────────────────────────────────────────────────────────────────

function withinHours(startHour: number | null, endHour: number | null): boolean {
  if (startHour == null || endHour == null || startHour === endHour) return true
  const h = new Date().getHours()
  // A window like 15..20 is same-day; 7..21 typical. start > end wraps past midnight.
  return startHour < endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour
}

export async function checkVideoTime(userId: string): Promise<VideoTimeGate> {
  const budget = await getTimeBudget(userId)
  if (!budget) return OPEN_GATE
  if (!withinHours(budget.startHour, budget.endHour)) {
    return { allowed: false, reason: 'hours', remainingSec: null }
  }
  if (budget.dailyMinutes != null) {
    const used = await getWatchSecondsToday(userId)
    const remaining = budget.dailyMinutes * 60 - used
    if (remaining <= 0) return { allowed: false, reason: 'budget', remainingSec: 0 }
    return { allowed: true, remainingSec: Math.round(remaining) }
  }
  return OPEN_GATE
}
