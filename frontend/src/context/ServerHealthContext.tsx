import { createContext, useContext, useEffect, useRef, useState } from 'react'

// App-wide backend reachability. A single poller hits the cheap /api/health probe and
// shares the result, so any component can react to "the backend is down" instead of
// each screen hanging on its own failed requests. Polls lazily when healthy, quickly
// when down (to recover fast), and immediately on tab refocus / network return.

interface ServerHealth {
  /** False once the backend has missed two consecutive probes AND nothing else has
   *  reported contact recently. */
  reachable: boolean
  /** Force an immediate re-check (e.g. after a user-triggered action fails). */
  recheck: () => void
  /** Proof of life from real traffic (an SSE event, a successful fetch). Keeps the
   *  banner away when the dedicated probe is starved by long-lived connections. */
  reportAlive: () => void
}

const ServerHealthCtx = createContext<ServerHealth>({ reachable: true, recheck: () => {}, reportAlive: () => {} })

export function useServerHealth(): ServerHealth {
  return useContext(ServerHealthCtx)
}

const HEALTHY_INTERVAL_MS = 20_000
const DOWN_INTERVAL_MS     = 4_000
const PROBE_TIMEOUT_MS     = 4_000
const ALIVE_GRACE_MS       = 12_000  // recent real traffic suppresses a starved probe

export function ServerHealthProvider({ children }: { children: React.ReactNode }) {
  const [reachable, setReachable] = useState(true)
  const reachableRef = useRef(true)
  const failsRef     = useRef(0)
  const lastAliveRef = useRef(0)   // epoch ms of last confirmed contact (probe or traffic)
  const timerRef     = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Called from anywhere real traffic confirms the backend is up (an SSE event, a 2xx
  // fetch). The dedicated probe can be starved when many long-lived SSE connections are
  // open (browser per-host connection cap), so traffic is the more reliable signal.
  const markAlive = (now: number) => {
    lastAliveRef.current = now
    failsRef.current = 0
    if (!reachableRef.current) { reachableRef.current = true; setReachable(true) }
  }
  const reportAlive = () => markAlive(Date.now())

  useEffect(() => {
    let cancelled = false

    const clearTimer = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null } }
    const schedule   = (ms: number) => { clearTimer(); if (!cancelled) timerRef.current = setTimeout(check, ms) }

    async function check() {
      let ok = false
      try {
        const r = await fetch('/api/health', { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: 'no-store' })
        ok = r.ok
      } catch { ok = false }
      if (cancelled) return

      if (ok) {
        markAlive(Date.now())
      } else {
        failsRef.current += 1
        // Declare down only after two consecutive misses AND no real traffic has
        // confirmed the backend within the grace window. This stops the banner from
        // flashing when the probe is merely starved behind active download streams.
        const quiet = Date.now() - lastAliveRef.current > ALIVE_GRACE_MS
        if (failsRef.current >= 2 && quiet && reachableRef.current) { reachableRef.current = false; setReachable(false) }
      }
      // Probe fast the moment anything looks off (a pending failure or confirmed down)
      // so detection takes ~one extra probe, not a full healthy interval.
      const settled = reachableRef.current && failsRef.current === 0
      schedule(settled ? HEALTHY_INTERVAL_MS : DOWN_INTERVAL_MS)
    }

    const wake = () => { if (!cancelled) check() }
    const onVisible = () => { if (document.visibilityState === 'visible') wake() }

    check()
    window.addEventListener('online', wake)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearTimer()
      window.removeEventListener('online', wake)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const recheck = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    // The interval closure owns `check`; the simplest cross-call trigger is to reset
    // the fail counter low and let the next scheduled probe run — but for immediacy we
    // dispatch the same 'online' path the poller already listens to.
    window.dispatchEvent(new Event('online'))
  }

  return (
    <ServerHealthCtx.Provider value={{ reachable, recheck, reportAlive }}>
      {children}
    </ServerHealthCtx.Provider>
  )
}
