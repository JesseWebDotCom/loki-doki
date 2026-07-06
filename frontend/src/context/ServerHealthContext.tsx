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
// Generous: the probe shares the browser's per-host connection budget with every SSE
// stream and poller in the app, and can sit queued for seconds while a download runs.
const PROBE_TIMEOUT_MS     = 8_000
const ALIVE_GRACE_MS       = 12_000  // recent real traffic suppresses a starved probe
// A refused/errored connection means the backend is really gone (hard); a timeout
// usually just means the probe was starved or the backend was busy (soft). Demand more
// evidence for the soft signal before alarming the whole app.
const HARD_FAILS_TO_DECLARE = 2
const SOFT_FAILS_TO_DECLARE = 4

export function ServerHealthProvider({ children }: { children: React.ReactNode }) {
  const [reachable, setReachable] = useState(true)
  const reachableRef = useRef(true)
  const hardFailsRef = useRef(0)
  const softFailsRef = useRef(0)
  const lastAliveRef = useRef(0)   // epoch ms of last confirmed contact (probe or traffic)
  const timerRef     = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Called from anywhere real traffic confirms the backend is up (an SSE event, a 2xx
  // fetch). The dedicated probe can be starved when many long-lived SSE connections are
  // open (browser per-host connection cap), so traffic is the more reliable signal.
  const markAlive = (now: number) => {
    lastAliveRef.current = now
    hardFailsRef.current = 0
    softFailsRef.current = 0
    if (!reachableRef.current) { reachableRef.current = true; setReachable(true) }
  }
  const reportAlive = () => markAlive(Date.now())

  useEffect(() => {
    let cancelled = false

    const clearTimer = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null } }
    const schedule   = (ms: number) => { clearTimer(); if (!cancelled) timerRef.current = setTimeout(check, ms) }

    async function check() {
      let ok = false
      let hard = false
      try {
        const r = await fetch('/api/health', { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: 'no-store' })
        ok = r.ok
        // A non-2xx response still reached A server — in dev that's the vite proxy
        // reporting the backend gone (502), in prod it's the health route failing.
        // Either way it's a real answer, not starvation: count it as hard.
        hard = !r.ok
      } catch (e) {
        // Timeout → soft (probably starved/busy). Anything else (connection refused,
        // DNS, network) → hard: nothing is listening.
        const isTimeout = e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')
        hard = !isTimeout
      }
      if (cancelled) return

      if (ok) {
        markAlive(Date.now())
      } else {
        if (hard) hardFailsRef.current += 1
        else softFailsRef.current += 1
        // Declare down only past the evidence threshold AND when no real traffic has
        // confirmed the backend within the grace window. This stops the banner from
        // flashing when the probe is merely starved behind active download streams.
        const quiet = Date.now() - lastAliveRef.current > ALIVE_GRACE_MS
        const enoughEvidence =
          hardFailsRef.current >= HARD_FAILS_TO_DECLARE ||
          hardFailsRef.current + softFailsRef.current >= SOFT_FAILS_TO_DECLARE
        if (enoughEvidence && quiet && reachableRef.current) { reachableRef.current = false; setReachable(false) }
      }
      // Probe fast the moment anything looks off (a pending failure or confirmed down)
      // so detection takes ~one extra probe, not a full healthy interval.
      const settled = reachableRef.current && hardFailsRef.current === 0 && softFailsRef.current === 0
      schedule(settled ? HEALTHY_INTERVAL_MS : DOWN_INTERVAL_MS)
    }

    const wake = () => { if (!cancelled) check() }
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      // Timers were throttled while the tab was hidden and the first probe after a
      // sleep/wake is flaky while the network stack comes back — start counting fresh
      // instead of pairing a stale pre-sleep miss with one shaky post-wake miss.
      hardFailsRef.current = 0
      softFailsRef.current = 0
      wake()
    }

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
