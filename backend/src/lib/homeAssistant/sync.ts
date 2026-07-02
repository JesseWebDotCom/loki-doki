import { logger } from '@/lib/logger'
import type { HAConnection } from './client'

// Live Home Assistant sync over the WebSocket API. We hold one persistent socket
// per HA instance, authenticate, pull the area/entity/device registries (so we know
// every entity's room), then `subscribe_entities` to receive a live, push-updated
// state map. This keeps our catalog hot and makes state queries instant + always
// fresh — no polling. Control still goes over REST (see client.ts) for simplicity.
//
// Registries give us accurate rooms: an entity's area is its own area_id, or its
// device's area_id when unset. subscribe_entities does not carry registry info, so
// we refresh the registries periodically and re-derive areas.

export interface CatalogEntity {
  entityId: string
  domain: string
  name: string            // best display name (friendly_name → registry override → id)
  areaId: string | null
  areaName: string | null
  deviceClass: string | null
  category: string | null // entity_category: 'config' | 'diagnostic' | null (null = primary control)
}

export interface HAStore {
  entities: Map<string, CatalogEntity>
  states: Map<string, string>      // entity_id → current state
  attributes: Map<string, Record<string, unknown>>  // entity_id → live attributes
  areas: Map<string, string>       // areaId → area name
  connected: boolean
  lastSyncMs: number | null
  lastError: string | null
}

interface EntityRegEntry { areaId: string | null; deviceId: string | null; name: string | null; category: string | null }

interface Conn {
  conn: HAConnection
  store: HAStore
  ws: WebSocket | null
  msgId: number
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>
  subId: number | null
  onFirstEvent: (() => void) | null
  authResolve: (() => void) | null
  authReject: ((e: unknown) => void) | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  registryTimer: ReturnType<typeof setInterval> | null
  connectPromise: Promise<void> | null
  closedByUs: boolean
  entityReg: Map<string, EntityRegEntry>
  deviceReg: Map<string, string | null>   // deviceId → areaId
}

const conns = new Map<string, Conn>()

// ── State-change pub/sub ──────────────────────────────────────────────────────────
// Subscribers receive (baseUrl, entityId, newState, oldState) on every live diff
// from subscribe_entities. baseUrl identifies the HA instance; subscribers must map
// it to user IDs via their own config lookup (sync.ts doesn't know about users).
type StateChangeFn = (baseUrl: string, entityId: string, newState: string, oldState: string | undefined) => void
const stateListeners: StateChangeFn[] = []
export function onHAStateChange(fn: StateChangeFn): () => void {
  stateListeners.push(fn)
  return () => { const i = stateListeners.indexOf(fn); if (i >= 0) stateListeners.splice(i, 1) }
}

const REGISTRY_REFRESH_MS = 10 * 60 * 1000
const RECONNECT_DELAY_MS = 5000
const INITIAL_TIMEOUT_MS = 10000

function keyOf(conn: HAConnection): string { return conn.baseUrl.toLowerCase() }
function wsUrl(baseUrl: string): string { return baseUrl.replace(/^http/i, 'ws') + '/api/websocket' }

function createConn(conn: HAConnection): Conn {
  return {
    conn,
    store: { entities: new Map(), states: new Map(), attributes: new Map(), areas: new Map(), connected: false, lastSyncMs: null, lastError: null },
    ws: null, msgId: 1, pending: new Map(), subId: null,
    onFirstEvent: null, authResolve: null, authReject: null,
    reconnectTimer: null, registryTimer: null, connectPromise: null, closedByUs: false,
    entityReg: new Map(), deviceReg: new Map(),
  }
}

function nextId(c: Conn): number { return c.msgId++ }
function send(c: Conn, msg: Record<string, unknown>): void { c.ws?.send(JSON.stringify(msg)) }

