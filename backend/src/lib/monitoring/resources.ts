// Dock resource monitoring ingest: Doki Dock installs sample their machine's
// CPU/memory/disk/battery locally (desktop/src/resources.js) and their HUD page
// POSTs snapshots + threshold-alert events here. Snapshots feed the companion's
// machine_status tool; alert events become notifications (+ optional spoken
// announcement via the shared Kuma announce queue). In-memory only — a machine
// whose dock is closed simply goes stale and drops out of listFreshSnapshots.

import { logger } from '@/lib/logger'
import { emitNotification } from '@/lib/notify'
import { adminDisplayName, enqueueAnnouncement } from './kuma'

const FRESH_MS = 5 * 60_000

export interface MachineInfo {
  id: string
  hostname: string
  label: string
  platform: string
}

export interface ResourceSnapshot {
  at: number
  cpuPct: number | null
  cpuCount: number
  loadAvg1m: number
  memUsedPct: number | null
  memTotalGb: number
  memFreeGb: number
  diskFreePct: number | null
  diskFreeGb: number | null
  diskTotalGb: number | null
  battery: { percent: number; charging: boolean } | null
}

interface ResourceEvent {
  id: string
  metric: 'cpu' | 'memory' | 'disk' | 'battery'
  state: 'firing' | 'recovered'
  value: number
  threshold: number
  message: string
  at: number
}

interface MachineRecord {
  machine: MachineInfo
  snapshot: ResourceSnapshot | null
  userId: string
  updatedAt: number
  // Last delivered state per metric — guards double-notifies when a report's ack
  // was lost and the dock re-sends the same events.
  lastEventState: Map<string, 'firing' | 'recovered'>
}

const machines = new Map<string, MachineRecord>()

export function listFreshSnapshots(maxAgeMs = FRESH_MS): Array<{ machine: MachineInfo; snapshot: ResourceSnapshot; ageMs: number }> {
  const now = Date.now()
  const out: Array<{ machine: MachineInfo; snapshot: ResourceSnapshot; ageMs: number }> = []
  for (const rec of machines.values()) {
    if (!rec.snapshot) continue
    const age = now - rec.updatedAt
    if (age <= maxAgeMs) out.push({ machine: rec.machine, snapshot: rec.snapshot, ageMs: age })
  }
  return out
}

/** True when any dock has reported recently — turns the announce poller on for
 *  households that never configured Uptime Kuma. */
export function hasFreshDockSnapshots(): boolean {
  return listFreshSnapshots().length > 0
}

function spokenLine(name: string | null, label: string, ev: ResourceEvent): string {
  const lead = name ? `Hey ${name},` : 'Heads up,'
  if (ev.state === 'recovered') {
    return name ? `Good news ${name}, ${label} is okay again — ${ev.message.toLowerCase()}` : `${label} is okay again — ${ev.message.toLowerCase()}`
  }
  return `${lead} ${label} needs attention. ${ev.message}`
}

function validEvent(raw: unknown): ResourceEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  if (typeof e.id !== 'string' || typeof e.message !== 'string') return null
  if (e.state !== 'firing' && e.state !== 'recovered') return null
  if (e.metric !== 'cpu' && e.metric !== 'memory' && e.metric !== 'disk' && e.metric !== 'battery') return null
  return {
    id: e.id,
    metric: e.metric,
    state: e.state,
    value: Number(e.value) || 0,
    threshold: Number(e.threshold) || 0,
    message: e.message,
    at: Number(e.at) || Date.now(),
  }
}

export interface ResourceReportBody {
  machine?: { id?: unknown; hostname?: unknown; label?: unknown; platform?: unknown }
  snapshot?: unknown
  events?: unknown[]
  announce?: unknown
}

/** Handle one HUD report POST: store the snapshot, notify (+announce) each new event.
 *  Returns the event ids that were processed so the dock can ack them. */
export async function handleResourceReport(userId: string, body: ResourceReportBody): Promise<{ ok: boolean; ackIds: string[] }> {
  const id = typeof body.machine?.id === 'string' ? body.machine.id : ''
  if (!id) return { ok: false, ackIds: [] }
  const hostname = typeof body.machine?.hostname === 'string' && body.machine.hostname ? body.machine.hostname : 'computer'
  const machine: MachineInfo = {
    id,
    hostname,
    label: typeof body.machine?.label === 'string' && body.machine.label ? body.machine.label : hostname,
    platform: typeof body.machine?.platform === 'string' ? body.machine.platform : 'unknown',
  }
  let rec = machines.get(id)
  if (!rec) {
    rec = { machine, snapshot: null, userId, updatedAt: 0, lastEventState: new Map() }
    machines.set(id, rec)
  }
  rec.machine = machine
  rec.userId = userId
  rec.updatedAt = Date.now()
  if (body.snapshot && typeof body.snapshot === 'object') rec.snapshot = body.snapshot as ResourceSnapshot

  const announce = body.announce === true
  const events = Array.isArray(body.events) ? body.events.map(validEvent).filter((e): e is ResourceEvent => !!e) : []
  const ackIds: string[] = events.map((e) => e.id)

  for (const ev of events) {
    if (rec.lastEventState.get(ev.metric) === ev.state) continue // lost-ack replay
    rec.lastEventState.set(ev.metric, ev.state)

    await emitNotification({
      type: 'resource_alert',
      userId: null, // admin-targeted, like service_alert
      priority: ev.state === 'firing' ? 'urgent' : 'normal',
      payload: {
        machineId: machine.id,
        label: machine.label,
        metric: ev.metric,
        state: ev.state,
        value: ev.value,
        message: ev.message,
        announce,
      },
      // One unread row per machine+metric while it's firing; recoveries always land.
      dedupeKey: ev.state === 'firing' ? `resource:${machine.id}:${ev.metric}` : undefined,
    })

    if (announce) {
      enqueueAnnouncement(spokenLine(await adminDisplayName(), machine.label, ev))
    }
    logger.info(`[resources] ${machine.label}: ${ev.metric} ${ev.state} (${ev.value} / threshold ${ev.threshold})${announce ? ' (announce)' : ''}`)
  }

  return { ok: true, ackIds }
}
