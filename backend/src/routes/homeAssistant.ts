import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { resolveToolConfig } from '@/lib/toolConfig'
import { homeAssistantTool } from '@/tools/homeAssistant'
import { ensureConnected, ensureConnectedSoft, normalizeConnection, type CatalogEntity, type HAStore } from '@/lib/homeAssistant'
import { callService } from '@/lib/homeAssistant/client'
import { getGrants, filterByGrants } from '@/lib/homeAssistant/permissions'
import { ACTIONS_BY_DOMAIN, serviceCallsFor, clampPct } from '@/lib/homeAssistant/actions'
import { isSecurityEntity } from '@/lib/homeAssistant/security'
import type { HAAction } from '@/lib/homeAssistant/resolve'
import type { AppEnv } from '@/types'

const homeAssistantRoute = new Hono<AppEnv>()

const ALLOWED_DOMAINS = new Set([
  'light', 'switch', 'fan', 'lock', 'cover', 'climate', 'input_boolean', 'media_player',
])

// Per-domain attribute whitelist sent to the frontend — enough for rich cards and
// the detail sheet without dumping every HA attribute over the wire.
function pickAttrs(domain: string, attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const take = (keys: string[]) => { for (const k of keys) if (attrs[k] !== undefined) out[k] = attrs[k] }
  // The entity's own mdi icon (integration- or user-set) — any domain.
  take(['icon'])
  switch (domain) {
    case 'climate':
      take(['current_temperature', 'current_humidity', 'temperature', 'hvac_modes', 'hvac_action', 'min_temp', 'max_temp'])
      break
    case 'media_player':
      take(['media_title', 'media_artist', 'volume_level', 'is_volume_muted', 'entity_picture'])
      break
    case 'light': {
      const b = attrs['brightness']
      if (typeof b === 'number') out['brightness_pct'] = Math.round((b / 255) * 100)
      break
    }
    case 'cover':
      take(['current_position', 'device_class'])
      break
    case 'fan':
      take(['percentage'])
      break
  }
  return out
}

// Entities visible to this user: the synced catalog filtered to app-relevant
// domains, minus config/diagnostic entities (child locks, LED indicators — HA's
// own dashboards hide these too), and — for non-admins — filtered to their
// grants (security entities require an explicit 'security' grant).
async function visibleEntities(store: HAStore, userId: string, isAdmin: boolean): Promise<CatalogEntity[]> {
  const all = [...store.entities.values()].filter(e => ALLOWED_DOMAINS.has(e.domain) && e.category === null)
  if (isAdmin) return all
  const grants = await getGrants(userId)
  return filterByGrants(all, grants, false).allowed
}

homeAssistantRoute.get('/entities', requireAuth, async (c) => {
  const user = c.get('user')
  const config = await resolveToolConfig('homeAssistant', user.id)

  if (!config['base_url']) {
    return c.json({ configured: false })
  }

  const conn = normalizeConnection(config['base_url'], config['api_token'])
  if (!conn) return c.json({ configured: false })

  try {
    // Soft: serve the last-known store instantly and reconnect in the background.
    // Awaiting a full connect here hangs the home-page widget ~10 s whenever HA is
    // configured but unreachable. A store that has never synced → quick 502 below.
    const store = await ensureConnectedSoft(conn)
    if (!store.connected && store.lastSyncMs === null) {
      return c.json({ configured: true, entities: [], error: 'Could not reach Home Assistant.' }, 502)
    }
    const visible = await visibleEntities(store, user.id, user.role === 'admin')

    const entities = visible.map(cat => {
      const eid = cat.entityId
      return {
        entity_id: eid,
        state: store.states.get(eid) ?? 'unknown',
        friendly_name: cat.name || eid,
        domain: cat.domain,
        device_class: cat.deviceClass,
        security: isSecurityEntity(cat),
        attributes: pickAttrs(cat.domain, store.attributes.get(eid) ?? {}),
        ...(cat.areaName ? { area: cat.areaName } : {}),
      }
    })

    return c.json({ configured: true, entities, serverUrl: config['base_url'] as string })
  } catch {
    return c.json({ configured: true, entities: [], error: 'Could not reach Home Assistant.' }, 502)
  }
})

