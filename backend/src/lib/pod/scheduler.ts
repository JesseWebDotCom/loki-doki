// Server-side scheduler — fires alarms/timers to a user's connected Pods over the
// persistent Wyoming socket, so unprompted events reach a headless device without
// it polling. This is additive: it does NOT change the browser Time app's own
// client-side firing; it only pushes to Pods.
//
// Timezone: alarm hour:minute is evaluated in the SERVER's local time (typical for
// a home server == the household's timezone). Per-user timezones would refine this.

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { clockAlarms, clockTimerRuns } from '@/db/schema'
import { podsForUser, anyPodsConnected } from '@/lib/pod/registry'
import { logger } from '@/lib/logger'

const TICK_MS = 5_000
// Don't fire a timer whose deadline is long past (e.g. stale runs after a restart);
// only fire ones that came due within this window.
const TIMER_GRACE_MS = 60_000

// Dedupe keys so a due item fires at most once. Alarm keys embed the minute, timer
// keys the run id. Bounded by an occasional clear.
const fired = new Set<string>()

export function startPodScheduler(): void {
  if (process.env.POD_SCHEDULER_ENABLED === '0') {
    logger.info('[pod] scheduler disabled (POD_SCHEDULER_ENABLED=0)')
    return
  }
  setInterval(() => { void runSchedulerTick() }, TICK_MS)
  logger.info('[pod] scheduler started (alarms/timers → connected Pods)')
}

/** One scheduler pass — exported so it can be driven directly in tests. */
export async function runSchedulerTick(): Promise<void> {
  // Nothing connected → skip the DB work entirely.
  if (!anyPodsConnected()) return
  if (fired.size > 5_000) fired.clear()
  const now = new Date()
  try {
    await Promise.all([checkAlarms(now), checkTimers(now)])
  } catch (e) {
    logger.warn(`[pod] scheduler tick error: ${(e as Error).message}`)
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
    const pods = podsForUser(a.userId)
    if (pods.length === 0) continue
    fired.add(key)
    for (const p of pods) p.fire({ kind: 'alarm', label: a.label, tone: a.tone, announce: a.announce })
    logger.info(`[pod] alarm "${a.label}" → ${pods.length} pod(s)`)
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
