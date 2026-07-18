// The deterministic routines executor.
//
// Triggers: a minute tick for time routines (deduped by minute stamp), plus
// in-process subscriptions for Home Assistant state changes, Frigate events, and
// service up/down transitions, plus token-authenticated webhooks (routes/routines).
// The LLM is never in this loop; ask-companion actions invoke it at fire time only.

import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { and, desc, eq, lt } from 'drizzle-orm'
import { db } from '@/db'
import { routineRuns, routines } from '@/db/schema'
import { logger } from '@/lib/logger'
import { onHAStateChange } from '@/lib/homeAssistant/sync'
import { onFrigateEvent, type FrigateEventHook } from '@/lib/frigate/events'
import { onServiceTransition } from '@/lib/monitoring/kuma'
import { executeAction } from './actions'
import type { FolderEvent, RoutineAction, RoutineTrigger } from './types'

/** Extra context a trigger can hand to actions (e.g. the file that fired a folder watch). */
export interface TriggerData {
  file?: string // absolute path of the triggering file
}

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
export async function fireRoutine(row: RoutineRow, firedBy: string, triggerData?: TriggerData): Promise<void> {
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
        outcomes.push(await executeAction(action, { routineId: row.id, routineName: row.name, userId: row.userId, triggerData }))
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

// ── Folder watchers ─────────────────────────────────────────────────────────
//
// fs.watch is non-recursive here on purpose: recursive watching is unsupported on
// Linux (a first-class deploy target). Watchers are reconciled to the set of enabled
// folder routines on boot and on every time tick, so create/edit/delete of a routine
// (or a folder that only appears later) is picked up within ~20s. Per-file debounce
// collapses the burst of events editors emit per save.

const MAX_FOLDER_WATCHERS = 25
const FOLDER_DEBOUNCE_MS = 1500

interface FolderWatch {
  path: string
  events: FolderEvent[]
  match?: string
  cooldownSec: number
  watcher: FSWatcher
  // filename -> last time we fired for it, to debounce editor event bursts.
  recent: Map<string, number>
  lastFireAt: number
}

const folderWatchers = new Map<string, FolderWatch>() // routineId -> watch

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

function folderConfigKey(t: Extract<RoutineTrigger, { type: 'folder' }>): string {
  return `${t.path} ${(t.events ?? []).join(',')} ${t.match ?? ''} ${t.cooldownSec ?? 0}`
}

async function handleFolderEvent(routineId: string, eventType: string, filename: string | null): Promise<void> {
  const w = folderWatchers.get(routineId)
  if (!w) return
  if (!filename) return // some platforms omit the name; nothing actionable to match/pass
  if (w.match && !globToRegExp(w.match).test(basename(filename))) return

  const full = join(w.path, filename)
  // fs.watch conflates create/delete/rename under 'rename'. Stat to classify and to
  // drop deletions (a vanished file cannot be acted on).
  let kind: FolderEvent
  if (eventType === 'change') {
    kind = 'modified'
  } else {
    const exists = await stat(full).then(() => true).catch(() => false)
    if (!exists) return // deletion or move-away
    kind = 'created'
  }
  if (!w.events.includes(kind)) return

  const now = Date.now()
  const last = w.recent.get(filename) ?? 0
  if (now - last < FOLDER_DEBOUNCE_MS) return
  w.recent.set(filename, now)
  if (w.recent.size > 512) w.recent.clear() // bounded; oldest simply re-fire later
  if (w.cooldownSec && now - w.lastFireAt < w.cooldownSec * 1000) return
  w.lastFireAt = now

  const [row] = await db.select().from(routines).where(eq(routines.id, routineId)).limit(1)
  if (row && row.enabled) void fireRoutine(row, 'folder', { file: full })
}

function startFolderWatch(routineId: string, t: Extract<RoutineTrigger, { type: 'folder' }>): void {
  try {
    const watcher = watch(t.path, { persistent: false }, (eventType, filename) => {
      void handleFolderEvent(routineId, eventType, typeof filename === 'string' ? filename : null)
        .catch((err) => logger.warn(`[routines] folder event failed: ${err instanceof Error ? err.message : err}`))
    })
    watcher.on('error', (err) => {
      logger.warn(`[routines] folder watch on ${t.path} errored: ${err instanceof Error ? err.message : err}`)
      const w = folderWatchers.get(routineId)
      if (w) { try { w.watcher.close() } catch { /* ignore */ } }
      folderWatchers.delete(routineId) // reconcile will retry on the next tick
    })
    folderWatchers.set(routineId, {
      path: t.path,
      events: t.events && t.events.length ? t.events : ['created', 'modified'],
      match: t.match,
      cooldownSec: t.cooldownSec ?? 0,
      watcher,
      recent: new Map(),
      lastFireAt: 0,
    })
  } catch (err) {
    // Folder may not exist yet; a later reconcile retries once it does.
    logger.warn(`[routines] could not watch ${t.path}: ${err instanceof Error ? err.message : err}`)
  }
}

/** Reconcile live fs.watch handles to the current set of enabled folder routines. */
export async function syncFolderWatchers(): Promise<void> {
  const rows = await enabledRoutines()
  const wanted = new Map<string, Extract<RoutineTrigger, { type: 'folder' }>>()
  for (const row of rows) {
    const trigger = parseTrigger(row)
    if (trigger?.type === 'folder') wanted.set(row.id, trigger)
  }

  // Drop watchers for routines that are gone, disabled, or whose config changed.
  for (const [routineId, w] of folderWatchers) {
    const t = wanted.get(routineId)
    if (!t || folderConfigKey(t) !== folderConfigKey({ type: 'folder', path: w.path, events: w.events, match: w.match, cooldownSec: w.cooldownSec })) {
      try { w.watcher.close() } catch { /* ignore */ }
      folderWatchers.delete(routineId)
    }
  }

  // Start watchers for newly-wanted (or previously-failed) routines.
  for (const [routineId, t] of wanted) {
    if (folderWatchers.has(routineId)) continue
    if (folderWatchers.size >= MAX_FOLDER_WATCHERS) {
      logger.warn(`[routines] folder watcher cap (${MAX_FOLDER_WATCHERS}) reached; skipping ${t.path}`)
      break
    }
    startFolderWatch(routineId, t)
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

let started = false

export function startRoutinesEngine(): void {
  if (started) return
  started = true
  setInterval(() => {
    void timeTick().catch((err) => logger.warn(`[routines] time tick failed: ${err}`))
    void syncFolderWatchers().catch((err) => logger.warn(`[routines] folder sync failed: ${err}`))
  }, 20_000)
  void syncFolderWatchers().catch((err) => logger.warn(`[routines] folder sync failed: ${err}`))
  onHAStateChange((_baseUrl, entityId, newState, oldState) => {
    void onHaChange(entityId, newState, oldState).catch(() => {})
  })
  onFrigateEvent((event) => { void onFrigate(event).catch(() => {}) })
  onServiceTransition((monitor, event) => { void onService(monitor, event).catch(() => {}) })
  logger.info('[routines] engine started')
}
