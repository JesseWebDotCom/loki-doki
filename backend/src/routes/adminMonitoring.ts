// Admin config + connection test for the Uptime Kuma integration. Mirrors the
// adminFrigate shape. The API key is never echoed back — the UI shows a "set" flag
// and only writes it when a new value is typed. The webhook URL (with token) is
// returned so the admin can paste it straight into Kuma's Webhook notification.

import { Hono } from 'hono'
import type { AppEnv } from '@/types'
import { requireAdmin } from '@/middleware/auth'
import {
  getMonitoringConfig, setMonitoringConfigValue, ALL_MONITOR_EVENTS, type MonitorEvent,
} from '@/lib/monitoring/config'
import { startMonitoringReconcile, fetchMonitorStates } from '@/lib/monitoring/kuma'
import { getServerHost } from '@/lib/pod/firmware'

const adminMonitoring = new Hono<AppEnv>()

adminMonitoring.get('/config', requireAdmin, async (c) => {
  const cfg = await getMonitoringConfig()
  // The URL Kuma must POST to. Kuma runs on another box, so it can't use the admin
  // browser's origin — use the server's LAN host + backend port (same as devices).
  const webhookUrl = cfg.webhookToken
    ? `http://${await getServerHost()}:${process.env.PORT ?? '3000'}/api/monitoring/webhook?token=${cfg.webhookToken}`
    : null
  return c.json({
    enabled: cfg.enabled,
    announceEnabled: cfg.announceEnabled,
    notifyOn: cfg.notifyOn,
    cooldownMinutes: cfg.cooldownMinutes,
    criticalMonitors: cfg.criticalMonitors,
    reconcileEnabled: cfg.reconcileEnabled,
    reconcileMinutes: cfg.reconcileMinutes,
    baseUrl: cfg.baseUrl ?? '',
    apiKeySet: !!cfg.apiKey,
    webhookTokenSet: !!cfg.webhookToken,
    webhookUrl,
    allMonitorEvents: ALL_MONITOR_EVENTS,
  })
})

adminMonitoring.put('/config', requireAdmin, async (c) => {
  const body = await c.req.json() as Record<string, unknown>

  if ('enabled' in body) await setMonitoringConfigValue('enabled', body['enabled'] !== false)
  if ('announceEnabled' in body) await setMonitoringConfigValue('announce_enabled', body['announceEnabled'] !== false)
  if (Array.isArray(body['notifyOn'])) {
    const picked = (body['notifyOn'] as unknown[]).filter(
      (x): x is MonitorEvent => ALL_MONITOR_EVENTS.includes(x as MonitorEvent),
    )
    await setMonitoringConfigValue('notify_on', picked)
  }
  if (body['cooldownMinutes'] !== undefined) {
    const m = Number(body['cooldownMinutes'])
    if (Number.isFinite(m) && m >= 0) await setMonitoringConfigValue('cooldown_minutes', Math.floor(m))
  }
  if (Array.isArray(body['criticalMonitors'])) {
    const names = (body['criticalMonitors'] as unknown[])
      .map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
    await setMonitoringConfigValue('critical_monitors', names)
  }
  if ('reconcileEnabled' in body) await setMonitoringConfigValue('reconcile_enabled', body['reconcileEnabled'] === true)
  if (body['reconcileMinutes'] !== undefined) {
    const m = Number(body['reconcileMinutes'])
    if (Number.isFinite(m) && m >= 1) await setMonitoringConfigValue('reconcile_minutes', Math.floor(m))
  }
  if (typeof body['baseUrl'] === 'string') await setMonitoringConfigValue('base_url', body['baseUrl'].trim())
  // Secret: only write when a non-empty value is supplied so a blank field
  // (the UI never echoes it) doesn't clobber the stored key.
  if (typeof body['apiKey'] === 'string' && body['apiKey'].length) {
    await setMonitoringConfigValue('api_key', body['apiKey'].trim())
  }

  // Apply reconcile-schedule changes immediately.
  await startMonitoringReconcile()
  return c.json({ ok: true })
})

// Generate + store a random webhook token (embedded in the URL Kuma posts to).
adminMonitoring.post('/generate-token', requireAdmin, async (c) => {
  const token = `uk_${crypto.randomUUID().replace(/-/g, '')}`
  await setMonitoringConfigValue('webhook_token', token)
  return c.json({ token })
})

// Probe Kuma's /metrics with the API key + return the discovered monitors (so the
// UI can populate the "critical monitors" picker and confirm the connection).
adminMonitoring.get('/test', requireAdmin, async (c) => {
  const cfg = await getMonitoringConfig()
  if (!cfg.baseUrl || !cfg.apiKey) {
    return c.json({ ok: false, error: 'Set the Kuma URL and API key first' })
  }
  try {
    const states = await fetchMonitorStates(cfg.baseUrl, cfg.apiKey)
    const monitors = [...states.entries()]
      .map(([name, status]) => ({ name, status, up: status === 1 }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return c.json({ ok: true, count: monitors.length, monitors })
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

export { adminMonitoring }
