// Uptime Kuma ingestion: the single place that turns a state change — whether it
// arrives via the real-time Webhook (push, primary) or the reconcile poll of
// /metrics (pull, safety net) — into a stored notification and, for a "critical"
// monitor, a spoken companion announcement. Kept separate from the transports so
// both sources share identical dedup / cooldown / notify behavior.

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { users } from '@/db/schema'
import { logger } from '@/lib/logger'
import { emitNotification } from '@/lib/notify'
import { getMonitoringConfig } from './config'

// Kuma /metrics status codes.
const STATUS_DOWN = 0
const STATUS_UP = 1
// 2 = PENDING, 3 = MAINTENANCE — we don't alert on those.

// Last-known status per monitor name. Shared by webhook + reconcile so the poll
// never re-fires what the webhook already reported (and vice-versa).
const lastStatus = new Map<string, number>()

// ── Spoken announcements (companion voice) ────────────────────────────────────
// For a "critical" monitor we queue a natural, companion-voiced line that the
// frontend MonitoringAnnounceProvider polls, claims (so only one tab speaks), and
// speaks aloud — mirroring the Frigate announce path. Ephemeral + in-memory.
interface PendingAnnounce { id: string; text: string; createdAt: number }
const announceQueue: PendingAnnounce[] = []
const claimedAnnounce = new Set<string>()

export function pendingMonitoringAnnouncements(): { id: string; text: string }[] {
  const cutoff = Date.now() - 120_000  // drop lines older than 2 min (nobody was listening)
  for (let i = announceQueue.length - 1; i >= 0; i--) {
    const a = announceQueue[i]
    if (a && a.createdAt < cutoff) announceQueue.splice(i, 1)
  }
  return announceQueue.filter((a) => !claimedAnnounce.has(a.id)).map((a) => ({ id: a.id, text: a.text }))
}

export function claimMonitoringAnnouncement(id: string): boolean {
  if (claimedAnnounce.has(id)) return false
  claimedAnnounce.add(id)
  if (claimedAnnounce.size > 500) for (const k of [...claimedAnnounce].slice(0, 250)) claimedAnnounce.delete(k)
  return true
}

// Exported: dock resource alerts (lib/monitoring/resources.ts) ride this same
// queue so the existing pending/claim endpoints + announce provider speak them.
export function enqueueAnnouncement(text: string): void {
  announceQueue.push({ id: crypto.randomUUID(), text, createdAt: Date.now() })
  if (announceQueue.length > 50) announceQueue.shift()
}

// The person the companion is talking to (household admin). Cached briefly.
let cachedName: { name: string | null; at: number } | null = null
export async function adminDisplayName(): Promise<string | null> {
  if (cachedName && Date.now() - cachedName.at < 300_000) return cachedName.name
  let name: string | null = null
  try {
    const [row] = await db.select({ nickname: users.nickname, firstName: users.firstName })
      .from(users).where(eq(users.role, 'admin')).limit(1)
    name = row?.nickname?.trim() || row?.firstName?.trim() || null
  } catch { /* fall back to no name */ }
  cachedName = { name, at: Date.now() }
  return name
}

// Natural, spoken-tone line — e.g. "Hey Jesse, Plex seems to be down right now."
function naturalLine(name: string | null, monitor: string, event: 'down' | 'up'): string {
  if (event === 'down') {
    return name ? `Hey ${name}, ${monitor} seems to be down right now.`
      : `Heads up, ${monitor} seems to be down right now.`
  }
  return name ? `Good news ${name}, ${monitor} is back up and running.`
    : `${monitor} is back up and running.`
}

// Per monitor+event cooldown to tame a flapping service.
const cooldownMap = new Map<string, number>()
function withinCooldown(name: string, event: string, minutes: number): boolean {
  if (minutes <= 0) return false
  const last = cooldownMap.get(`${name}:${event}`) ?? 0
  return Date.now() - last < minutes * 60_000
}
function markCooldown(name: string, event: string): void {
  cooldownMap.set(`${name}:${event}`, Date.now())
}

/**
 * Core state-transition handler. `newStatus` is Kuma's code (0 down / 1 up).
 * Fires a notification only on an actual change, subject to the admin's prefs.
 */
async function processTransition(name: string, newStatus: number, message: string | null): Promise<void> {
  if (newStatus !== STATUS_DOWN && newStatus !== STATUS_UP) return  // ignore pending/maintenance
  const prev = lastStatus.get(name)
  lastStatus.set(name, newStatus)

  if (prev === newStatus) return                          // no change (dup webhook / steady poll)
  if (prev === undefined && newStatus === STATUS_UP) return  // first sight of a healthy monitor — not an event

  const cfg = await getMonitoringConfig()
  if (!cfg.enabled) return

  const event: 'down' | 'up' = newStatus === STATUS_DOWN ? 'down' : 'up'
  if (!cfg.notifyOn.includes(event)) return
  if (withinCooldown(name, event, cfg.cooldownMinutes)) return
  markCooldown(name, event)

  const isCritical = cfg.criticalMonitors.length === 0 || cfg.criticalMonitors.includes(name)
  const announce = isCritical && cfg.announceEnabled

  await emitNotification({
    type: 'service_alert',
    userId: null,  // admin-targeted; delivery fan-out handles push/telegram/pod per admin
    priority: event === 'down' ? 'urgent' : 'normal',
    payload: {
      monitor: name,
      state: event,
      message: message ?? undefined,
      // `announce` gates the spoken-aloud companion layer (mirrors Frigate's announce flag);
      // everything still lands in the bell + configured channels regardless.
      announce,
    },
  })

  // Critical monitor → queue a natural companion line the frontend speaks aloud.
  if (announce) {
    const spoken = naturalLine(await adminDisplayName(), name, event)
    enqueueAnnouncement(spoken)
  }
  logger.info(`[monitoring] ${name} → ${event}${announce ? ' (announce)' : ''}`)
}

