// The fused admission gate for opportunistic background work (the proactive
// processor). The app already has the sensors (activityGate's interactive
// timestamps, genQueue's lane occupancy, nvidia-smi via gpuMonitor, os.loadavg),
// but until now nothing composed them into one answer to "is this a good moment
// to burn CPU/GPU on work nobody asked for?".
//
// Consumers: downloadJobs.tick() consults shouldRunOpportunistic() before
// dispatching any job in the OPPORTUNISTIC priority band (precomputed
// transcodes, summaries, digests). A busy verdict defers the job - it stays
// 'pending' and the scheduler's 5s safety-net tick retries - it is never
// aborted or failed. User-requested jobs (lower priority numbers) are never
// gated: someone waiting on a download or a lazy transcode always wins.
//
// Busy signals, in the order they usually fire:
//   • a chat/voice turn happened in the last INTERACTIVE_QUIET_MS (activityGate)
//   • any module-registered signal reports busy (generation queue lanes, live
//     transcode pipes - registered via registerBusySignal to avoid import cycles)
//   • CPU load ratio above CPU_BUSY_RATIO (POSIX only: os.loadavg() is all zeros
//     on Windows, so the prod box relies on the other signals instead)
//   • GPU utilization above GPU_BUSY_UTIL_PCT (cached nvidia-smi, refreshed
//     lazily; VRAM fullness is deliberately NOT a signal - a pinned resident
//     LLM keeps VRAM near-full around the clock and says nothing about load)
//
// The whole gate is opt-out via ONE admin switch (background.opportunistic),
// boot-cached like resourceMode so the scheduler reads it synchronously.

// IMPORT DISCIPLINE: this module is imported by genQueue/live/downloadJobs at their module
// top level (to register busy signals), so it must not statically import anything that can
// transitively reach them back - gpuMonitor does (via llmStatus), hence the lazy import in
// refreshGpuBusy. A static import here crashed module init with a TDZ ReferenceError.
import os from 'node:os'
import { interactiveIdleMs } from '@/lib/activityGate'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { logger } from '@/lib/logger'

/** Jobs at or above this priority are "opportunistic": nobody is waiting on them,
 *  so they only dispatch while the system is idle. Keep user-requested work below. */
export const OPPORTUNISTIC_PRIORITY = 100

export const OPPORTUNISTIC_KEY = 'background.opportunistic'

const INTERACTIVE_QUIET_MS = 60_000
const CPU_BUSY_RATIO = 0.75
const GPU_BUSY_UTIL_PCT = 50
const GPU_REFRESH_MS = 10_000

// ── Admin switch (boot-cached) ──────────────────────────────────────────────────

let enabledCache = true

/** Load the persisted switch into the sync cache. Call at boot and after changes. */
export async function resolveOpportunisticEnabled(): Promise<boolean> {
  try {
    const raw = await getAppSetting(OPPORTUNISTIC_KEY)
    enabledCache = raw !== false && raw !== 'false'
  } catch { enabledCache = true }
  return enabledCache
}

export function isOpportunisticEnabled(): boolean { return enabledCache }

export async function setOpportunisticEnabled(on: boolean): Promise<boolean> {
  await setAppSetting(OPPORTUNISTIC_KEY, on)
  enabledCache = on
  logger.info(`[background] opportunistic processing ${on ? 'enabled' : 'disabled'}`)
  return enabledCache
}

// ── Module-registered busy signals ──────────────────────────────────────────────

/** Return a short human reason while busy, null while idle. Must be cheap + sync. */
export type BusySignal = () => string | null

const signals = new Map<string, BusySignal>()

/** Modules with live workload state (genQueue lanes, live transcode pipes) register
 *  here at import time instead of being imported by this module - keeps the gate
 *  dependency-free so downloadJobs can import it without cycles. */
export function registerBusySignal(name: string, fn: BusySignal): void {
  signals.set(name, fn)
}

// ── GPU utilization (lazy cached nvidia-smi) ────────────────────────────────────

// null = never checked; false = nvidia-smi unavailable (non-NVIDIA box or driver
// down) - don't respawn it every tick just to fail again.
let gpuSupported: boolean | null = null
let gpuBusyReason: string | null = null
let gpuCheckedAt = 0
let gpuRefreshing = false

function refreshGpuBusy(): void {
  if (gpuSupported === false || gpuRefreshing) return
  if (Date.now() - gpuCheckedAt < GPU_REFRESH_MS) return
  gpuRefreshing = true
  import('@/lib/gpuMonitor').then((m) => m.queryGpus()).then((gpus) => {
    gpuCheckedAt = Date.now()
    if (gpus === null) {
      // First failure decides: a box without nvidia-smi stays unsupported for this
      // process lifetime (prod eGPU dropout re-detects on restart, like hwfit).
      if (gpuSupported === null) gpuSupported = false
      gpuBusyReason = null
      return
    }
    gpuSupported = true
    const hot = gpus.find((g) => (g.utilizationPct ?? 0) >= GPU_BUSY_UTIL_PCT)
    gpuBusyReason = hot ? `GPU busy (${hot.name} at ${hot.utilizationPct}%)` : null
  }).catch(() => {
    gpuCheckedAt = Date.now()
    if (gpuSupported === null) gpuSupported = false
  }).finally(() => { gpuRefreshing = false })
}

// ── The verdict ─────────────────────────────────────────────────────────────────

export interface BackgroundGate {
  enabled: boolean
  busy: boolean
  /** Human-readable reasons the gate is closed (empty when open). */
  reasons: string[]
}

/** Cheap, synchronous: safe to call from every scheduler tick. Kicks an async GPU
 *  refresh in the background; the verdict uses the last known sample. */
export function backgroundGateSnapshot(): BackgroundGate {
  const reasons: string[] = []

  const idleMs = interactiveIdleMs()
  if (idleMs < INTERACTIVE_QUIET_MS) {
    reasons.push(`conversation active ${Math.round(idleMs / 1000)}s ago`)
  }

  for (const [name, fn] of signals) {
    try {
      const r = fn()
      if (r) reasons.push(`${name}: ${r}`)
    } catch { /* a broken signal never blocks the gate */ }
  }

  const cores = os.cpus().length || 1
  const ratio = (os.loadavg()[0] ?? 0) / cores
  if (ratio > CPU_BUSY_RATIO) reasons.push(`CPU load high (${ratio.toFixed(2)})`)

  refreshGpuBusy()
  if (gpuBusyReason) reasons.push(gpuBusyReason)

  return { enabled: enabledCache, busy: reasons.length > 0, reasons }
}

/** The one-line answer downloadJobs asks on every tick. */
export function shouldRunOpportunistic(): boolean {
  const gate = backgroundGateSnapshot()
  return gate.enabled && !gate.busy
}
