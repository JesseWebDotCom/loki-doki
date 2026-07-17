// The deterministic routines executor.
//
// Triggers: a minute tick for time routines (deduped by minute stamp), plus
// in-process subscriptions for Home Assistant state changes, Frigate events, and
// service up/down transitions, plus token-authenticated webhooks (routes/routines).
// The LLM is never in this loop; ask-companion actions invoke it at fire time only.

import { and, desc, eq, lt } from 'drizzle-orm'
import { db } from '@/db'
import { routineRuns, routines } from '@/db/schema'
import { logger } from '@/lib/logger'
import { onHAStateChange } from '@/lib/homeAssistant/sync'
import { onFrigateEvent, type FrigateEventHook } from '@/lib/frigate/events'
import { onServiceTransition } from '@/lib/monitoring/kuma'
import { executeAction } from './actions'
import type { RoutineAction, RoutineTrigger } from './types'

type RoutineRow = typeof routines.$inferSelect

const DEFAULT_COOLDOWN_SEC: Record<string, number> = { 'ha-state': 60, frigate: 300 }
const RUNS_KEPT_PER_ROUTINE = 20

const inFlight = new Set<string>()
// routineId -> 'YYYY-MM-DD HH:MM' of the last time-trigger fire, so one minute
// never double-fires across ticks (lastRunAt alone is too coarse once actions
// take a few seconds).
const firedMinute = new Map<string, string>()

export function parseTrigger(row: RoutineRow): RoutineTrigger | null {
  try { return JSON.parse(row.trigger) as RoutineTrigger } catch { return null }
}

export function parseActions(row: RoutineRow): RoutineAction[] {
  try { return JSON.parse(row.actions) as RoutineAction[] } catch { return [] }
}

async function enabledRoutines(): Promise<RoutineRow[]> {
  return db.select().from(routines).where(eq(routines.enabled, true))
}

function cooldownOk(row: RoutineRow, trigger: RoutineTrigger): boolean {
  const cooldownSec = ('cooldownSec' in trigger ? trigger.cooldownSec : undefined)
    ?? DEFAULT_COOLDOWN_SEC[trigger.type] ?? 0
  if (!cooldownSec || !row.lastRunAt) return true
  return Date.now() - row.lastRunAt.getTime() >= cooldownSec * 1000
}

/** Run a routine's actions now. Serialized per routine; every fire is recorded. */
export async function fireRoutine(row: RoutineRow, firedBy: string): Promise<void> {
  if (inFlight.has(row.id)) return
  inFlight.add(row.id)
  const startedAt = new Date()
  const runId = crypto.randomUUID()
  try {
    await db.insert(routineRuns).values({ id: runId, routineId: row.id, firedBy, status: 'ok', startedAt })
    const actions = parseActions(row)
    const outcomes: string[] = []
    let failed: string | null = null
    for (const action of actions) {
      try {
        outcomes.push(await executeAction(action, { routineId: row.id, routineName: row.name, userId: row.userId }))
      } catch (err) {
        failed = err instanceof Error ? err.message : String(err)
        outcomes.push(`FAILED: ${failed}`)
        break // later actions likely depend on earlier ones; stop rather than half-run
      }
    }
    await db.update(routineRuns)
      .set({ status: failed ? 'error' : 'ok', detail: outcomes.join(' | ').slice(0, 2000), finishedAt: new Date() })
      .where(eq(routineRuns.id, runId))
    await db.update(routines)
      .set({ lastRunAt: startedAt, lastResult: failed ? 'error' : 'ok' })
      .where(eq(routines.id, row.id))
    if (failed) logger.warn(`[routines] "${row.name}" failed: ${failed}`)

    // Prune old runs so the history stays bounded.
    const old = await db.select({ id: routineRuns.id, startedAt: routineRuns.startedAt }).from(routineRuns)
      .where(eq(routineRuns.routineId, row.id))
      .orderBy(desc(routineRuns.startedAt))
    if (old.length > RUNS_KEPT_PER_ROUTINE) {
      const cutoff = old[RUNS_KEPT_PER_ROUTINE - 1]!.startedAt
      await db.delete(routineRuns).where(and(eq(routineRuns.routineId, row.id), lt(routineRuns.startedAt, cutoff)))
    }
  } catch (err) {
    logger.warn(`[routines] run bookkeeping failed for "${row.name}": ${err instanceof Error ? err.message : err}`)
  } finally {
    inFlight.delete(row.id)
  }
}

