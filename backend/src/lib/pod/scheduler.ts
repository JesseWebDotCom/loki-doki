// Server-side scheduler — the authoritative firing engine for alarms/timers. It
// pushes unprompted events to connected Pods over the persistent Wyoming socket so a
// headless device rings without polling. Alarms are SERVER-OWNED (§8 of the slot-UI
// doc): the device is only a renderer; snooze/cancel come back as `alarm_action` and
// the server reschedules and coordinates a dismiss across any other ringing devices.
//
// This is additive to the browser Time app's own client-side firing.
//
// Timezone: alarm hour:minute is evaluated in the SERVER's local time (typical for a
// home server == the household's timezone).

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { clockAlarms, clockTimerRuns } from '@/db/schema'
import {
  podsForUser, podsForDevices, anyPodsConnected, stopAlarmOnDevice, type PodFireTarget,
} from '@/lib/pod/registry'
import { ensureBuiltins, resolveAlarmToneUrl } from '@/lib/pod/deviceStudio'
import { startDisplayDataRefresher } from '@/lib/pod/displayData'
import { logger } from '@/lib/logger'

const TICK_MS = 5_000
// Don't fire a timer whose deadline is long past (e.g. stale runs after a restart).
const TIMER_GRACE_MS = 60_000

// Dedupe keys so a due item fires at most once. Alarm keys embed the minute, timer
// keys the run id. Bounded by an occasional clear.
const fired = new Set<string>()

// Server-side snooze: alarmId → epoch ms when it should ring again (a one-shot). Set
// when a device snoozes; cleared on cancel or when it fires. In-memory by design — a
// snooze doesn't need to survive a restart.
const snoozes = new Map<string, number>()

export function startPodScheduler(): void {
  if (process.env.POD_SCHEDULER_ENABLED === '0') {
    logger.info('[pod] scheduler disabled (POD_SCHEDULER_ENABLED=0)')
    return
  }
  // Seed + render the built-in chimes/packs/templates so devices have sounds + a layout.
  void ensureBuiltins()
  // Slow refresher that re-pushes weather to connected native-LVGL devices.
  startDisplayDataRefresher()
  setInterval(() => { void runSchedulerTick() }, TICK_MS)
  logger.info('[pod] scheduler started (alarms/timers → connected Pods)')
}

/** One scheduler pass — exported so it can be driven directly in tests. */
export async function runSchedulerTick(): Promise<void> {
  if (!anyPodsConnected()) return
  if (fired.size > 5_000) fired.clear()
  const now = new Date()
  try {
    await Promise.all([checkAlarms(now), checkSnoozes(now), checkTimers(now)])
  } catch (e) {
    logger.warn(`[pod] scheduler tick error: ${(e as Error).message}`)
  }
}

function parseTargets(raw: string | null): string[] | null {
  if (!raw) return null
  try { const a = JSON.parse(raw) as unknown; return Array.isArray(a) && a.length ? a.map(String) : null } catch { return null }
}

/** Resolve which connected pods should ring an alarm: its explicit device targets if
 *  set, else all of the owning user's pods. */
function podsForAlarm(userId: string, targets: string[] | null): PodFireTarget[] {
  return targets ? podsForDevices(new Set(targets)) : podsForUser(userId)
}

/** Ring an alarm on each target pod, resolving the device tone per device
 *  (per-alarm → that device's template default → fallback). */
async function ringAlarm(a: { id: string; label: string; toneId: string | null; snoozeMinutes: number }, pods: PodFireTarget[]): Promise<void> {
  for (const p of pods) {
    if (!p.deviceId) continue
    const toneUrl = await resolveAlarmToneUrl(a.toneId, p.deviceId)
    p.fireAlarm({ alarm_id: a.id, label: a.label, tone_url: toneUrl, snooze_minutes: a.snoozeMinutes })
  }
}

