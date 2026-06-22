import { getConnInfo } from 'hono/bun'
import type { Context } from 'hono'

// Global PIN brute-force throttle keyed by client IP. This complements the
// per-profile lockout in auth.ts / privacy.ts: without it, one host could hammer
// every profile in parallel (the per-profile counters don't see each other), and
// PINs are only 4-6 digits. Tracks failures per IP across all profiles and locks
// the IP out for a window once it crosses the threshold.

const WINDOW_MS = 15 * 60_000 // rolling window + lockout duration
const MAX_FAILS = 20 // failed attempts per window before an IP is locked
const MAX_BUCKETS = 5_000 // hard cap so the map can't grow without bound

interface Bucket { fails: number; first: number; lockedUntil: number }
const buckets = new Map<string, Bucket>()

// Only trust X-Forwarded-For when a reverse proxy is actually in front of us.
// On a direct-exposed Bun appliance (the default), an attacker can forge XFF on
// every request to get a fresh throttle bucket each time, defeating the per-IP
// limit. Gate it behind explicit proxy configuration.
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || !!(process.env.APP_ORIGIN ?? process.env.PUBLIC_ORIGIN)

/** Best-effort client IP: the socket address, or the proxy-forwarded one if trusted. */
export function getClientIp(c: Context): string {
  if (TRUST_PROXY) {
    const xff = c.req.header('x-forwarded-for')
    if (xff) return xff.split(',')[0]!.trim()
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Returns a lockout if the IP is currently blocked. Call before verifying a PIN. */
export function pinThrottleCheck(ip: string): { blocked: boolean; retryAfter: number } {
  const now = Date.now()
  const b = buckets.get(ip)
  if (!b) return { blocked: false, retryAfter: 0 }
  if (b.lockedUntil > now) return { blocked: true, retryAfter: Math.ceil((b.lockedUntil - now) / 1000) }
  if (now - b.first > WINDOW_MS) buckets.delete(ip) // window elapsed, reset
  return { blocked: false, retryAfter: 0 }
}

/** Record a failed PIN attempt from this IP. */
export function pinThrottleFail(ip: string): void {
  const now = Date.now()
  let b = buckets.get(ip)
  if (!b || now - b.first > WINDOW_MS) {
    b = { fails: 0, first: now, lockedUntil: 0 }
    // Opportunistically evict expired buckets if we're at the cap.
    if (buckets.size >= MAX_BUCKETS) {
      for (const [k, v] of buckets) if (v.lockedUntil <= now && now - v.first > WINDOW_MS) buckets.delete(k)
    }
    buckets.set(ip, b)
  }
  b.fails++
  if (b.fails >= MAX_FAILS) b.lockedUntil = now + WINDOW_MS
}

/** Clear an IP's failure record after a successful auth. */
export function pinThrottleReset(ip: string): void {
  buckets.delete(ip)
}
