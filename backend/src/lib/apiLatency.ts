// API responsiveness probe (Phase 2.8): a ring buffer of recent request wall-times
// so "is the web fast?" is measured, not assumed. Interactive API responsiveness is
// the canary for CPU starvation: when inference or a transcode saturates the cores,
// p95 here climbs even though nothing has crashed. Surfaced in Admin > System.
//
// Deliberately tiny: fixed-size ring, integer ms, no per-route breakdown. Streaming
// and websocket routes are excluded by the middleware (their duration is the user's,
// not the server's).

const CAP = 512
const buf = new Float64Array(CAP)
let n = 0      // total recorded
let head = 0   // next write index

export function recordApiLatency(ms: number): void {
  if (!(ms >= 0) || ms > 120_000) return // ignore absurd values (clock skew, hung)
  buf[head] = ms
  head = (head + 1) % CAP
  n++
}

export interface ApiLatencySnapshot {
  count: number   // samples in the window
  p50: number
  p95: number
  p99: number
  max: number
}

export function apiLatencySnapshot(): ApiLatencySnapshot {
  const size = Math.min(n, CAP)
  if (size === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 }
  const sorted = Array.from(buf.subarray(0, size)).sort((a, b) => a - b)
  const at = (q: number) => Math.round(sorted[Math.min(size - 1, Math.floor(q * size))]!)
  return { count: size, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: Math.round(sorted[size - 1]!) }
}
