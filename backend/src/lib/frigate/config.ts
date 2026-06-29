// Frigate integration config. Stored in the generic `tool_global_config` table
// under toolId 'frigate' (same store Home Assistant uses), so it's admin/global
// only — Frigate lives on the LAN and a non-admin must not be able to repoint the
// MQTT broker or shim at an internal service. Frigate is NOT a chat tool, so it is
// deliberately NOT in the toolRegistry; we just reuse the config table + the admin
// Frigate routes own read/write.

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { toolGlobalConfig } from '@/db/schema'

const TOOL_ID = 'frigate'

// Which detection classes proactively speak via the companion. Everything that
// passes the announce/notify gate is still stored + notified; `announce` only
// gates the spoken-aloud layer.
export type AnnounceType = 'person' | 'delivery' | 'plate' | 'suspicious'
export const ALL_ANNOUNCE_TYPES: AnnounceType[] = ['person', 'delivery', 'plate', 'suspicious']

export interface FrigateConfig {
  enabled: boolean
  announceEnabled: boolean      // master TTS toggle — off = no spoken announcements
  cooldownMinutes: number       // per-camera cooldown (0 = no cooldown)
  baseUrl: string | null        // e.g. http://192.168.1.50:5000  (no trailing slash)
  mqttHost: string | null
  mqttPort: number
  mqttUsername: string | null
  mqttPassword: string | null
  shimToken: string | null      // bearer the shim requires from Frigate's genai api_key
  announce: AnnounceType[]      // which classes speak aloud
  knownPlates: Record<string, string>  // normalized plate -> friendly name ("ABC1234" -> "Mom's car")
}

export const FRIGATE_CONFIG_KEYS = [
  'enabled', 'announce_enabled', 'cooldown_minutes',
  'base_url', 'mqtt_host', 'mqtt_port', 'mqtt_username',
  'mqtt_password', 'shim_token', 'announce', 'known_plates',
] as const

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length ? t : null
}

export function normalizePlate(plate: string): string {
  return plate.replace(/[^a-z0-9]/gi, '').toUpperCase()
}

export async function getFrigateConfig(): Promise<FrigateConfig> {
  const rows = await db.select().from(toolGlobalConfig).where(eq(toolGlobalConfig.toolId, TOOL_ID))
  const raw: Record<string, unknown> = {}
  for (const r of rows) {
    try { raw[r.key] = JSON.parse(r.value) } catch { /* skip malformed */ }
  }

  const baseUrl = str(raw['base_url'])
  const port = Number(raw['mqtt_port'])

  // known_plates is stored as a { plate: name } object; normalize keys for lookup.
  const knownPlates: Record<string, string> = {}
  const kp = raw['known_plates']
  if (kp && typeof kp === 'object' && !Array.isArray(kp)) {
    for (const [k, v] of Object.entries(kp as Record<string, unknown>)) {
      const name = str(v)
      if (name) knownPlates[normalizePlate(k)] = name
    }
  }

  let announce = ALL_ANNOUNCE_TYPES
  if (Array.isArray(raw['announce'])) {
    const picked = (raw['announce'] as unknown[]).filter(
      (x): x is AnnounceType => ALL_ANNOUNCE_TYPES.includes(x as AnnounceType),
    )
    announce = picked
  }

  const cooldown = Number(raw['cooldown_minutes'])

  return {
    enabled: raw['enabled'] !== false,  // default on once configured
    announceEnabled: raw['announce_enabled'] !== false,  // default on
    cooldownMinutes: Number.isFinite(cooldown) && cooldown >= 0 ? cooldown : 0,
    baseUrl: baseUrl ? baseUrl.replace(/\/+$/, '') : null,
    mqttHost: str(raw['mqtt_host']),
    mqttPort: Number.isFinite(port) && port > 0 ? port : 1883,
    mqttUsername: str(raw['mqtt_username']),
    mqttPassword: str(raw['mqtt_password']),
    shimToken: str(raw['shim_token']),
    announce,
    knownPlates,
  }
}

export async function setFrigateConfigValue(key: string, value: unknown): Promise<void> {
  // Upsert by (toolId, key) — table has a unique constraint on the pair.
  await db.insert(toolGlobalConfig)
    .values({ id: crypto.randomUUID(), toolId: TOOL_ID, key, value: JSON.stringify(value), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [toolGlobalConfig.toolId, toolGlobalConfig.key],
      set: { value: JSON.stringify(value), updatedAt: new Date() },
    })
}

export function isFrigateConfigured(cfg: FrigateConfig): boolean {
  return cfg.enabled && !!cfg.baseUrl
}
