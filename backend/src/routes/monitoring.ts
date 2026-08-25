// Public (token-authed) webhook receiver for Uptime Kuma's built-in Webhook
// notification. Kuma POSTs here the instant a monitor changes state; the token —
// generated in the admin UI and embedded in the webhook URL — is the only auth,
// since Kuma can't hold a user session. Mirrors the token gate on routes/frigate.ts.

import { Hono } from 'hono'
import type { AppEnv } from '@/types'
import { requireAuth } from '@/middleware/auth'
import { getMonitoringConfig, isMonitoringConfigured } from '@/lib/monitoring/config'
import { handleKumaWebhook, pendingMonitoringAnnouncements, claimMonitoringAnnouncement } from '@/lib/monitoring/kuma'
import { handleResourceReport, hasFreshDockSnapshots, type ResourceReportBody } from '@/lib/monitoring/resources'

const monitoring = new Hono<AppEnv>()

// Lightweight gate: is monitoring configured? Clients use this to avoid polling for
// spoken announcements when the integration is off. Dock resource alerts ride the
// same announce queue, so a household with a reporting dock counts as enabled even
// without Uptime Kuma.
monitoring.get('/status', requireAuth, async (c) => {
  return c.json({ enabled: isMonitoringConfigured(await getMonitoringConfig()) || hasFreshDockSnapshots() })
})

// MaiPai Desktop's HUD posts local machine snapshots + threshold-alert events here
// (authed with its own logged-in session — see desktop/src/resources.js).
monitoring.post('/resources/report', requireAuth, async (c) => {
  const user = c.get('user')
  let body: ResourceReportBody
  try { body = await c.req.json() as ResourceReportBody } catch { return c.json({ ok: false, ackIds: [] }, 400) }
  return c.json(await handleResourceReport(user.id, body))
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
