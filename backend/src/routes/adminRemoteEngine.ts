import { Hono } from 'hono'
import { requireAdmin } from '@/middleware/auth'
import type { AppEnv } from '@/types'
import { remoteEngineState, probeRemote, setRemoteConfig } from '@/lib/remoteEngine'

const adminRemoteEngineRoute = new Hono<AppEnv>()

// GET /api/admin/remote-engine — current pairing config + a fresh reachability probe.
adminRemoteEngineRoute.get('/', requireAdmin, async (c) => {
  const st = remoteEngineState()
  const probe = st.baseUrl ? await probeRemote(st.baseUrl) : null
  return c.json({ ...st, probe })
})

// POST /api/admin/remote-engine/probe — validate a host before saving.
adminRemoteEngineRoute.post('/probe', requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({})) as { baseUrl?: string }
  if (!body.baseUrl?.trim()) return c.json({ error: 'baseUrl required' }, 400)
  return c.json(await probeRemote(body.baseUrl))
})

// PUT /api/admin/remote-engine — save config and/or toggle pairing on/off.
adminRemoteEngineRoute.put('/', requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    baseUrl?: string | null; model?: string | null; enabled?: boolean
  }
  if (body.enabled === true && !(body.baseUrl ?? remoteEngineState().baseUrl)) {
    return c.json({ error: 'A base URL is required to enable the remote engine' }, 400)
  }
  const next = await setRemoteConfig(body)
  return c.json({ ...next, localUrl: remoteEngineState().localUrl })
})

export { adminRemoteEngineRoute }
