// Local machine resource monitor: samples CPU / memory / disk / battery on the
// machine running MaiPai Desktop and turns sustained threshold crossings into alert
// events. The main process only COLLECTS (dep-free: node:os + statfs + pmset);
// the HUD page reads snapshots over IPC and reports events to the server with
// its own logged-in session — this process never talks to the server.
//
// Anti-flap: each metric has an enter threshold + sustain window + exit
// hysteresis, plus a per-metric re-fire cooldown, so a value oscillating around
// the threshold can't spam notifications.

const os = require('node:os')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)

const SAMPLE_MS = 15_000
const REFIRE_COOLDOWN_MS = 30 * 60_000
const MAX_PENDING = 50
const MAX_RECENT = 20

// Battery snapshot, 60s cache. darwin only for now (pmset); Windows could use
// powershell WMI later. null = no battery / unsupported / error.
const batteryCache = { ts: 0, value: null }
async function readBattery() {
  if (Date.now() - batteryCache.ts < 60_000) return batteryCache.value
  batteryCache.ts = Date.now()
  if (process.platform !== 'darwin') {
    batteryCache.value = null
    return null
  }
  try {
    const { stdout } = await execFileAsync('pmset', ['-g', 'batt'])
    const pct = /(\d+)%/.exec(stdout)
    if (!pct) {
      batteryCache.value = null
      return null
    }
    const charging = /'AC Power'/.test(stdout) || /;\s*charging/.test(stdout)
    batteryCache.value = { percent: Number(pct[1]), charging }
  } catch {
    batteryCache.value = null
  }
  return batteryCache.value
}

// ── Collector state ────────────────────────────────────────────────────────────

let getSettingsFn = null
let sampleTimer = null
let machineId = ''

let snapshot = null
let prevCpuTimes = null

// Per-metric threshold state machine.
const metrics = {
  cpu: { firing: false, highSince: null, lowStreak: 0, lastFiredAt: 0 },
  memory: { firing: false, highSince: null, lowStreak: 0, lastFiredAt: 0 },
  disk: { firing: false, lastFiredAt: 0 },
  battery: { firing: false, lastFiredAt: 0 },
}

const pendingEvents = [] // delivered to the server via the HUD reporter; cleared by ack
const recentAlerts = []  // display ring for the island stats page

function config() {
  const s = getSettingsFn ? getSettingsFn() : {}
  const rm = s.resourceMonitor && typeof s.resourceMonitor === 'object' ? s.resourceMonitor : {}
  return {
    enabled: rm.enabled !== false,
    announce: rm.announce === true,
    cpuPct: clampNum(rm.cpuPct, 50, 100, 90),
    cpuSustainMin: clampNum(rm.cpuSustainMin, 1, 60, 5),
    memPct: clampNum(rm.memPct, 50, 100, 90),
    diskFreePct: clampNum(rm.diskFreePct, 1, 50, 10),
    batteryPct: clampNum(rm.batteryPct, 5, 50, 15),
  }
}

function clampNum(v, min, max, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, n))
}

function cpuPercent() {
  const cpus = os.cpus()
  let idle = 0
  let total = 0
  for (const c of cpus) {
    idle += c.times.idle
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
  }
  const prev = prevCpuTimes
  prevCpuTimes = { idle, total }
  if (!prev || total <= prev.total) return null
  const dTotal = total - prev.total
  const dIdle = idle - prev.idle
  return Math.max(0, Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 100)))
}

async function diskFree() {
  try {
    const st = await fs.promises.statfs(os.homedir())
    const total = st.blocks * st.bsize
    const free = st.bavail * st.bsize
    if (!total) return null
    return { freeBytes: free, totalBytes: total, freePct: Math.round((free / total) * 100) }
  } catch {
    return null
  }
}

function pushEvent(metric, state, value, threshold, message) {
  const ev = {
    id: crypto.randomUUID(),
    metric,
    state, // 'firing' | 'recovered'
    value,
    threshold,
    message,
    at: Date.now(),
  }
  pendingEvents.push(ev)
  if (pendingEvents.length > MAX_PENDING) pendingEvents.splice(0, pendingEvents.length - MAX_PENDING)
  recentAlerts.unshift(ev)
  if (recentAlerts.length > MAX_RECENT) recentAlerts.length = MAX_RECENT
}

/** Fire/recover with re-fire cooldown. Returns nothing; mutates metric state. */
function transition(m, key, firing, value, threshold, fireMsg, recoverMsg) {
  if (firing && !m.firing) {
    m.firing = true
    if (Date.now() - m.lastFiredAt >= REFIRE_COOLDOWN_MS) {
      m.lastFiredAt = Date.now()
      pushEvent(key, 'firing', value, threshold, fireMsg)
    }
  } else if (!firing && m.firing) {
    m.firing = false
    // Only announce a recovery if the firing itself was announced (not cooldown-suppressed).
    if (m.lastFiredAt && Date.now() - m.lastFiredAt < REFIRE_COOLDOWN_MS * 2) {
      pushEvent(key, 'recovered', value, threshold, recoverMsg)
    }
  }
}

