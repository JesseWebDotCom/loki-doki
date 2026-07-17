// Admin -> Server -> Remote Access: Tailscale status, connect/disconnect, and the
// tailnet URL family phones use to reach the app from anywhere.

import { Hono } from 'hono'
import { requireAdmin } from '@/middleware/auth'
import { getTailscaleStatus, tailscaleDown, tailscaleUp } from '@/lib/tailscale'

const app = new Hono()
app.use('*', requireAdmin)

const port = parseInt(process.env.PORT ?? '3000')

function withAppUrl(status: Awaited<ReturnType<typeof getTailscaleStatus>>) {
  // MagicDNS name preferred (stable, readable); fall back to the tailnet IP.
  const host = status.dnsName ?? status.ips[0] ?? null
  const appUrl = status.state === 'running' && host ? `http://${host}:${port}` : null
  return { ...status, appUrl }
}

app.get('/', async (c) => c.json(withAppUrl(await getTailscaleStatus())))
app.post('/connect', async (c) => c.json(withAppUrl(await tailscaleUp())))
app.post('/disconnect', async (c) => c.json(withAppUrl(await tailscaleDown())))

export default app