// ── Trigger matching ──────────────────────────────────────────────────────────

function minuteStamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

async function timeTick(): Promise<void> {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  const stamp = minuteStamp(now)
  for (const row of await enabledRoutines()) {
    const trigger = parseTrigger(row)
    if (trigger?.type !== 'time') continue
    if (trigger.time !== hm) continue
    if (trigger.days && trigger.days.length > 0 && !trigger.days.includes(now.getDay())) continue
    if (firedMinute.get(row.id) === stamp) continue
    firedMinute.set(row.id, stamp)
    void fireRoutine(row, 'time')
  }
}

function hourInWindow(hour: number, startHour?: number, endHour?: number): boolean {
  if (startHour == null || endHour == null) return true
  if (startHour === endHour) return true
  // Wrapping windows (e.g. 22 -> 6) mean "late night": inside when past start OR before end.
  return startHour < endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour
}

async function onHaChange(entityId: string, newState: string, oldState: string | undefined): Promise<void> {
  for (const row of await enabledRoutines()) {
    const trigger = parseTrigger(row)
    if (trigger?.type !== 'ha-state') continue
    if (trigger.entityId !== entityId) continue
    if (trigger.to && trigger.to !== newState) continue
    if (trigger.from && trigger.from !== oldState) continue
    if (!cooldownOk(row, trigger)) continue
    void fireRoutine(row, 'ha-state')
  }
}

async function onFrigate(event: FrigateEventHook): Promise<void> {
  const hour = new Date().getHours()
  for (const row of await enabledRoutines()) {
    const trigger = parseTrigger(row)
    if (trigger?.type !== 'frigate') continue
    if (trigger.camera && trigger.camera !== event.camera) continue
    if (trigger.label && trigger.label !== event.label) continue
    if (!hourInWindow(hour, trigger.startHour, trigger.endHour)) continue
    if (!cooldownOk(row, trigger)) continue
    void fireRoutine(row, 'frigate')
  }
}

async function onService(monitor: string, event: 'down' | 'up'): Promise<void> {
  for (const row of await enabledRoutines()) {
    const trigger = parseTrigger(row)
    if (trigger?.type !== 'service') continue
    if ((trigger.event ?? 'down') !== event) continue
    if (trigger.monitor && trigger.monitor !== monitor) continue
    void fireRoutine(row, 'service')
  }
}

/** Fire a webhook routine by id + token. Returns false when no enabled routine matches. */
export async function fireWebhook(routineId: string, token: string): Promise<boolean> {
  const [row] = await db.select().from(routines).where(eq(routines.id, routineId)).limit(1)
  if (!row || !row.enabled) return false
  const trigger = parseTrigger(row)
  if (trigger?.type !== 'webhook') return false
  // Constant-time-ish comparison is overkill for a local family hub, but keep the
  // check strict: exact match only.
  if (trigger.token !== token) return false
  void fireRoutine(row, 'webhook')
  return true
}

// ── Boot ──────────────────────────────────────────────────────────────────────

let started = false

export function startRoutinesEngine(): void {
  if (started) return
  started = true
  setInterval(() => { void timeTick().catch((err) => logger.warn(`[routines] time tick failed: ${err}`)) }, 20_000)
  onHAStateChange((_baseUrl, entityId, newState, oldState) => {
    void onHaChange(entityId, newState, oldState).catch(() => {})
  })
  onFrigateEvent((event) => { void onFrigate(event).catch(() => {}) })
  onServiceTransition((monitor, event) => { void onService(monitor, event).catch(() => {}) })
  logger.info('[routines] engine started')
}
