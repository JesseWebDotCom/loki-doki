import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { resolveToolConfig } from '@/lib/toolConfig'
import { homeAssistantTool } from '@/tools/homeAssistant'
import { ensureConnected, normalizeConnection } from '@/lib/homeAssistant'
import { callService } from '@/lib/homeAssistant/client'
import { getGrants, filterByGrants } from '@/lib/homeAssistant/permissions'
import type { AppEnv } from '@/types'

const homeAssistantRoute = new Hono<AppEnv>()

const ALLOWED_DOMAINS = new Set([
  'light', 'switch', 'fan', 'lock', 'cover', 'climate', 'input_boolean', 'media_player',
])

homeAssistantRoute.get('/entities', requireAuth, async (c) => {
  const user = c.get('user')
  const config = await resolveToolConfig('homeAssistant', user.id)

  if (!config['base_url']) {
    return c.json({ configured: false })
  }

  const conn = normalizeConnection(config['base_url'], config['api_token'])
  if (!conn) return c.json({ configured: false })

  try {
    const store = await ensureConnected(conn)

    const entities: Array<{
      entity_id: string
      state: string
      friendly_name: string
      domain: string
      area?: string
    }> = []

    for (const [eid, cat] of store.entities) {
      if (!ALLOWED_DOMAINS.has(cat.domain)) continue
      const state = store.states.get(eid) ?? 'unknown'
      entities.push({
        entity_id: eid,
        state,
        friendly_name: cat.name || eid,
        domain: cat.domain,
        ...(cat.areaName ? { area: cat.areaName } : {}),
      })
    }

    return c.json({ configured: true, entities, serverUrl: config['base_url'] as string })
  } catch {
    return c.json({ configured: true, entities: [], error: 'Could not reach Home Assistant.' }, 502)
  }
})

// Direct entity toggle — bypasses NL resolver to reliably target a single entity_id.
homeAssistantRoute.post('/entity', requireAuth, async (c) => {
  const user = c.get('user')
  const body = (await c.req.json()) as { entity_id?: unknown; action?: unknown }
  const entityId = String(body.entity_id ?? '').trim()
  const action = String(body.action ?? '').trim()

  if (!entityId || (action !== 'turn_on' && action !== 'turn_off')) {
    return c.json({ ok: false, error: 'entity_id and action (turn_on|turn_off) required' }, 400)
  }

  const domain = entityId.split('.')[0] ?? ''
  if (!ALLOWED_DOMAINS.has(domain)) {
    return c.json({ ok: false, error: 'domain not allowed' }, 400)
  }

  const config = await resolveToolConfig('homeAssistant', user.id)
  const conn = normalizeConnection(config['base_url'], config['api_token'])
  if (!conn) return c.json({ ok: false, error: 'not configured' }, 400)

  try {
    const store = await ensureConnected(conn)

    if (user.role !== 'admin') {
      // Fail closed: an entity missing from the synced catalog is not grantable,
      // so a non-admin must not be able to control it by passing a raw entity_id.
      const cat = store.entities.get(entityId)
      if (!cat) return c.json({ ok: false, error: 'Not allowed.' }, 403)
      const grants = await getGrants(user.id)
      const { allowed } = filterByGrants([cat], grants, false)
      if (allowed.length === 0) return c.json({ ok: false, error: 'Not allowed.' }, 403)
    }

    const result = await callService(conn, domain, action, { entity_id: entityId })
    return c.json({ ok: result.ok })
  } catch {
    return c.json({ ok: false, error: 'Could not reach Home Assistant.' }, 502)
  }
})

homeAssistantRoute.post('/command', requireAuth, async (c) => {
  const user = c.get('user')
  const body = (await c.req.json()) as { text?: unknown }
  const text = String(body.text ?? '').trim()

  if (!text) {
    return c.json({ ok: false, reply: null, error: 'No command text provided.' }, 400)
  }

  const config = await resolveToolConfig('homeAssistant', user.id)
  const result = await homeAssistantTool.execute({ text }, config)

  return c.json({
    ok: result.success,
    reply: (result as { directReply?: string }).directReply ?? null,
    error: result.error ?? null,
  })
})

export { homeAssistantRoute }