// Send a command and await its `result` message.
function command(c: Conn, msg: Record<string, unknown>): Promise<unknown> {
  const id = nextId(c)
  return new Promise((resolve, reject) => {
    c.pending.set(id, { resolve, reject })
    send(c, { ...msg, id })
  })
}

// ── Public API ──────────────────────────────────────────────────────────────

// Returns a connected, populated store. Connects + does an initial sync on first
// call for a given HA instance; subsequent calls return the live store instantly.
export async function ensureConnected(conn: HAConnection): Promise<HAStore> {
  const k = keyOf(conn)
  let c = conns.get(k)
  if (c && c.store.connected) return c.store
  if (!c) { c = createConn(conn); conns.set(k, c) }
  // Token may have changed — keep the latest.
  c.conn = conn
  await connectDeduped(c)
  return c.store
}

// Non-blocking store access for hot read paths (the home-page widgets poll their
// endpoints every 30 s): NEVER await the 10 s WebSocket connect. Return the
// last-known store immediately and kick a background (re)connect; only the very
// first call for an instance — when no store exists at all — waits briefly.
export async function ensureConnectedSoft(conn: HAConnection, maxWaitMs = 2500): Promise<HAStore> {
  const k = keyOf(conn)
  const existing = conns.get(k)
  if (existing) {
    existing.conn = conn
    if (!existing.store.connected) void connectDeduped(existing).catch(() => { /* reconnect loop retries */ })
    return existing.store
  }
  const c = createConn(conn)
  conns.set(k, c)
  const attempt = connectDeduped(c).catch(() => { /* store stays disconnected */ })
  await Promise.race([attempt, new Promise((r) => setTimeout(r, maxWaitMs))])
  return c.store
}

// One connect attempt at a time per instance: without this, every request that
// arrives while HA is down starts ANOTHER 10 s WebSocket attempt (connection pile-up).
function connectDeduped(c: Conn): Promise<void> {
  if (!c.connectPromise) {
    c.connectPromise = connect(c).finally(() => { c.connectPromise = null })
  }
  return c.connectPromise
}

export function getStore(conn: HAConnection): HAStore | null {
  return conns.get(keyOf(conn))?.store ?? null
}

// ── Connection lifecycle ──────────────────────────────────────────────────────

function connect(c: Conn): Promise<void> {
  c.closedByUs = false
  c.msgId = 1 // ids are per-connection; without a reset they grow unbounded across reconnects
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const done = (err?: unknown) => {
      if (settled) return
      settled = true
      if (err) reject(err); else resolve()
    }

    let ws: WebSocket
    try { ws = new WebSocket(wsUrl(c.conn.baseUrl)) } catch (e) { done(e); return }
    c.ws = ws

    ws.onmessage = (ev: MessageEvent) => handleMessage(c, String(ev.data))
    ws.onerror = () => { c.store.lastError = 'websocket error' }
    ws.onclose = () => {
      c.store.connected = false
      c.ws = null
      stopRegistryTimer(c)
      // Settle every in-flight command: its reply can never arrive on this socket,
      // and an unsettled promise + its pending entry would leak on every reconnect
      // (and hang any await, e.g. refreshRegistries, forever).
      for (const { reject } of c.pending.values()) reject(new Error('HA socket closed'))
      c.pending.clear()
      if (!c.closedByUs) scheduleReconnect(c)
      done(new Error('socket closed before ready'))
    }

    // Called when HA replies auth_ok — run the initial sync, then resolve.
    c.authResolve = () => {
      initialSync(c)
        .then(() => {
          c.store.connected = true
          c.store.lastError = null
          startRegistryTimer(c)
          logger.info(`[HA-WS] ready entities=${c.store.entities.size} areas=${c.store.areas.size}`)
          done()
        })
        .catch((e) => { c.store.lastError = String(e); done(e) })
    }
    c.authReject = (e) => done(e)

    setTimeout(() => done(new Error('connect timeout')), INITIAL_TIMEOUT_MS)
  })
}