// ---- Webhook (push, primary) -------------------------------------------------

interface KumaWebhookBody {
  heartbeat?: { status?: number; msg?: string; monitorID?: number }
  monitor?: { name?: string; url?: string }
  msg?: string
}

/** Handle one Uptime Kuma "Webhook" notification POST. */
export async function handleKumaWebhook(body: KumaWebhookBody): Promise<{ ok: boolean; reason?: string }> {
  const name = body?.monitor?.name?.trim()
  const status = body?.heartbeat?.status
  if (!name || typeof status !== 'number') return { ok: false, reason: 'missing monitor name or status' }
  const message = body?.heartbeat?.msg ?? body?.msg ?? null
  await processTransition(name, status, message)
  return { ok: true }
}

// ---- Reconcile poll (pull, safety net) --------------------------------------

/** Basic-auth header for Kuma's /metrics (API key is the password, empty user). */
function metricsAuth(apiKey: string): string {
  return `Basic ${Buffer.from(`:${apiKey}`).toString('base64')}`
}

/** Fetch + parse `monitor_status{monitor_name="X",...} N` lines from Kuma /metrics. */
export async function fetchMonitorStates(baseUrl: string, apiKey: string): Promise<Map<string, number>> {
  const res = await fetch(`${baseUrl}/metrics`, {
    headers: { Authorization: metricsAuth(apiKey) },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  const states = new Map<string, number>()
  const re = /^monitor_status\{([^}]*)\}\s+(\d+)/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const labels = m[1] ?? ''
    const nameMatch = /monitor_name="((?:[^"\\]|\\.)*)"/.exec(labels)
    const rawName = nameMatch?.[1]
    if (rawName === undefined) continue
    const statusStr = m[2]
    if (statusStr === undefined) continue
    states.set(rawName.replace(/\\"/g, '"'), Number(statusStr))
  }
  return states
}

export interface MonitorDetail {
  name: string
  up: boolean
  status: number          // 0 down, 1 up, 2 pending, 3 maintenance
  responseMs: number | null
}

/** Fetch status + response time for every monitor — used by the companion status tool. */
export async function fetchMonitorDetails(baseUrl: string, apiKey: string): Promise<MonitorDetail[]> {
  const res = await fetch(`${baseUrl}/metrics`, {
    headers: { Authorization: metricsAuth(apiKey) },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  const status = new Map<string, number>()
  const resp = new Map<string, number>()
  const collect = (metric: string, into: Map<string, number>) => {
    const re = new RegExp(`^${metric}\\{([^}]*)\\}\\s+([0-9.eE+-]+)`, 'gm')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const nameMatch = /monitor_name="((?:[^"\\]|\\.)*)"/.exec(m[1] ?? '')
      const raw = nameMatch?.[1]; const val = m[2]
      if (raw === undefined || val === undefined) continue
      into.set(raw.replace(/\\"/g, '"'), Number(val))
    }
  }
  collect('monitor_status', status)
  collect('monitor_response_time', resp)
  return [...status.entries()].map(([name, s]) => ({
    name,
    status: s,
    up: s === STATUS_UP,
    responseMs: resp.has(name) ? Math.round(resp.get(name)!) : null,
  }))
}

let reconcileTimer: ReturnType<typeof setInterval> | null = null

async function reconcileOnce(): Promise<void> {
  const cfg = await getMonitoringConfig()
  if (!cfg.enabled || !cfg.reconcileEnabled || !cfg.baseUrl || !cfg.apiKey) return
  try {
    const states = await fetchMonitorStates(cfg.baseUrl, cfg.apiKey)
    for (const [name, status] of states) await processTransition(name, status, null)
  } catch (err) {
    logger.warn(`[monitoring] reconcile poll failed: ${err instanceof Error ? err.message : err}`)
  }
}

/** (Re)start the reconcile poll on the configured interval. Idempotent — call after config changes. */
export async function startMonitoringReconcile(): Promise<void> {
  if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null }
  const cfg = await getMonitoringConfig()
  if (!cfg.enabled || !cfg.reconcileEnabled || !cfg.baseUrl || !cfg.apiKey) return
  const ms = Math.max(1, cfg.reconcileMinutes) * 60_000
  reconcileTimer = setInterval(() => { void reconcileOnce() }, ms)
  logger.info(`[monitoring] reconcile poll every ${cfg.reconcileMinutes}m`)
}
