// The opt-in DNS filtering server. Listens on UDP :53 (configurable), decides per
// query whether to block (based on the requesting device's profile + enabled
// blocklists + custom rules) and otherwise forwards to an upstream resolver,
// relaying the answer back to the client.
//
// This is deliberately fail-safe: if the server can't bind :53 (needs privilege)
// or an upstream is unreachable, DNS for the house must not break — the admin UI
// surfaces the bind error and the feature simply stays off. Nothing here runs
// unless the admin explicitly enables it.

import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { dnsDevices, dnsRules } from '@/db/schema'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { logger } from '@/lib/logger'
import { buildBlockedResponse, parseQuery } from './protocol'
import { BLOCKLIST_CATEGORIES, invalidateBlocklists, loadBlocklist, matchesDomain } from './blocklist'

export interface DnsConfig {
  enabled: boolean
  port: number
  upstreams: string[] // IPv4 resolver addresses
  categories: string[] // enabled blocklist category ids
  kidsCategories: string[] // extra categories applied to the 'kids' profile
}

export const DEFAULT_DNS_CONFIG: DnsConfig = {
  enabled: false,
  port: 53,
  upstreams: ['1.1.1.1', '9.9.9.9'],
  categories: ['ads-trackers'],
  kidsCategories: ['ads-trackers', 'adult'],
}

const CONFIG_KEY = 'dns.config'

export async function getDnsConfig(): Promise<DnsConfig> {
  const stored = (await getAppSetting(CONFIG_KEY)) as Partial<DnsConfig> | null
  return { ...DEFAULT_DNS_CONFIG, ...(stored ?? {}) }
}

export async function setDnsConfig(cfg: DnsConfig): Promise<void> {
  await setAppSetting(CONFIG_KEY, cfg)
}

// ── Runtime state ───────────────────────────────────────────────────────────

interface ServerState {
  socket: Awaited<ReturnType<typeof Bun.udpSocket>> | null
  bindError: string | null
  // Enabled block sets by profile, rebuilt on (re)start.
  blockSets: Map<string, Set<string>>
  allow: Set<string> // domains always allowed (custom allow rules)
  deny: Set<string> // domains always denied (custom deny rules)
  // Query counters flushed to the DB periodically instead of a write per query.
  pending: Map<string, { label: string; queries: number; blocked: number; lastSeen: number }>
}

const state: ServerState = {
  socket: null,
  bindError: null,
  blockSets: new Map(),
  allow: new Set(),
  deny: new Set(),
  pending: new Map(),
}

export function isDnsRunning(): boolean {
  return state.socket != null
}

export function dnsBindError(): string | null {
  return state.bindError
}

async function rebuildSets(cfg: DnsConfig): Promise<void> {
  const known = new Set(BLOCKLIST_CATEGORIES.map((c) => c.id))
  const build = async (ids: string[]) => {
    const merged = new Set<string>()
    for (const id of ids) {
      if (!known.has(id)) continue
      for (const d of await loadBlocklist(id)) merged.add(d)
    }
    return merged
  }
  state.blockSets.set('default', await build(cfg.categories))
  state.blockSets.set('kids', await build(cfg.kidsCategories))
  state.blockSets.set('unfiltered', new Set())

  const rules = await db.select().from(dnsRules)
  state.allow = new Set(rules.filter((r) => r.action === 'allow').map((r) => r.domain.toLowerCase()))
  state.deny = new Set(rules.filter((r) => r.action === 'deny').map((r) => r.domain.toLowerCase()))
}

// device ip -> profile, cached; refreshed on the flush tick.
let deviceProfiles = new Map<string, string>()

async function refreshDeviceProfiles(): Promise<void> {
  const rows = await db.select({ ip: dnsDevices.ip, profile: dnsDevices.profile }).from(dnsDevices)
  deviceProfiles = new Map(rows.map((r) => [r.ip, r.profile]))
}

function decide(name: string, profile: string): boolean {
  if (state.allow.has(name)) return false
  if (matchesDomain(state.deny, name)) return true
  const set = state.blockSets.get(profile) ?? state.blockSets.get('default')
  return set ? matchesDomain(set, name) : false
}

function recordQuery(ip: string, blocked: boolean): void {
  const entry = state.pending.get(ip) ?? { label: ip, queries: 0, blocked: 0, lastSeen: 0 }
  entry.queries += 1
  if (blocked) entry.blocked += 1
  entry.lastSeen = Date.now()
  state.pending.set(ip, entry)
}

