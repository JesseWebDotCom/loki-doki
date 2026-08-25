import os from 'node:os'
import { getConnInfo } from 'hono/bun'
import type { Context } from 'hono'

// "Same machine" detection for voice arbitration: web tabs yield companion voice to the
// MaiPai Desktop desktop app only when both are connected from the same computer. IPs are the
// only signal the server has, so this is deliberately best-effort — a mismatch just means
// a tab keeps its voice (never the other way around: over-matching would silence tabs on
// other machines, so equivalence rules stay narrow).

const TRUST_PROXY = process.env.TRUST_PROXY === '1' || !!(process.env.APP_ORIGIN ?? process.env.PUBLIC_ORIGIN)

/** Canonicalize an IP for comparison: strip IPv4-mapped prefix, lowercase, fold loopbacks. */
export function normalizeIp(ip: string | undefined | null): string {
  if (!ip) return 'unknown'
  let v = ip.trim().toLowerCase()
  if (v.startsWith('::ffff:')) v = v.slice(7)
  // Fold every loopback spelling (::1, 127.x.x.x) to one token.
  if (v === '::1' || v.startsWith('127.')) return 'loopback'
  return v
}

export function isLoopback(ip: string): boolean {
  return normalizeIp(ip) === 'loopback'
}

/** IP used for same-machine arbitration. Unlike pinThrottle's stricter getClientIp, this
 *  also trusts X-Forwarded-For when the socket peer is loopback: a loopback peer is by
 *  definition a local process (the Vite dev proxy), so honoring its XFF can't be abused
 *  remotely and is what makes dev-mode arbitration see real client IPs. */
export function getArbitrationIp(c: Context): string {
  let socketIp = 'unknown'
  try {
    socketIp = normalizeIp(getConnInfo(c).remote.address)
  } catch {
    /* keep 'unknown' */
  }
  if (TRUST_PROXY || socketIp === 'loopback') {
    const xff = c.req.header('x-forwarded-for')
    if (xff) return normalizeIp(xff.split(',')[0])
  }
  return socketIp
}

// A client that connects via `localhost` (the dock pointed at the server machine) and one
// that connects via the machine's LAN IP are the same computer when that LAN IP belongs to
// the server itself. Cache the interface list — it's read on every arbitration recompute.
let ifaceCache: { addrs: Set<string>; at: number } | null = null
function serverInterfaceAddrs(): Set<string> {
  const now = Date.now()
  if (ifaceCache && now - ifaceCache.at < 60_000) return ifaceCache.addrs
  const addrs = new Set<string>()
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const iface of list ?? []) addrs.add(normalizeIp(iface.address))
    }
  } catch {
    /* leave empty */
  }
  ifaceCache = { addrs, at: now }
  return addrs
}

/** True when two (already-arbitration-derived) IPs plausibly belong to one machine. */
export function isSameMachine(a: string, b: string): boolean {
  const na = normalizeIp(a)
  const nb = normalizeIp(b)
  if (na === 'unknown' || nb === 'unknown') return false
  if (na === nb) return true
  // Loopback on one side matches the server's own interface addresses on the other.
  if (na === 'loopback') return serverInterfaceAddrs().has(nb)
  if (nb === 'loopback') return serverInterfaceAddrs().has(na)
  return false
}
