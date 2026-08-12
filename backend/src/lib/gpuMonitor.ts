import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { getLlmStatus, type LlmStatus } from '@/lib/llmStatus'
import { logger } from '@/lib/logger'

const execFileAsync = promisify(execFile)

// GPU health + utilization, sourced from nvidia-smi. Powers the admin System-tab panel and the
// configurable "GPU issue" alerts (missing/ejected card, driver not responding, overheat, VRAM
// near-full). Detection mirrors hwfit's nvidia-smi call but adds live util/temp and a persisted
// baseline of "GPUs we've seen" so an ejected card (e.g. a Thunderbolt eGPU) is flagged as missing.

export interface GpuStat {
  index: number
  name: string
  uuid: string
  utilizationPct: number | null
  memUsedMb: number | null
  memTotalMb: number | null
  temperatureC: number | null
}

export type GpuIssueKind = 'missing' | 'driver' | 'overheat' | 'vram' | 'offload'
export interface GpuIssue {
  kind: GpuIssueKind
  key: string                       // stable id for toast dedupe (e.g. "missing:<uuid>")
  severity: 'warn' | 'error'
  message: string
  gpu?: string
}

export interface GpuAlertConfig {
  missing:  { enabled: boolean }
  driver:   { enabled: boolean }
  overheat: { enabled: boolean; thresholdC: number }
  vram:     { enabled: boolean; thresholdPct: number }
  offload:  { enabled: boolean }
}

// Tuning alerts (overheat, VRAM watermark) are opt-in (Admin → System → GPU health →
// Alerts) - this is a home box, not a monitored datacenter fleet. But the "GPU cannot
// be used" class defaults ON:
//   offload - a model silently running on the CPU turns every reply into minutes and
//     gives no other signal (observed live: a 90-second "hi").
//   driver  - a wedged NVIDIA driver sends EVERY model to the CPU at once, and the
//     offload toast alone then gives the wrong advice (observed live: a driver crash
//     mid-uptime; "free VRAM" can't fix it, only a reboot can).
//   missing - an ejected/dropped card (e.g. a Thunderbolt eGPU) is the same condition
//     scoped to one GPU.
export const DEFAULT_GPU_ALERT_CONFIG: GpuAlertConfig = {
  missing:  { enabled: true },
  driver:   { enabled: true },
  overheat: { enabled: false, thresholdC: 85 },
  vram:     { enabled: false, thresholdPct: 95 },
  offload:  { enabled: true },
}

export interface GpuHealth {
  supported: boolean       // false ⇒ no NVIDIA GPU has ever been seen on this machine (feature N/A)
  driverOk: boolean
  gpus: GpuStat[]
  expected: { uuid: string; name: string }[]
  issues: GpuIssue[]
  /** Live LLM engine census (loaded models, VRAM vs CPU split, orphan sweeps). */
  llm: LlmStatus
}

/** Partial config accepted by the PUT endpoint. */
export interface GpuAlertConfigPatch {
  missing?:  { enabled?: boolean }
  driver?:   { enabled?: boolean }
  overheat?: { enabled?: boolean; thresholdC?: number }
  vram?:     { enabled?: boolean; thresholdPct?: number }
  offload?:  { enabled?: boolean }
}

const CONFIG_KEY   = 'gpu.alertConfig'
const BASELINE_KEY = 'gpu.expectedGpus'

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const numOrNull = (s: string | undefined): number | null => { if (s == null) return null; const n = parseInt(s, 10); return Number.isNaN(n) ? null : n }

// Parse nvidia-smi CSV. Robust to commas inside the GPU name by counting the numeric fields from
// the end (index,name,uuid,util,mem.used,mem.total,temp) rather than assuming name has no comma.
function parseSmi(out: string): GpuStat[] {
  const gpus: GpuStat[] = []
  for (const line of out.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const p = t.split(',').map((s) => s.trim())
    if (p.length < 7) continue
    const index = numOrNull(p[0])
    if (index === null) continue
    gpus.push({
      index,
      name: p.slice(1, p.length - 5).join(',').trim(),
      uuid: p[p.length - 5] ?? '',
      utilizationPct: numOrNull(p[p.length - 4]),
      memUsedMb:      numOrNull(p[p.length - 3]),
      memTotalMb:     numOrNull(p[p.length - 2]),
      temperatureC:   numOrNull(p[p.length - 1]),
    })
  }
  return gpus
}

/** Live per-GPU stats, or null when nvidia-smi can't be run (driver down OR not an NVIDIA box —
 *  callers disambiguate via the persisted baseline). Spawned async and directly (no cmd.exe) so it
 *  never blocks the event loop — a synchronous spawnSync intermittently times out in the loaded
 *  backend process on Windows. */