function scheduleReconnect(c: Conn): void {
  if (c.reconnectTimer) return
  c.reconnectTimer = setTimeout(() => {
    c.reconnectTimer = null
    logger.info('[HA-WS] reconnecting…')
    connect(c).catch(() => { /* will retry again on close */ })
  }, RECONNECT_DELAY_MS)
}

function startRegistryTimer(c: Conn): void {
  stopRegistryTimer(c)
  c.registryTimer = setInterval(() => {
    refreshRegistries(c).catch((e) => logger.warn(`[HA-WS] registry refresh failed: ${e}`))
  }, REGISTRY_REFRESH_MS)
}
function stopRegistryTimer(c: Conn): void {
  if (c.registryTimer) { clearInterval(c.registryTimer); c.registryTimer = null }
}

// ── Message handling ──────────────────────────────────────────────────────────

interface HAMessage {
  type?: string
  id?: number
  success?: boolean
  result?: unknown
  error?: { message?: string }
  event?: { a?: Record<string, RawState>; c?: Record<string, EntityDiff>; r?: string[] }
}
interface RawState { s?: string; a?: Record<string, unknown> }
interface EntityDiff { '+'?: RawState; '-'?: { a?: string[] } }

function handleMessage(c: Conn, raw: string): void {
  let msg: HAMessage
  try { msg = JSON.parse(raw) as HAMessage } catch { return }

  switch (msg.type) {
    case 'auth_required':
      send(c, { type: 'auth', access_token: c.conn.token })
      return
    case 'auth_ok':
      logger.info('[HA-WS] authenticated')
      c.authResolve?.()
      return
    case 'auth_invalid':
      c.store.lastError = 'auth invalid'
      logger.warn('[HA-WS] auth invalid — check the access token')
      c.authReject?.(new Error('auth invalid'))
      return
    case 'result': {
      if (msg.id === undefined) return
      const p = c.pending.get(msg.id)
      if (!p) return
      c.pending.delete(msg.id)
      if (msg.success === false) p.reject(new Error(msg.error?.message ?? 'command failed'))
      else p.resolve(msg.result)
      return
    }
    case 'event':
      if (msg.id === c.subId && msg.event) applyEntitiesEvent(c, msg.event)
      return
  }
}

interface AreaRow { area_id: string; name: string }
interface DeviceRow { id: string; area_id: string | null }
interface EntityRow { entity_id: string; area_id: string | null; device_id: string | null; name: string | null; entity_category?: string | null }

async function initialSync(c: Conn): Promise<void> {
  await refreshRegistries(c)

  // Subscribe to live entity states. HA replies with a `result`, then an `event`
  // whose `a` block seeds every entity's state + attributes. We resolve once that
  // first event lands so the catalog is fully populated before returning.
  const firstEvent = new Promise<void>((resolve) => { c.onFirstEvent = resolve })
  c.subId = nextId(c)
  send(c, { id: c.subId, type: 'subscribe_entities' })

  await Promise.race([
    firstEvent,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('no initial state event')), INITIAL_TIMEOUT_MS)),
  ])
}

async function refreshRegistries(c: Conn): Promise<void> {
  const [areas, devices, entities] = await Promise.all([
    command(c, { type: 'config/area_registry/list' }) as Promise<AreaRow[]>,
    command(c, { type: 'config/device_registry/list' }) as Promise<DeviceRow[]>,
    command(c, { type: 'config/entity_registry/list' }) as Promise<EntityRow[]>,
  ])

  c.store.areas.clear()
  for (const a of areas) c.store.areas.set(a.area_id, a.name)

  c.deviceReg.clear()
  for (const d of devices) c.deviceReg.set(d.id, d.area_id ?? null)

  c.entityReg.clear()
  for (const e of entities) {
    c.entityReg.set(e.entity_id, { areaId: e.area_id ?? null, deviceId: e.device_id ?? null, name: e.name ?? null, category: e.entity_category ?? null })
  }

  // Re-derive area/name for entities we already know about.
  for (const eid of c.store.entities.keys()) rederive(c, eid)
  logger.info(`[HA-WS] registries synced areas=${c.store.areas.size} entities=${c.entityReg.size}`)
}

