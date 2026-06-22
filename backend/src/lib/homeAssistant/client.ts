import { logger } from '@/lib/logger'

// Low-level Home Assistant REST client. Every call is logged so resolutions and
// service calls can be debugged locally. We deliberately avoid HA's conversation
// agent here — this talks to the deterministic REST API (states/services/template).

export interface HAConnection {
  baseUrl: string
  token: string
}

export interface HAStateEntity {
  entity_id: string
  state: string
  attributes: Record<string, unknown>
}

const DEFAULT_TIMEOUT = 6000

export function normalizeConnection(baseUrl: unknown, token: unknown): HAConnection | null {
  const b = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  const t = String(token ?? '').trim()
  if (!b || !t) return null
  return { baseUrl: b, token: t }
}

async function haFetch(conn: HAConnection, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${conn.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${conn.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
  })
}

// All entity states in one call.
export async function getStates(conn: HAConnection): Promise<HAStateEntity[]> {
  const t0 = performance.now()
  const res = await haFetch(conn, '/api/states')
  if (!res.ok) throw new HAError(res.status, `GET /api/states → ${res.status}`)
  const data = (await res.json()) as HAStateEntity[]
  logger.info(`[HA] getStates ok count=${data.length} ${(performance.now() - t0).toFixed(0)}ms`)
  return data
}

// State for a specific entity (fast, used for state queries).
export async function getState(conn: HAConnection, entityId: string): Promise<HAStateEntity | null> {
  const res = await haFetch(conn, `/api/states/${encodeURIComponent(entityId)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new HAError(res.status, `GET state ${entityId} → ${res.status}`)
  return (await res.json()) as HAStateEntity
}

// Render a Jinja template server-side — used to pull the area registry, which
// /api/states does not expose. Returns the rendered text.
export async function renderTemplate(conn: HAConnection, template: string): Promise<string> {
  const res = await haFetch(conn, '/api/template', {
    method: 'POST',
    body: JSON.stringify({ template }),
  })
  if (!res.ok) throw new HAError(res.status, `POST /api/template → ${res.status}`)
  return res.text()
}

export interface ServiceCallResult {
  ok: boolean
  status: number
  changed: HAStateEntity[]
}

// Call a service, e.g. callService(conn, 'light', 'turn_off', { entity_id: [...] }).
// HA returns the list of states it changed.
export async function callService(
  conn: HAConnection,
  domain: string,
  service: string,
  data: Record<string, unknown>,
): Promise<ServiceCallResult> {
  const t0 = performance.now()
  const res = await haFetch(conn, `/api/services/${domain}/${service}`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
  const changed = res.ok ? ((await res.json().catch(() => [])) as HAStateEntity[]) : []
  logger.info(`[HA] callService ${domain}.${service} status=${res.status} changed=${changed.length} data=${JSON.stringify(data)} ${(performance.now() - t0).toFixed(0)}ms`)
  return { ok: res.ok, status: res.status, changed }
}

export class HAError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'HAError'
  }
}

// Maps a transport failure to a user-facing reason and whether it's an "offline" condition.
export function describeError(err: unknown): { offline: boolean; message: string } {
  if (err instanceof HAError) {
    if (err.status === 401 || err.status === 403) {
      return { offline: false, message: 'Home Assistant rejected the access token. Check it in Admin → Features → Home Assistant.' }
    }
    return { offline: false, message: `Home Assistant returned ${err.status}.` }
  }
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return { offline: true, message: 'Home Assistant didn’t respond in time.' }
  }
  return { offline: true, message: 'Couldn’t reach Home Assistant.' }
}