export async function queryGpus(): Promise<GpuStat[] | null> {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=index,name,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu',
      '--format=csv,noheader,nounits',
    ], { timeout: 8_000, windowsHide: true })
    return parseSmi(stdout)
  } catch (err) {
    logger.warn(`[gpu] nvidia-smi query failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

export async function getGpuAlertConfig(): Promise<GpuAlertConfig> {
  const s = (await getAppSetting(CONFIG_KEY)) as GpuAlertConfigPatch | null
  const d = DEFAULT_GPU_ALERT_CONFIG
  return {
    missing:  { enabled: s?.missing?.enabled  ?? d.missing.enabled },
    driver:   { enabled: s?.driver?.enabled   ?? d.driver.enabled },
    overheat: { enabled: s?.overheat?.enabled ?? d.overheat.enabled, thresholdC:   s?.overheat?.thresholdC   ?? d.overheat.thresholdC },
    vram:     { enabled: s?.vram?.enabled     ?? d.vram.enabled,     thresholdPct: s?.vram?.thresholdPct     ?? d.vram.thresholdPct },
    offload:  { enabled: s?.offload?.enabled  ?? d.offload.enabled },
  }
}

export async function setGpuAlertConfig(patch: GpuAlertConfigPatch): Promise<GpuAlertConfig> {
  const cur = await getGpuAlertConfig()
  const merged: GpuAlertConfig = {
    missing:  { enabled: patch.missing?.enabled  ?? cur.missing.enabled },
    driver:   { enabled: patch.driver?.enabled   ?? cur.driver.enabled },
    overheat: { enabled: patch.overheat?.enabled ?? cur.overheat.enabled, thresholdC:   clamp(patch.overheat?.thresholdC   ?? cur.overheat.thresholdC,   40, 120) },
    vram:     { enabled: patch.vram?.enabled     ?? cur.vram.enabled,     thresholdPct: clamp(patch.vram?.thresholdPct     ?? cur.vram.thresholdPct,     50, 100) },
    offload:  { enabled: patch.offload?.enabled  ?? cur.offload.enabled },
  }
  await setAppSetting(CONFIG_KEY, merged)
  return merged
}

async function getBaseline(): Promise<{ uuid: string; name: string }[]> {
  return ((await getAppSetting(BASELINE_KEY)) as { uuid: string; name: string }[] | null) ?? []
}

// The baseline only grows: a card we've seen stays "expected" so an ejected/removed GPU is flagged
// as missing until the admin explicitly resets it (below).
async function growBaseline(gpus: GpuStat[]): Promise<{ uuid: string; name: string }[]> {
  const base = await getBaseline()
  const known = new Set(base.map((b) => b.uuid))
  let changed = false
  for (const g of gpus) {
    if (g.uuid && !known.has(g.uuid)) { base.push({ uuid: g.uuid, name: g.name }); known.add(g.uuid); changed = true }
  }
  if (changed) await setAppSetting(BASELINE_KEY, base)
  return base
}

/** Reset the expected-GPU baseline to whatever is present now — clears a stale "missing" alert
 *  after a card is intentionally removed. */
export async function resetGpuBaseline(): Promise<void> {
  const gpus = (await queryGpus()) ?? []
  await setAppSetting(BASELINE_KEY, gpus.map((g) => ({ uuid: g.uuid, name: g.name })))
}

// ── Persistent "GPU cannot be used" notifications ─────────────────────────────
// Toasts only reach an admin who happens to have the app open; a wedged driver or a
// dropped card deserves a bell/push notification too. Edge-triggered (module state)
// so a persisting condition emits once, with dedupeKey as the cross-restart guard
// while the row is unread. Fire-and-forget: notifying must never slow the poll.
let notifiedDriverDown = false
const notifiedMissing = new Set<string>()

function notifyGpuUnusable(kind: 'driver' | 'missing', message: string, dedupeKey: string): void {
  void import('@/lib/notify').then(({ emitNotification }) => emitNotification({
    type: 'system',
    priority: 'urgent',
    title: kind === 'driver' ? 'GPU driver is not responding' : 'A GPU is no longer available',
    body: message,
    url: '/admin/system',
    dedupeKey,
  })).catch(() => { /* best-effort */ })
}

export async function getGpuHealth(): Promise<GpuHealth> {
  const config = await getGpuAlertConfig()
  // The LLM census runs in parallel with nvidia-smi and is valid even on non-NVIDIA boxes.
  const [stats, llm] = await Promise.all([queryGpus(), getLlmStatus()])
  const baseline = await getBaseline()

  // Sustained CPU offload (>=2 consecutive polls): the silent killer - replies take minutes
  // with no other visible signal. Synthesized regardless of GPU-driver state, but the ADVICE
  // depends on it: with the driver down, "free VRAM" is wrong (nothing can reach the GPU);
  // the fix is a reboot. Models the placement engine deliberately runs on the CPU never
  // reach sustainedOffload (llmStatus filters them), so this only fires on real spills.
  const driverDown = stats === null && baseline.length > 0
  const offloadIssues: GpuIssue[] = config.offload.enabled
    ? llm.sustainedOffload.map((m) => ({
        kind: 'offload' as const,
        key: `offload:${m.engine}:${m.name}`,
        severity: 'warn' as const,
        message: driverDown
          ? `${m.name} is running ${m.offloadPct}% on the CPU because the GPU driver is not responding - replies will be very slow until the machine is rebooted.`
          : `${m.name} is running ${m.offloadPct}% on the CPU (${m.engine} engine) - replies will be very slow. Free VRAM from Admin → System → AI engine.`,
      }))
    : []

  // nvidia-smi failed to run.
  if (stats === null) {
    // Never seen a GPU here ⇒ not an NVIDIA machine; the feature is simply N/A (no false alarm).
    if (baseline.length === 0) return { supported: false, driverOk: false, gpus: [], expected: [], issues: offloadIssues, llm }
    const issues: GpuIssue[] = [...offloadIssues]
    if (config.driver.enabled) {
      issues.push({ kind: 'driver', key: 'driver', severity: 'error', message: 'NVIDIA driver is not responding (nvidia-smi failed) - the GPUs cannot be used and every model falls back to the CPU. Reboot to restore GPU acceleration.' })
      if (!notifiedDriverDown) {
        notifiedDriverDown = true
        notifyGpuUnusable('driver', 'The NVIDIA driver stopped responding, so every AI model is falling back to the CPU and replies will be very slow. Reboot the machine to restore GPU acceleration.', 'gpu:driver-down')
      }
    }
    return { supported: true, driverOk: false, gpus: [], expected: baseline, issues, llm }
  }

  if (notifiedDriverDown) {
    // Recovery edge: tell the admin the box is healthy again (the down notification may
    // have been read hours ago; silence here would leave the story half-told).
    notifiedDriverDown = false
    void import('@/lib/notify').then(({ emitNotification }) => emitNotification({
      type: 'system',
      title: 'GPU driver recovered',
      body: 'The NVIDIA driver is responding again and models can use the GPU.',
      url: '/admin/system',
      dedupeKey: 'gpu:driver-recovered',
    })).catch(() => { /* best-effort */ })
  }

  const expected = await growBaseline(stats)
  const present = new Set(stats.map((g) => g.uuid))
  const issues: GpuIssue[] = [...offloadIssues]

  if (config.missing.enabled) {
    for (const e of expected) {
      if (!present.has(e.uuid)) {
        issues.push({ kind: 'missing', key: `missing:${e.uuid}`, severity: 'error', gpu: e.name,
          message: `${e.name} is no longer detected by CUDA (it was present before). Reconnect the GPU or reboot.` })
        if (!notifiedMissing.has(e.uuid)) {
          notifiedMissing.add(e.uuid)
          notifyGpuUnusable('missing', `${e.name} is no longer detected (it was present before). Models that used it are falling back to other devices. Reconnect the GPU or reboot; if it was removed on purpose, reset the baseline from Admin → System → GPU health.`, `gpu:missing:${e.uuid}`)
        }
      } else {
        notifiedMissing.delete(e.uuid)
      }
    }
  }
  for (const g of stats) {
    if (config.overheat.enabled && g.temperatureC != null && g.temperatureC >= config.overheat.thresholdC) {
      issues.push({ kind: 'overheat', key: `overheat:${g.uuid}`, severity: 'warn', gpu: g.name,
        message: `${g.name} is running hot: ${g.temperatureC}°C (alert ≥ ${config.overheat.thresholdC}°C).` })
    }
    if (config.vram.enabled && g.memUsedMb != null && g.memTotalMb) {
      const pct = Math.round((g.memUsedMb / g.memTotalMb) * 100)
      if (pct >= config.vram.thresholdPct) {
        issues.push({ kind: 'vram', key: `vram:${g.uuid}`, severity: 'warn', gpu: g.name,
          message: `${g.name} VRAM is ${pct}% full (${g.memUsedMb}/${g.memTotalMb} MB, alert ≥ ${config.vram.thresholdPct}%).` })
      }
    }
  }

  return { supported: true, driverOk: true, gpus: stats, expected, issues, llm }
}
