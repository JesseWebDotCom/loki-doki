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
  name: string            // best display name (registry override → friendly_name → id)
  areaId: string | null
  areaName: string | null
}

export interface HAStore {
  entities: Map<string, CatalogEntity>
  states: Map<string, string>      // entity_id → current state
  areas: Map<string, string>       // areaId → area name
  connected: boolean
  lastSyncMs: number | null
  lastError: string | null
}

interface EntityRegEntry { areaId: string | null; deviceId: string | null; name: string | null }

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
  closedByUs: boolean
  entityReg: Map<string, EntityRegEntry>
  deviceReg: Map<string, string | null>   // deviceId → areaId
}

const conns = new Map<string, Conn>()

const REGISTRY_REFRESH_MS = 10 * 60 * 1000
const RECONNECT_DELAY_MS = 5000
const INITIAL_TIMEOUT_MS = 10000

function keyOf(conn: HAConnection): string { return conn.baseUrl.toLowerCase() }
function wsUrl(baseUrl: string): string { return baseUrl.replace(/^http/i, 'ws') + '/api/websocket' }

function createConn(conn: HAConnection): Conn {
  return {
    conn,
    store: { entities: new Map(), states: new Map(), areas: new Map(), connected: false, lastSyncMs: null, lastError: null },
    ws: null, msgId: 1, pending: new Map(), subId: null,
    onFirstEvent: null, authResolve: null, authReject: null,
    reconnectTimer: null, registryTimer: null, closedByUs: false,
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
  await connect(c)
  return c.store
}

export function getStore(conn: HAConnection): HAStore | null {
  return conns.get(keyOf(conn))?.store ?? null
}

// ── Connection lifecycle ──────────────────────────────────────────────────────

function connect(c: Conn): Promise<void> {
  c.closedByUs = false
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
  event?: { a?: Record<string, RawState>; c?: Record<string, { '+'?: RawState }>; r?: string[] }
}
interface RawState { s?: string; a?: Record<string, unknown> }

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
interface EntityRow { entity_id: string; area_id: string | null; device_id: string | null; name: string | null }

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
    c.entityReg.set(e.entity_id, { areaId: e.area_id ?? null, deviceId: e.device_id ?? null, name: e.name ?? null })
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
  if (reg?.name) ent.name = reg.name
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
      if (plus?.s !== undefined) c.store.states.set(eid, plus.s)
      if (plus?.a) {
        const fn = plus.a['friendly_name']
        const ent = c.store.entities.get(eid)
        if (ent && typeof fn === 'string' && !c.entityReg.get(eid)?.name) ent.name = fn
      }
    }
    c.store.lastSyncMs = Date.now()
  }
  if (event.r) {
    for (const eid of event.r) { c.store.entities.delete(eid); c.store.states.delete(eid) }
  }
}

function upsertEntity(c: Conn, eid: string, st: RawState): void {
  if (st.s !== undefined) c.store.states.set(eid, st.s)
  const domain = eid.split('.')[0] ?? ''
  const reg = c.entityReg.get(eid)
  const areaId = reg?.areaId ?? (reg?.deviceId ? c.deviceReg.get(reg.deviceId) ?? null : null)
  const areaName = areaId ? c.store.areas.get(areaId) ?? null : null
  const fn = st.a?.['friendly_name']
  const name = reg?.name ?? (typeof fn === 'string' ? fn : eid)
  c.store.entities.set(eid, { entityId: eid, domain, name, areaId, areaName })
}
