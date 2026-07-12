import { useEffect } from 'react'

// Forwards the dock's local resource monitoring to the server: periodic
// snapshots (feeds the companion's machineStatus tool) and threshold-alert
// events (become notifications / spoken announcements). Runs in the HUD page
// because it holds the logged-in session cookie - the Electron main process
// only collects (desktop/src/resources.js) and never talks to the server.
//
// Events are acked back to the shell ONLY after a 2xx report, so a failed or
// signed-out POST leaves them pending and they retry on the next tick.

const TICK_MS = 20_000
const SNAPSHOT_EVERY_MS = 60_000

export function useResourceReporter() {
  useEffect(() => {
    const bridge = window.lokiDesktop
    if (!bridge?.getResources) return
    let cancelled = false
    let lastSnapshotAt = 0

    const tick = async () => {
      const state = await bridge.getResources?.().catch(() => null)
      if (cancelled || !state || !state.enabled) return
      const due = Date.now() - lastSnapshotAt >= SNAPSHOT_EVERY_MS
      if (!due && state.pendingEvents.length === 0) return
      try {
        const res = await fetch('/api/monitoring/resources/report', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            machine: { id: state.machineId, hostname: state.hostname, label: state.hostname, platform: state.platform },
            snapshot: state.snapshot,
            events: state.pendingEvents,
            announce: state.announce,
          }),
        })
        if (!res.ok) return // 401 while signed out etc. - events stay pending
        lastSnapshotAt = Date.now()
        const body = await res.json().catch(() => null) as { ackIds?: string[] } | null
        const ackIds = body?.ackIds?.length ? body.ackIds : state.pendingEvents.map((e) => e.id)
        if (ackIds.length) await bridge.ackResourceEvents?.(ackIds)
      } catch { /* offline - retry next tick */ }
    }

    void tick()
    const t = setInterval(() => { void tick() }, TICK_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [])
}