/** Forward a query to the first responsive upstream and return its answer. */
async function forward(query: Uint8Array, upstreams: string[]): Promise<Uint8Array | null> {
  for (const upstream of upstreams) {
    try {
      const answer = await queryUpstream(query, upstream)
      if (answer) return answer
    } catch { /* try the next upstream */ }
  }
  return null
}

function queryUpstream(query: Uint8Array, upstream: string): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (v: Uint8Array | null) => { if (!settled) { settled = true; try { sock?.close() } catch { /* */ }; resolve(v) } }
    let sock: Awaited<ReturnType<typeof Bun.udpSocket>> | null = null
    Bun.udpSocket({
      socket: {
        data(_s, data) { finish(data instanceof Uint8Array ? data : new Uint8Array(data)) },
        error() { finish(null) },
      },
    }).then((s) => {
      sock = s
      s.send(query, 53, upstream)
      setTimeout(() => finish(null), 4000)
    }).catch(() => finish(null))
  })
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

let flushTimer: ReturnType<typeof setInterval> | null = null

export async function startDnsServer(): Promise<{ ok: boolean; error?: string }> {
  const cfg = await getDnsConfig()
  if (!cfg.enabled) return { ok: false, error: 'DNS filtering is disabled.' }
  if (state.socket) return { ok: true }

  await rebuildSets(cfg)
  await refreshDeviceProfiles()
  state.bindError = null

  try {
    state.socket = await Bun.udpSocket({
      port: cfg.port,
      socket: {
        data(sock, data, port, addr) {
          const buf = data instanceof Uint8Array ? data : new Uint8Array(data)
          void handlePacket(sock, buf, port, addr, cfg.upstreams)
        },
      },
    })
  } catch (err) {
    state.bindError = err instanceof Error ? err.message : String(err)
    state.socket = null
    logger.warn(`[dns] could not bind :${cfg.port}: ${state.bindError}`)
    return { ok: false, error: state.bindError }
  }

  flushTimer = setInterval(() => { void flush() }, 15_000)
  logger.info(`[dns] filtering server listening on :${cfg.port}`)
  return { ok: true }
}

async function handlePacket(
  sock: NonNullable<ServerState['socket']>,
  buf: Uint8Array,
  port: number,
  addr: string,
  upstreams: string[],
): Promise<void> {
  const parsed = parseQuery(buf)
  if (!parsed) {
    // Unparseable / no question: forward blindly so odd clients still resolve.
    const answer = await forward(buf, upstreams)
    if (answer) try { sock.send(answer, port, addr) } catch { /* client gone */ }
    return
  }
  const profile = deviceProfiles.get(addr) ?? 'default'
  const blocked = decide(parsed.name, profile)
  recordQuery(addr, blocked)

  if (blocked) {
    try { sock.send(buildBlockedResponse(buf, parsed), port, addr) } catch { /* client gone */ }
    return
  }
  const answer = await forward(buf, upstreams)
  if (answer) try { sock.send(answer, port, addr) } catch { /* client gone */ }
}

/** Persist counters + auto-register newly seen devices. */
async function flush(): Promise<void> {
  if (state.pending.size === 0) return
  const batch = [...state.pending.entries()]
  state.pending.clear()
  const now = new Date()
  for (const [ip, entry] of batch) {
    try {
      await db.insert(dnsDevices)
        .values({ ip, label: entry.label, profile: 'default', lastSeenAt: now, queries: entry.queries, blocked: entry.blocked, createdAt: now })
        .onConflictDoUpdate({
          target: dnsDevices.ip,
          set: {
            lastSeenAt: now,
            queries: sql`${dnsDevices.queries} + ${entry.queries}`,
            blocked: sql`${dnsDevices.blocked} + ${entry.blocked}`,
          },
        })
    } catch { /* a device row write failing must not stop the others */ }
  }
  await refreshDeviceProfiles().catch(() => {})
}

export async function stopDnsServer(): Promise<void> {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null }
  await flush().catch(() => {})
  try { state.socket?.close() } catch { /* already closed */ }
  state.socket = null
}

/** Apply a config or rule change: reload sets and (re)start or stop as needed. */
export async function reloadDns(): Promise<{ ok: boolean; error?: string }> {
  invalidateBlocklists()
  await stopDnsServer()
  const cfg = await getDnsConfig()
  if (!cfg.enabled) return { ok: true }
  return startDnsServer()
}