async function sample() {
  const cfg = config()
  if (!cfg.enabled) return

  const cpu = cpuPercent() // null on the first sample (needs a delta)
  const memTotal = os.totalmem()
  const memFree = os.freemem()
  const memUsedPct = memTotal ? Math.round(((memTotal - memFree) / memTotal) * 100) : null
  const disk = await diskFree()
  const battery = await readBattery()
  const now = Date.now()

  snapshot = {
    at: now,
    cpuPct: cpu,
    cpuCount: os.cpus().length,
    loadAvg1m: os.loadavg()[0],
    memUsedPct,
    memTotalGb: round1(memTotal / 2 ** 30),
    memFreeGb: round1(memFree / 2 ** 30),
    diskFreePct: disk?.freePct ?? null,
    diskFreeGb: disk ? round1(disk.freeBytes / 2 ** 30) : null,
    diskTotalGb: disk ? round1(disk.totalBytes / 2 ** 30) : null,
    battery,
  }

  // CPU: must stay ≥ threshold for the whole sustain window; recovers after two
  // consecutive samples below (threshold − 10).
  if (cpu != null) {
    const m = metrics.cpu
    if (cpu >= cfg.cpuPct) {
      m.highSince = m.highSince ?? now
      m.lowStreak = 0
      const sustained = now - m.highSince >= cfg.cpuSustainMin * 60_000
      if (sustained) {
        transition(m, 'cpu', true, cpu, cfg.cpuPct,
          `Processor has been above ${cfg.cpuPct}% for ${cfg.cpuSustainMin} minute${cfg.cpuSustainMin === 1 ? '' : 's'} (now ${cpu}%).`,
          '')
      }
    } else {
      m.highSince = null
      if (cpu < cfg.cpuPct - 10) m.lowStreak++
      else m.lowStreak = 0
      if (m.firing && m.lowStreak >= 2) {
        transition(m, 'cpu', false, cpu, cfg.cpuPct, '', `Processor load is back to normal (${cpu}%).`)
      }
    }
  }

  // Memory: ≥ threshold sustained 2 minutes; recovers below (threshold − 5) twice.
  if (memUsedPct != null) {
    const m = metrics.memory
    if (memUsedPct >= cfg.memPct) {
      m.highSince = m.highSince ?? now
      m.lowStreak = 0
      if (now - m.highSince >= 2 * 60_000) {
        transition(m, 'memory', true, memUsedPct, cfg.memPct,
          `Memory is nearly full — ${memUsedPct}% in use.`, '')
      }
    } else {
      m.highSince = null
      if (memUsedPct < cfg.memPct - 5) m.lowStreak++
      else m.lowStreak = 0
      if (m.firing && m.lowStreak >= 2) {
        transition(m, 'memory', false, memUsedPct, cfg.memPct, '', `Memory usage is back to normal (${memUsedPct}%).`)
      }
    }
  }

  // Disk: level-triggered with +2% exit hysteresis (free space doesn't flap fast).
  if (disk) {
    const m = metrics.disk
    if (disk.freePct <= cfg.diskFreePct) {
      transition(m, 'disk', true, disk.freePct, cfg.diskFreePct,
        `Disk space is low — ${disk.freePct}% free (${round1(disk.freeBytes / 2 ** 30)} GB left).`, '')
    } else if (m.firing && disk.freePct >= cfg.diskFreePct + 2) {
      transition(m, 'disk', false, disk.freePct, cfg.diskFreePct, '',
        `Disk space recovered — ${disk.freePct}% free.`)
    }
  }

  // Battery: low + discharging; recovers on charge or +5%.
  if (battery) {
    const m = metrics.battery
    if (battery.percent <= cfg.batteryPct && !battery.charging) {
      transition(m, 'battery', true, battery.percent, cfg.batteryPct,
        `Battery is low — ${battery.percent}% and not charging.`, '')
    } else if (m.firing && (battery.charging || battery.percent >= cfg.batteryPct + 5)) {
      transition(m, 'battery', false, battery.percent, cfg.batteryPct, '',
        battery.charging ? 'Battery is charging again.' : `Battery is back to ${battery.percent}%.`)
    }
  }
}

function round1(n) {
  return Math.round(n * 10) / 10
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Start sampling. `getSettings` returns the live settings object; `persistMachineId`
 *  is called once to store a generated machine id (settings.save). */
function start(getSettings, persistMachineId) {
  getSettingsFn = getSettings
  const s = getSettings()
  machineId = typeof s.machineId === 'string' && s.machineId ? s.machineId : crypto.randomUUID()
  if (s.machineId !== machineId) persistMachineId(machineId)
  if (sampleTimer) clearInterval(sampleTimer)
  void sample() // prime CPU delta + first snapshot immediately
  sampleTimer = setInterval(() => { void sample() }, SAMPLE_MS)
}

/** Thresholds changed in the island settings; next sample reads them live (config()
 *  re-reads settings every sample, so this only needs to reset sustain windows). */
function applyConfig() {
  metrics.cpu.highSince = null
  metrics.memory.highSince = null
}

function getState() {
  const cfg = config()
  return {
    machineId,
    hostname: os.hostname().replace(/\.local$/i, ''),
    platform: process.platform,
    enabled: cfg.enabled,
    announce: cfg.announce,
    snapshot,
    firing: Object.entries(metrics).filter(([, m]) => m.firing).map(([k]) => k),
    recentAlerts: [...recentAlerts],
    pendingEvents: [...pendingEvents],
  }
}

/** Remove delivered events (called after the HUD's report POST succeeds). */
function ackEvents(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return
  const drop = new Set(ids.filter((id) => typeof id === 'string'))
  for (let i = pendingEvents.length - 1; i >= 0; i--) {
    if (drop.has(pendingEvents[i].id)) pendingEvents.splice(i, 1)
  }
}

module.exports = { start, applyConfig, getState, ackEvents, readBattery }
