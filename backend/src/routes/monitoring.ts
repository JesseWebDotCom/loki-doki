// Public (token-authed) webhook receiver for Uptime Kuma's built-in Webhook
// notification. Kuma POSTs here the instant a monitor changes state; the token —
// generated in the admin UI and embedded in the webhook URL — is the only auth,
// since Kuma can't hold a user session. Mirrors the token gate on routes/frigate.ts.

import { Hono } from 'hono'
import type { AppEnv } from '@/types'
import { requireAuth } from '@/middleware/auth'
import { getMonitoringConfig, isMonitoringConfigured } from '@/lib/monitoring/config'
import { handleKumaWebhook, pendingMonitoringAnnouncements, claimMonitoringAnnouncement } from '@/lib/monitoring/kuma'

const monitoring = new Hono<AppEnv>()

// Lightweight gate: is monitoring configured? Clients use this to avoid polling for
// spoken announcements when the integration is off.
monitoring.get('/status', requireAuth, async (c) => {
  return c.json({ enabled: isMonitoringConfigured(await getMonitoringConfig()) })
})

// Browser clients poll this and speak any pending line through the active companion.
monitoring.get('/announcements/pending', requireAuth, (c) => {
  return c.json({ items: pendingMonitoringAnnouncements() })
})

// Claim before speaking so only ONE tab voices a given line.
monitoring.post('/announcements/:id/spoken', requireAuth, (c) => {
  return c.json({ claimed: claimMonitoringAnnouncement(c.req.param('id')) })
})

monitoring.post('/webhook', async (c) => {
  const cfg = await getMonitoringConfig()
  if (!cfg.enabled || !cfg.webhookToken) return c.json({ ok: false, reason: 'not configured' }, 503)

  // Token via ?token= (the Kuma webhook URL is fully configurable) or a header.
  const token = c.req.query('token') || c.req.header('x-monitoring-token')
  if (!token || token !== cfg.webhookToken) return c.json({ ok: false, reason: 'unauthorized' }, 401)

  let body: unknown
  try { body = await c.req.json() } catch { return c.json({ ok: false, reason: 'invalid json' }, 400) }

  const result = await handleKumaWebhook(body as never)
  return c.json(result, result.ok ? 200 : 400)
})

export { monitoring }