// Live status counts for the home-page widget, computed from the in-memory store
// (no HA round-trip) and scoped to the requesting user's grants.
homeAssistantRoute.get('/summary', requireAuth, async (c) => {
  const user = c.get('user')
  const config = await resolveToolConfig('homeAssistant', user.id)
  const conn = normalizeConnection(config['base_url'], config['api_token'])
  if (!conn) return c.json({ configured: false })

  try {
    // Soft path — same reasoning as /entities above; never block the widget on a connect.
    const store = await ensureConnectedSoft(conn)
    if (!store.connected && store.lastSyncMs === null) {
      return c.json({ configured: true, error: 'Could not reach Home Assistant.' }, 502)
    }
    const visible = await visibleEntities(store, user.id, user.role === 'admin')
    const stateOf = (e: CatalogEntity) => store.states.get(e.entityId) ?? 'unknown'

    const lightsOn = visible.filter(e => e.domain === 'light' && stateOf(e) === 'on').length
    // Lights have their own count — "devices" is switches + fans.
    const devicesOn = visible.filter(e => ['switch', 'fan'].includes(e.domain) && stateOf(e) === 'on').length

    const mediaPlaying = visible
      .filter(e => e.domain === 'media_player' && stateOf(e) === 'playing')
      .map(e => {
        const attrs = store.attributes.get(e.entityId) ?? {}
        return {
          entity_id: e.entityId,
          name: e.name,
          title: typeof attrs['media_title'] === 'string' ? attrs['media_title'] : null,
          artist: typeof attrs['media_artist'] === 'string' ? attrs['media_artist'] : null,
        }
      })

    const securityOpen = visible
      .filter(e => isSecurityEntity(e) && ['unlocked', 'open', 'opening'].includes(stateOf(e)))
      .map(e => ({ entity_id: e.entityId, name: e.name, state: stateOf(e), kind: e.domain === 'lock' ? 'lock' : 'door' }))

    return c.json({
      configured: true,
      counts: { lightsOn, devicesOn, mediaPlaying: mediaPlaying.length, securityOpen: securityOpen.length },
      mediaPlaying,
      securityOpen,
      // Whether this user can see any security entities at all (drives widget copy).
      hasEntities: visible.length > 0,
    })
  } catch {
    return c.json({ configured: true, error: 'Could not reach Home Assistant.' }, 502)
  }
})

// Proxy for HA-hosted images (media_player entity_picture / camera stills):
// those URLs live on the LAN HA server, often behind its auth, so the browser
// can't load them directly. Only HA's own image paths are allowed — no open
// proxying (external artwork URLs go through the generic /api/img instead).
homeAssistantRoute.get('/img', requireAuth, async (c) => {
  const path = c.req.query('path') ?? ''
  if (!/^\/(api|local)\//.test(path) || path.includes('..')) {
    return c.json({ ok: false, error: 'bad path' }, 400)
  }

  const user = c.get('user')
  const config = await resolveToolConfig('homeAssistant', user.id)
  const conn = normalizeConnection(config['base_url'], config['api_token'])
  if (!conn) return c.json({ ok: false, error: 'not configured' }, 400)

  try {
    const r = await fetch(`${conn.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${conn.token}` },
      signal: AbortSignal.timeout(6000),
    })
    if (!r.ok || !r.body) return c.json({ ok: false }, 404)
    return new Response(r.body, {
      headers: {
        'Content-Type': r.headers.get('content-type') ?? 'image/jpeg',
        'Cache-Control': 'private, max-age=30',
      },
    })
  } catch {
    return c.json({ ok: false, error: 'Could not reach Home Assistant.' }, 502)
  }
})

// Bulk control for the "all off" stat chips — one grouped HA service call per
// action instead of N round-trips. Deliberately limited to SAFE directions
// (off/close/lock/pause): opening or unlocking anything in bulk is never allowed,
// so this endpoint can't be used to skip the per-device unlock confirmation.
const BULK_ACTIONS = new Set<HAAction>(['turn_off', 'close', 'lock', 'media_pause'])

homeAssistantRoute.post('/bulk', requireAuth, async (c) => {
  const user = c.get('user')
  const body = (await c.req.json()) as { entity_ids?: unknown; action?: unknown }
  const ids = Array.isArray(body.entity_ids)
    ? body.entity_ids.map((v) => String(v).trim()).filter(Boolean).slice(0, 200)
    : []
  const action = String(body.action ?? '').trim() as HAAction

  if (ids.length === 0 || !BULK_ACTIONS.has(action)) {
    return c.json({ ok: false, error: 'entity_ids and a bulk-safe action (turn_off|close|lock|media_pause) required' }, 400)
  }

  const config = await resolveToolConfig('homeAssistant', user.id)
  const conn = normalizeConnection(config['base_url'], config['api_token'])
  if (!conn) return c.json({ ok: false, error: 'not configured' }, 400)

  try {
    const store = await ensureConnected(conn)

    // Fail closed: unknown ids are dropped, the action must fit each entity's
    // domain, and non-admins are filtered to their grants.
    let cats = ids
      .map((id) => store.entities.get(id))
      .filter((cat): cat is CatalogEntity => !!cat && ALLOWED_DOMAINS.has(cat.domain))
      .filter((cat) => ACTIONS_BY_DOMAIN[cat.domain]?.includes(action))
    if (user.role !== 'admin') {
      const grants = await getGrants(user.id)
      cats = filterByGrants(cats, grants, false).allowed
    }
    if (cats.length === 0) return c.json({ ok: false, error: 'Not allowed.' }, 403)

    let ok = true
    for (const call of serviceCallsFor(action, cats.map((cat) => cat.entityId))) {
      const r = await callService(conn, call.domain, call.service, call.data)
      ok = ok && r.ok
    }
    return c.json({ ok, affected: cats.length, skipped: ids.length - cats.length })
  } catch {
    return c.json({ ok: false, error: 'Could not reach Home Assistant.' }, 502)
  }
})

