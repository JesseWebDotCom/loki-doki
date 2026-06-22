import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { requireAdmin } from '@/middleware/auth'
import { ensureConnected, getStore, getGlobalConnection } from '@/lib/homeAssistant'
import { getGrants, setGrants, type Grant } from '@/lib/homeAssistant/permissions'
import { describeError } from '@/lib/homeAssistant/client'
import { db } from '@/db'
import { users, haUserGrants } from '@/db/schema'
import type { AppEnv } from '@/types'

const adminHomeAssistant = new Hono<AppEnv>()

function statusOf() {
  return getGlobalConnection().then((conn) => {
    if (!conn) return { configured: false as const }
    const store = getStore(conn)
    return {
      configured: true as const,
      connected: store?.connected ?? false,
      lastSyncMs: store?.lastSyncMs ?? null,
      lastError: store?.lastError ?? null,
      entities: store?.entities.size ?? 0,
      areas: store?.areas.size ?? 0,
    }
  })
}

// Connection + sync status for the admin panel.
adminHomeAssistant.get('/status', requireAdmin, async (c) => c.json(await statusOf()))

// Force a (re)connect + sync — useful right after entering credentials.
adminHomeAssistant.post('/sync', requireAdmin, async (c) => {
  const conn = await getGlobalConnection()
  if (!conn) return c.json({ configured: false }, 400)
  try {
    await ensureConnected(conn)
  } catch (err) {
    const d = describeError(err)
    return c.json({ configured: true, connected: false, error: d.message }, 502)
  }
  return c.json(await statusOf())
})

// Full catalog — for debugging resolutions and for populating the grant UI.
adminHomeAssistant.get('/catalog', requireAdmin, async (c) => {
  const conn = await getGlobalConnection()
  if (!conn) return c.json({ configured: false, areas: [], domains: [], entities: [] })
  let store = getStore(conn)
  if (!store?.connected) { try { store = await ensureConnected(conn) } catch { /* return what we have */ } }
  const entities = [...(store?.entities.values() ?? [])]
  const domains = [...new Set(entities.map((e) => e.domain))].sort()
  const areas = [...(store?.areas.entries() ?? [])].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  return c.json({
    configured: true,
    areas,
    domains,
    entities: entities
      .map((e) => ({ entity_id: e.entityId, name: e.name, domain: e.domain, area_id: e.areaId, area: e.areaName, state: store?.states.get(e.entityId) ?? null }))
      .sort((a, b) => a.entity_id.localeCompare(b.entity_id)),
  })
})

// ── Per-user (domain × area) grants ───────────────────────────────────────────

adminHomeAssistant.get('/grants', requireAdmin, async (c) => {
  const rows = await db.select().from(haUserGrants)
  const result: Record<string, Grant[]> = {}
  for (const r of rows) {
    (result[r.userId] ??= []).push({ domain: r.domain, areaId: r.areaId })
  }
  return c.json(result)
})

adminHomeAssistant.put('/grants', requireAdmin, async (c) => {
  const { userId, grants } = (await c.req.json()) as { userId: string; grants: Grant[] }
  if (!userId || !Array.isArray(grants)) return c.json({ error: 'userId and grants[] required' }, 400)
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1)
  if (!u) return c.json({ error: 'Unknown user' }, 404)
  await setGrants(userId, grants)
  return c.json({ ok: true })
})

export { adminHomeAssistant }
