// Uptime Kuma integration config. Stored in the generic `tool_global_config` table
// under toolId 'uptimekuma' (same store Frigate/Home Assistant use) — admin/global
// only, since it points at a LAN monitor and holds a webhook secret + API key that a
// non-admin must not be able to read or repoint. Not a chat tool, so it is NOT in the
// toolRegistry; the admin monitoring routes own read/write.
//
// Delivery model is PUSH: Kuma's built-in Webhook notification POSTs to
// /api/monitoring/webhook?token=<webhookToken> the instant a monitor changes state.
// The reconcile poll of Kuma's /metrics is only a low-frequency safety net for events
// that arrive while the app is down.

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { toolGlobalConfig } from '@/db/schema'

const TOOL_ID = 'uptimekuma'

// Which transitions we alert on at all.
export type MonitorEvent = 'down' | 'up'
export const ALL_MONITOR_EVENTS: MonitorEvent[] = ['down', 'up']

export interface MonitoringConfig {
  enabled: boolean
  announceEnabled: boolean       // master TTS toggle — off = companion never speaks alerts aloud
  webhookToken: string | null    // secret Kuma must present in the webhook URL
  notifyOn: MonitorEvent[]       // which transitions produce a notification at all
  cooldownMinutes: number        // per-monitor+event cooldown (0 = none) to tame flapping
  criticalMonitors: string[]     // monitor names the companion announces ALOUD (others → bell/push only)
  // Reconcile safety net (pull) — catches events missed while the app was down.
  reconcileEnabled: boolean
  reconcileMinutes: number
  baseUrl: string | null         // Kuma base URL, e.g. http://172.19.211.220:3001 (no trailing slash)
  apiKey: string | null          // Kuma API key for the /metrics endpoint (secret)
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length ? t : null
}

export async function getMonitoringConfig(): Promise<MonitoringConfig> {
  const rows = await db.select().from(toolGlobalConfig).where(eq(toolGlobalConfig.toolId, TOOL_ID))
  const raw: Record<string, unknown> = {}
  for (const r of rows) {
    try { raw[r.key] = JSON.parse(r.value) } catch { /* skip malformed */ }
  }

  let notifyOn = ALL_MONITOR_EVENTS
  if (Array.isArray(raw['notify_on'])) {
    const picked = (raw['notify_on'] as unknown[]).filter(
      (x): x is MonitorEvent => ALL_MONITOR_EVENTS.includes(x as MonitorEvent),
    )
    notifyOn = picked.length ? picked : ALL_MONITOR_EVENTS
  }

  const critical: string[] = []
  if (Array.isArray(raw['critical_monitors'])) {
    for (const x of raw['critical_monitors'] as unknown[]) { const s = str(x); if (s) critical.push(s) }
  }

  const cooldown = Number(raw['cooldown_minutes'])
  const reconcile = Number(raw['reconcile_minutes'])
  const baseUrl = str(raw['base_url'])

  return {
    enabled: raw['enabled'] !== false,           // default on once configured
    announceEnabled: raw['announce_enabled'] !== false,  // default on
    webhookToken: str(raw['webhook_token']),
    notifyOn,
    cooldownMinutes: Number.isFinite(cooldown) && cooldown >= 0 ? cooldown : 2,
    criticalMonitors: critical,
    reconcileEnabled: raw['reconcile_enabled'] === true,  // default off — opt-in safety net
    reconcileMinutes: Number.isFinite(reconcile) && reconcile >= 1 ? reconcile : 5,
    baseUrl: baseUrl ? baseUrl.replace(/\/+$/, '') : null,
    apiKey: str(raw['api_key']),
  }
}

export async function setMonitoringConfigValue(key: string, value: unknown): Promise<void> {
  await db.insert(toolGlobalConfig)
    .values({ id: crypto.randomUUID(), toolId: TOOL_ID, key, value: JSON.stringify(value), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [toolGlobalConfig.toolId, toolGlobalConfig.key],
      set: { value: JSON.stringify(value), updatedAt: new Date() },
    })
}

export function isMonitoringConfigured(cfg: MonitoringConfig): boolean {
  return cfg.enabled && !!cfg.webhookToken
}