// Direct entity control — bypasses the NL resolver to reliably target a single
// entity_id. Validates the action against the entity's domain and clamps values.
homeAssistantRoute.post('/entity', requireAuth, async (c) => {
  const user = c.get('user')
  const body = (await c.req.json()) as { entity_id?: unknown; action?: unknown; value?: unknown }
  const entityId = String(body.entity_id ?? '').trim()
  const action = String(body.action ?? '').trim() as HAAction
  const rawValue = body.value

  if (!entityId || !action) {
    return c.json({ ok: false, error: 'entity_id and action required' }, 400)
  }

  const domain = entityId.split('.')[0] ?? ''
  const domainActions = ACTIONS_BY_DOMAIN[domain]
  if (!ALLOWED_DOMAINS.has(domain) || !domainActions) {
    return c.json({ ok: false, error: 'domain not allowed' }, 400)
  }
  if (!domainActions.includes(action)) {
    return c.json({ ok: false, error: `action not supported for ${domain}` }, 400)
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

    const attrs = store.attributes.get(entityId) ?? {}
    const num = typeof rawValue === 'number' && Number.isFinite(rawValue) ? rawValue : undefined

    const opts: { brightnessPct?: number; value?: number; hvacMode?: string; kelvin?: number; colorName?: string } = {}
    if (action === 'set_brightness') {
      if (num === undefined) return c.json({ ok: false, error: 'value required' }, 400)
      opts.brightnessPct = clampPct(num)
    } else if (action === 'set_volume' || action === 'set_position' || action === 'set_percentage') {
      if (num === undefined) return c.json({ ok: false, error: 'value required' }, 400)
      opts.value = clampPct(num)
    } else if (action === 'set_color_temp') {
      if (num === undefined) return c.json({ ok: false, error: 'value required' }, 400)
      opts.kelvin = Math.min(6500, Math.max(2000, Math.round(num)))
    } else if (action === 'set_color') {
      const name = String(rawValue ?? '').trim()
      if (!name) return c.json({ ok: false, error: 'value required' }, 400)
      opts.colorName = name
    } else if (action === 'set_temperature') {
      if (num === undefined) return c.json({ ok: false, error: 'value required' }, 400)
      const min = typeof attrs['min_temp'] === 'number' ? attrs['min_temp'] : 40
      const max = typeof attrs['max_temp'] === 'number' ? attrs['max_temp'] : 95
      opts.value = Math.min(max, Math.max(min, Math.round(num)))
    } else if (action === 'set_hvac_mode') {
      const mode = String(rawValue ?? '').trim()
      const modes = Array.isArray(attrs['hvac_modes']) ? (attrs['hvac_modes'] as unknown[]).map(String) : []
      if (!mode || (modes.length > 0 && !modes.includes(mode))) {
        return c.json({ ok: false, error: 'invalid hvac mode' }, 400)
      }
      opts.hvacMode = mode
    }

    let ok = true
    for (const call of serviceCallsFor(action, [entityId], opts)) {
      const r = await callService(conn, call.domain, call.service, call.data)
      ok = ok && r.ok
    }
    return c.json({ ok })
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
  // The tool reads its permission context from the config blob (the companion
  // path injects these in buildToolConfig) — without them getGrants('') denies
  // everything, including admins.
  config['_userId'] = user.id
  config['_isAdmin'] = user.role === 'admin'
  // Stable per-user conversation key so the security-confirmation flow (unlock →
  // "Just to confirm…?" → "yes") works across sequential REST calls too.
  config['_conversationId'] = 'rest'
  const result = await homeAssistantTool.execute({ text }, config)

  return c.json({
    ok: result.success,
    reply: (result as { directReply?: string }).directReply ?? null,
    error: result.error ?? null,
  })
})

export { homeAssistantRoute }
