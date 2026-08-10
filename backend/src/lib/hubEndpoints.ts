// The hub's address book: every URL a client can use to reach this server.
//
// Two sources, merged:
//   - detected   LAN IPv4 addresses and the Tailscale MagicDNS name, refreshed on read
//                (a DHCP lease change or a tailnet reconnect must not strand a client)
//   - managed    rows an admin typed in Admin -> Server -> Addresses, each with its own
//                name and priority
//
// Clients pull the merged list, cache it to disk, and walk it in priority order. That
// cache is what they use on the next cold start, including when the network they are
// on can only reach one of the entries.

import { networkInterfaces } from 'node:os'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { hubEndpoints } from '@/db/schema'
import { getTailscaleStatus } from '@/lib/tailscale'
import { logger } from '@/lib/logger'

export type EndpointKind = 'lan' | 'overlay' | 'public'
export type EndpointSource = 'detected' | 'managed'

export interface HubEndpoint {
  id: string
  name: string
  url: string
  kind: EndpointKind
  priority: number
  enabled: boolean
  source: EndpointSource
}

const port = parseInt(process.env.PORT ?? '3000')

// Detected addresses sort ahead of typed ones by default: on the home network the LAN IP
// is the fastest path and the one least likely to depend on anything else being up. An
// admin who disagrees just gives their own row a lower number.
const DETECTED_LAN_PRIORITY = 10
const DETECTED_TAILNET_PRIORITY = 60

/** Normalize what a human typed into an origin we can compare and store. */
export function normalizeEndpointUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (!url.hostname) return null
  // Keep the origin only: a path would be silently prepended to every API call.
  return url.origin
}

/** Guess where an address works, so the client can skip candidates that cannot
 *  possibly answer on its current network. The admin can override it. */
export function guessEndpointKind(url: string): EndpointKind {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return 'lan'
  }
  if (host.endsWith('.ts.net')) return 'overlay'
  if (host.endsWith('.local') || host === 'localhost') return 'lan'
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(host)) return 'lan'
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return 'overlay'  // CGNAT range Tailscale uses
  if (host.includes('.')) return 'public'
  return 'lan'
}

function detectLanUrls(): string[] {
  const out: string[] = []
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      out.push(`http://${a.address}:${port}`)
    }
  }
  // Private ranges first: on a machine with a VPN or Docker bridge up, the 192.168/10.x
  // address is the one a phone in the house can actually route to.
  return out.sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)))
}

function isPrivate(url: string): boolean {
  return /\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url)
}

async function detectTailnetUrls(): Promise<string[]> {
  try {
    const status = await getTailscaleStatus()
    if (status.state !== 'running') return []
    // MagicDNS name first (stable across reconnects), the tailnet IP as backup.
    const hosts = [status.dnsName, ...status.ips].filter((h): h is string => !!h)
    return hosts.map((h) => `http://${h.includes(':') ? `[${h}]` : h}:${port}`)
  } catch (err) {
    logger.debug(`[hub-endpoints] tailscale probe failed: ${err instanceof Error ? err.message : err}`)
    return []
  }
}

/** Admin-managed rows, in priority order. */
export async function listManagedEndpoints(): Promise<HubEndpoint[]> {
  const rows = await db.select().from(hubEndpoints).orderBy(asc(hubEndpoints.priority))
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    url: r.url,
    kind: r.kind,
    priority: r.priority,
    enabled: r.enabled,
    source: 'managed' as const,
  }))
}

/**
 * The full address book a client should cache: detected plus managed, deduped by URL
 * (a managed row wins, because it carries the name the admin chose) and sorted by
 * priority. Disabled rows are dropped here, not shipped to clients.
 */
export async function listHubEndpoints(opts: { includeDisabled?: boolean } = {}): Promise<HubEndpoint[]> {
  const managed = await listManagedEndpoints()
  const claimed = new Set(managed.map((e) => e.url))

  const detected: HubEndpoint[] = []
  for (const url of detectLanUrls()) {
    if (claimed.has(url)) continue
    claimed.add(url)
    // Every non-internal interface shows up here, including the Tailscale one. Classify
    // by address rather than by "we found it on an interface", or the tailnet IP would
    // be offered to clients as a home-network address and probed first on cellular.
    const kind = guessEndpointKind(url)
    detected.push({
      id: `detected:${url}`,
      name: kind === 'overlay' ? 'Tailscale' : 'This network',
      url,
      kind,
      priority: kind === 'overlay' ? DETECTED_TAILNET_PRIORITY : DETECTED_LAN_PRIORITY,
      enabled: true,
      source: 'detected',
    })
  }
  for (const url of await detectTailnetUrls()) {
    if (claimed.has(url)) continue
    claimed.add(url)
    detected.push({
      id: `detected:${url}`,
      name: 'Tailscale',
      url,
      kind: 'overlay',
      priority: DETECTED_TAILNET_PRIORITY,
      enabled: true,
      source: 'detected',
    })
  }

  const all = [...managed, ...detected]
    .filter((e) => opts.includeDisabled || e.enabled)
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
  return all
}

/** Next free priority, so a newly added row lands at the bottom of the list. */
export async function nextEndpointPriority(): Promise<number> {
  const rows = await db.select({ priority: hubEndpoints.priority }).from(hubEndpoints)
  const max = rows.reduce((m, r) => Math.max(m, r.priority), 0)
  return max + 10
}

/** Reorder: assign 10, 20, 30... in the given id order. Ids not in the list keep
 *  their current priority and simply sort after (they get pushed past the end). */
export async function reorderEndpoints(orderedIds: string[]): Promise<void> {
  const now = new Date()
  let priority = 10
  for (const id of orderedIds) {
    await db.update(hubEndpoints)
      .set({ priority, updatedAt: now })
      .where(eq(hubEndpoints.id, id))
    priority += 10
  }
}
