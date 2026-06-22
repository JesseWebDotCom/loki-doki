import { lookup } from 'node:dns/promises'
import net from 'node:net'

/**
 * SSRF guard for any server-side fetch whose URL is influenced by a user.
 *
 * The app runs as a LAN appliance next to Ollama (:11434), ComfyUI (:8188),
 * kiwix/graphhopper sidecars, and the router admin panel. Without this guard,
 * any authenticated user could point a proxied/looked-up fetch at those
 * internal services (or cloud metadata at 169.254.169.254) and read the body.
 *
 * Strategy: validate the scheme, resolve the host, and reject if ANY resolved
 * address is private / loopback / link-local / CGNAT / metadata. Redirects are
 * followed manually so every hop is re-validated. There is an inherent
 * DNS-rebinding TOCTOU window (resolve-then-connect), but for a single-instance
 * LAN app this closes the practical attack surface.
 */

export class SsrfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsrfError'
  }
}

/** True if an IP literal falls in a blocked (non-public) range. */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 0) return true // "this" network
    if (a === 10) return true // private
    if (a === 127) return true // loopback
    if (a === 169 && b === 254) return true // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true // private
    if (a === 192 && b === 168) return true // private
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT (100.64/10)
    if (a >= 224) return true // multicast / reserved
    return false
  }
  if (net.isIPv6(ip)) {
    const g = expandIPv6Groups(ip)
    if (!g) return true // can't expand a supposedly-valid v6 → block
    const v4FromTail = () => `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`
    const topZero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0
    if (g.every((x) => x === 0)) return true // :: unspecified
    if (topZero && g[5] === 0 && g[6] === 0 && g[7] === 1) return true // ::1 loopback
    if ((g[0] & 0xffc0) === 0xfe80) return true // link-local fe80::/10
    if ((g[0] & 0xfe00) === 0xfc00) return true // unique-local fc00::/7
    // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96):
    // recheck the embedded IPv4 so hex/compressed forms can't smuggle an internal addr.
    if (topZero && g[5] === 0xffff) return isBlockedIp(v4FromTail())
    if (topZero && g[5] === 0 && (g[6] !== 0 || g[7] !== 0)) return isBlockedIp(v4FromTail())
    if (g[0] === 0x64 && g[1] === 0xff9b) return isBlockedIp(v4FromTail())
    return false
  }
  return true // unparseable → block
}

/**
 * Expand any valid IPv6 textual form (compressed `::`, hex groups, or an embedded
 * IPv4 tail) into its 8 numeric 16-bit groups. Returns null if it cannot be parsed.
 * Used so range checks operate on canonical values, not one textual spelling.
 */
function expandIPv6Groups(addr: string): number[] | null {
  let ip = addr.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '') // strip brackets + zone id
  if (!net.isIPv6(ip)) return null

  // Convert an embedded IPv4 tail (e.g. ::ffff:127.0.0.1) into two hex groups.
  const v4 = ip.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const b = v4.slice(1).map(Number)
    if (b.some((x) => x > 255)) return null
    const g1 = ((b[0] << 8) | b[1]).toString(16)
    const g2 = ((b[2] << 8) | b[3]).toString(16)
    ip = ip.slice(0, ip.length - v4[0].length) + g1 + ':' + g2
  }

  const halves = ip.split('::')
  if (halves.length > 2) return null
  const left = halves[0].length ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1].length ? halves[1].split(':') : []

  let parts: string[]
  if (halves.length === 2) {
    const missing = 8 - left.length - right.length
    if (missing < 0) return null
    parts = [...left, ...Array(missing).fill('0'), ...right]
  } else {
    parts = left
  }
  if (parts.length !== 8) return null

  const groups = parts.map((h) => parseInt(h || '0', 16))
  if (groups.some((x) => Number.isNaN(x) || x < 0 || x > 0xffff)) return null
  return groups
}

/**
 * Validate that `urlStr` is an http(s) URL whose host resolves only to public
 * addresses. Throws SsrfError otherwise. Returns the parsed URL.
 */
export async function assertPublicUrl(urlStr: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(urlStr)
  } catch {
    throw new SsrfError('Invalid URL')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`Blocked scheme: ${url.protocol}`)
  }

  const host = url.hostname.replace(/^\[|\]$/g, '')

  // Literal IP in the URL: check directly (skips DNS).
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new SsrfError(`Blocked address: ${host}`)
    return url
  }

  let addrs: { address: string }[]
  try {
    addrs = await lookup(host, { all: true })
  } catch {
    throw new SsrfError(`Cannot resolve host: ${host}`)
  }
  if (addrs.length === 0) throw new SsrfError(`Cannot resolve host: ${host}`)
  for (const { address } of addrs) {
    if (isBlockedIp(address)) throw new SsrfError(`Host ${host} resolves to blocked address ${address}`)
  }
  return url
}

/**
 * Drop-in replacement for fetch() when the URL is user-influenced. Validates
 * the destination, follows redirects manually (re-validating each hop), and
 * applies a timeout. Throws SsrfError for blocked destinations.
 */
export async function safeFetch(
  urlStr: string,
  init: RequestInit = {},
  opts: { maxRedirects?: number; timeoutMs?: number } = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 4
  const timeoutMs = opts.timeoutMs ?? 15_000

  let current = urlStr
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(current)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetch(current, { ...init, redirect: 'manual', signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }

    // Manual redirect handling so we re-validate the next host.
    if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
      const location = res.headers.get('location')!
      res.body?.cancel().catch(() => {})
      current = new URL(location, current).toString()
      continue
    }
    return res
  }
  throw new SsrfError('Too many redirects')
}