async function checkAlarms(now: Date): Promise<void> {
  const hh = now.getHours()
  const mm = now.getMinutes()
  const day = now.getDay() // 0=Sun..6=Sat
  const minuteStamp = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${hh}-${mm}`

  const alarms = await db.select().from(clockAlarms).where(eq(clockAlarms.enabled, true))
  for (const a of alarms) {
    if (a.hour !== hh || a.minute !== mm) continue
    let repeat: number[] = []
    try { repeat = JSON.parse(a.repeatDays) as number[] } catch { repeat = [] }
    if (repeat.length > 0 && !repeat.includes(day)) continue

    const key = `alarm:${a.id}:${minuteStamp}`
    if (fired.has(key)) continue
    const pods = podsForAlarm(a.userId, parseTargets(a.targets))
    if (pods.length === 0) continue
    fired.add(key)
    await ringAlarm({ id: a.id, label: a.label, toneId: a.toneId, snoozeMinutes: a.snoozeMinutes }, pods)
    logger.info(`[pod] alarm "${a.label}" → ${pods.length} pod(s)`)
  }
}

/** Fire any snoozed alarms whose snooze window has elapsed. */
async function checkSnoozes(now: Date): Promise<void> {
  if (snoozes.size === 0) return
  const nowMs = now.getTime()
  for (const [alarmId, at] of [...snoozes]) {
    if (nowMs < at) continue
    snoozes.delete(alarmId)
    const [a] = await db.select().from(clockAlarms).where(eq(clockAlarms.id, alarmId))
    if (!a) continue
    const pods = podsForAlarm(a.userId, parseTargets(a.targets))
    if (pods.length === 0) continue
    await ringAlarm({ id: a.id, label: a.label, toneId: a.toneId, snoozeMinutes: a.snoozeMinutes }, pods)
    logger.info(`[pod] snoozed alarm "${a.label}" re-fired → ${pods.length} pod(s)`)
  }
}

async function checkTimers(now: Date): Promise<void> {
  const nowMs = now.getTime()
  const runs = await db.select().from(clockTimerRuns)
  for (const r of runs) {
    if (r.paused) continue
    if (nowMs < r.endsAt) continue
    if (nowMs - r.endsAt > TIMER_GRACE_MS) continue // stale (e.g. server was down) — skip
    const key = `timer:${r.id}`
    if (fired.has(key)) continue
    const pods = podsForUser(r.userId)
    if (pods.length === 0) continue
    fired.add(key)
    for (const p of pods) p.fire({ kind: 'timer', label: r.label, tone: r.tone, announce: r.announce })
    logger.info(`[pod] timer "${r.label}" → ${pods.length} pod(s)`)
  }
}

/**
 * A snooze/cancel tapped on a device. The server reschedules (snooze) or silences
 * (cancel) the alarm, and tells every OTHER target device to stop ringing — so a
 * dismiss on one tablet quiets them all (coordinated dismiss, §8.5).
 */
export async function handleAlarmAction(alarmId: string, action: 'snooze' | 'cancel', fromDeviceId: string): Promise<void> {
  const [a] = await db.select().from(clockAlarms).where(eq(clockAlarms.id, alarmId))
  if (!a) return
  // Quiet the other ringing targets.
  const targets = parseTargets(a.targets)
  const others = podsForAlarm(a.userId, targets).filter((p) => p.deviceId && p.deviceId !== fromDeviceId)
  for (const p of others) if (p.deviceId) stopAlarmOnDevice(p.deviceId, alarmId)

  if (action === 'snooze') {
    snoozes.set(alarmId, Date.now() + Math.max(1, a.snoozeMinutes) * 60_000)
    logger.info(`[pod] alarm "${a.label}" snoozed ${a.snoozeMinutes}m (by ${fromDeviceId})`)
  } else {
    snoozes.delete(alarmId)
    logger.info(`[pod] alarm "${a.label}" cancelled (by ${fromDeviceId})`)
  }
}
