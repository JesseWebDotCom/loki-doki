import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getAppSetting, setAppSetting } from '@/lib/settings'
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

export type GpuIssueKind = 'missing' | 'driver' | 'overheat' | 'vram'
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
}

export const DEFAULT_GPU_ALERT_CONFIG: GpuAlertConfig = {
  missing:  { enabled: true },
  driver:   { enabled: true },
  overheat: { enabled: true, thresholdC: 85 },
  vram:     { enabled: true, thresholdPct: 95 },
}

export interface GpuHealth {
  supported: boolean       // false ⇒ no NVIDIA GPU has ever been seen on this machine (feature N/A)
  driverOk: boolean
  gpus: GpuStat[]
  expected: { uuid: string; name: string }[]
  issues: GpuIssue[]
}

/** Partial config accepted by the PUT endpoint. */
export interface GpuAlertConfigPatch {
  missing?:  { enabled?: boolean }
  driver?:   { enabled?: boolean }
  overheat?: { enabled?: boolean; thresholdC?: number }
  vram?:     { enabled?: boolean; thresholdPct?: number }
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
  }
}

export async function setGpuAlertConfig(patch: GpuAlertConfigPatch): Promise<GpuAlertConfig> {
  const cur = await getGpuAlertConfig()
  const merged: GpuAlertConfig = {
    missing:  { enabled: patch.missing?.enabled  ?? cur.missing.enabled },
    driver:   { enabled: patch.driver?.enabled   ?? cur.driver.enabled },
    overheat: { enabled: patch.overheat?.enabled ?? cur.overheat.enabled, thresholdC:   clamp(patch.overheat?.thresholdC   ?? cur.overheat.thresholdC,   40, 120) },
    vram:     { enabled: patch.vram?.enabled     ?? cur.vram.enabled,     thresholdPct: clamp(patch.vram?.thresholdPct     ?? cur.vram.thresholdPct,     50, 100) },
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

export async function getGpuHealth(): Promise<GpuHealth> {
  const config = await getGpuAlertConfig()
  const stats = await queryGpus()
  const baseline = await getBaseline()

  // nvidia-smi failed to run.
  if (stats === null) {
    // Never seen a GPU here ⇒ not an NVIDIA machine; the feature is simply N/A (no false alarm).
    if (baseline.length === 0) return { supported: false, driverOk: false, gpus: [], expected: [], issues: [] }
    const issues: GpuIssue[] = []
    if (config.driver.enabled) {
      issues.push({ kind: 'driver', key: 'driver', severity: 'error', message: 'NVIDIA driver is not responding (nvidia-smi failed) — GPUs may be unavailable.' })
    }
    return { supported: true, driverOk: false, gpus: [], expected: baseline, issues }
  }

  const expected = await growBaseline(stats)
  const present = new Set(stats.map((g) => g.uuid))
  const issues: GpuIssue[] = []

  if (config.missing.enabled) {
    for (const e of expected) {
      if (!present.has(e.uuid)) {
        issues.push({ kind: 'missing', key: `missing:${e.uuid}`, severity: 'error', gpu: e.name,
          message: `${e.name} is no longer detected by CUDA (it was present before). Reconnect the GPU or reboot.` })
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

  return { supported: true, driverOk: true, gpus: stats, expected, issues }
}