function rederive(c: Conn, eid: string): void {
  const ent = c.store.entities.get(eid)
  if (!ent) return
  const reg = c.entityReg.get(eid)
  const areaId = reg?.areaId ?? (reg?.deviceId ? c.deviceReg.get(reg.deviceId) ?? null : null)
  ent.areaId = areaId
  ent.areaName = areaId ? c.store.areas.get(areaId) ?? null : null
  ent.category = reg?.category ?? null
  // friendly_name is HA's fully-computed display name ("Coffee Maker Switch" —
  // device + entity). The bare registry name ("Switch") is only a last resort
  // when the entity never reported a friendly_name.
  if (ent.name === eid && reg?.name) ent.name = reg.name
}

function applyEntitiesEvent(c: Conn, event: NonNullable<HAMessage['event']>): void {
  if (event.a) {
    for (const [eid, st] of Object.entries(event.a)) upsertEntity(c, eid, st)
    c.store.lastSyncMs = Date.now()
    if (c.onFirstEvent) { c.onFirstEvent(); c.onFirstEvent = null }
  }
  if (event.c) {
    for (const [eid, diff] of Object.entries(event.c)) {
      const plus = diff['+']
      if (plus?.s !== undefined) {
        const oldState = c.store.states.get(eid)
        c.store.states.set(eid, plus.s)
        if (plus.s !== oldState && stateListeners.length > 0) {
          const baseUrl = c.conn.baseUrl
          for (const fn of stateListeners) { try { fn(baseUrl, eid, plus.s, oldState) } catch { /* listener error */ } }
        }
      }
      if (plus?.a) {
        const fn = plus.a['friendly_name']
        const ent = c.store.entities.get(eid)
        if (ent && typeof fn === 'string' && fn) ent.name = fn
        // Merge attribute updates into the live attribute map.
        const attrs = c.store.attributes.get(eid) ?? {}
        Object.assign(attrs, plus.a)
        c.store.attributes.set(eid, attrs)
        const dc = plus.a['device_class']
        if (ent && dc !== undefined) ent.deviceClass = typeof dc === 'string' ? dc : null
      }
      const minus = diff['-']
      if (minus?.a) {
        // Attributes removed (e.g. media_title clearing when playback stops).
        const attrs = c.store.attributes.get(eid)
        if (attrs) for (const key of minus.a) delete attrs[key]
      }
    }
    c.store.lastSyncMs = Date.now()
  }
  if (event.r) {
    for (const eid of event.r) { c.store.entities.delete(eid); c.store.states.delete(eid); c.store.attributes.delete(eid) }
  }
}

function upsertEntity(c: Conn, eid: string, st: RawState): void {
  if (st.s !== undefined) c.store.states.set(eid, st.s)
  const domain = eid.split('.')[0] ?? ''
  const reg = c.entityReg.get(eid)
  const areaId = reg?.areaId ?? (reg?.deviceId ? c.deviceReg.get(reg.deviceId) ?? null : null)
  const areaName = areaId ? c.store.areas.get(areaId) ?? null : null
  const fn = st.a?.['friendly_name']
  // friendly_name is HA's computed "{device} {entity}" display name — prefer it
  // over the bare entity-registry name, which is often just "Switch"/"Light".
  const name = (typeof fn === 'string' && fn ? fn : null) ?? reg?.name ?? eid
  const attrs = st.a ?? {}
  c.store.attributes.set(eid, { ...attrs })
  const dc = attrs['device_class']
  c.store.entities.set(eid, { entityId: eid, domain, name, areaId, areaName, deviceClass: typeof dc === 'string' ? dc : null, category: reg?.category ?? null })
}
