// Admin config + connection test for the Frigate integration. Mirrors the
// adminHomeAssistant shape. Secrets (shim token, MQTT password) are never echoed
// back — the UI shows a "set" flag and only writes them when a new value is typed.

import { Hono } from 'hono'
import type { AppEnv } from '@/types'
import { requireAdmin } from '@/middleware/auth'
import {
  getFrigateConfig, setFrigateConfigValue, ALL_ANNOUNCE_TYPES, type AnnounceType,
} from '@/lib/frigate/config'
import { startFrigateMqtt, isFrigateMqttConnected } from '@/lib/frigate/mqtt'
import { getServerHost } from '@/lib/pod/firmware'

const adminFrigate = new Hono<AppEnv>()

adminFrigate.get('/config', requireAdmin, async (c) => {
  const cfg = await getFrigateConfig()
  // The base_url Frigate must use to reach THIS app's shim. Frigate runs on another
  // box, so it can't use the admin browser's origin (often localhost in dev) — use the
  // server's LAN IP + backend port, the same address devices are pointed at.
  const shimBaseUrl = `http://${await getServerHost()}:${process.env.PORT ?? '3000'}/api/frigate/v1`
  return c.json({
    enabled: cfg.enabled,
    baseUrl: cfg.baseUrl ?? '',
    mqttHost: cfg.mqttHost ?? '',
    mqttPort: cfg.mqttPort,
    mqttUsername: cfg.mqttUsername ?? '',
    announce: cfg.announce,
    knownPlates: cfg.knownPlates,
    shimTokenSet: !!cfg.shimToken,
    mqttPasswordSet: !!cfg.mqttPassword,
    allAnnounceTypes: ALL_ANNOUNCE_TYPES,
    shimBaseUrl,
  })
})

adminFrigate.put('/config', requireAdmin, async (c) => {
  const body = await c.req.json() as Record<string, unknown>

  if ('enabled' in body) await setFrigateConfigValue('enabled', body['enabled'] !== false)
  if (typeof body['baseUrl'] === 'string') await setFrigateConfigValue('base_url', body['baseUrl'].trim())
  if (typeof body['mqttHost'] === 'string') await setFrigateConfigValue('mqtt_host', body['mqttHost'].trim())
  if (body['mqttPort'] !== undefined) {
    const p = Number(body['mqttPort'])
    if (Number.isFinite(p) && p > 0) await setFrigateConfigValue('mqtt_port', Math.floor(p))
  }
  if (typeof body['mqttUsername'] === 'string') await setFrigateConfigValue('mqtt_username', body['mqttUsername'].trim())
  // Secrets: only write when a non-empty value is supplied, so a blank field
  // (the UI never echoes them) doesn't clobber the stored secret.
  if (typeof body['mqttPassword'] === 'string' && body['mqttPassword'].length) {
    await setFrigateConfigValue('mqtt_password', body['mqttPassword'])
  }
  if (typeof body['shimToken'] === 'string' && body['shimToken'].length) {
    await setFrigateConfigValue('shim_token', body['shimToken'].trim())
  }
  if (Array.isArray(body['announce'])) {
    const picked = (body['announce'] as unknown[]).filter(
      (x): x is AnnounceType => ALL_ANNOUNCE_TYPES.includes(x as AnnounceType),
    )
    await setFrigateConfigValue('announce', picked)
  }
  if (body['knownPlates'] && typeof body['knownPlates'] === 'object' && !Array.isArray(body['knownPlates'])) {
    await setFrigateConfigValue('known_plates', body['knownPlates'])
  }

  // Apply broker changes immediately.
  await startFrigateMqtt()
  return c.json({ ok: true })
})

// Generate + store a random shim token (the genai api_key Frigate must send).
adminFrigate.post('/generate-token', requireAdmin, async (c) => {
  const token = `fg_${crypto.randomUUID().replace(/-/g, '')}`
  await setFrigateConfigValue('shim_token', token)
  return c.json({ token })
})

// Probe the Frigate HTTP API + report MQTT connection state.
adminFrigate.get('/test', requireAdmin, async (c) => {
  const cfg = await getFrigateConfig()
  const result: {
    frigate: { configured: boolean; ok: boolean; version?: string; error?: string }
    mqtt: { configured: boolean; connected: boolean }
  } = {
    frigate: { configured: !!cfg.baseUrl, ok: false },
    mqtt: { configured: !!cfg.mqttHost, connected: isFrigateMqttConnected() },
  }

  if (cfg.baseUrl) {
    try {
      const res = await fetch(`${cfg.baseUrl}/api/version`, { signal: AbortSignal.timeout(5000) })
      if (res.ok) {
        result.frigate.ok = true
        result.frigate.version = (await res.text()).trim().slice(0, 40)
      } else {
        result.frigate.error = `HTTP ${res.status}`
      }
    } catch (err) {
      result.frigate.error = err instanceof Error ? err.message : String(err)
    }
  }
  return c.json(result)
})

export { adminFrigate }
