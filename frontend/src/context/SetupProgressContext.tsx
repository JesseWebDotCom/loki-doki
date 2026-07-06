import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { useServerHealth } from '@/context/ServerHealthContext'

// Tracks the backend background-download queue (the non-essential set that finishes after
// the app boots on essentials). One poller shared by the global widget and per-app
// "preparing" states. Polls quickly while work is active, lazily when idle.

export interface JobProgress { completed: number; total: number; speedBps: number; etaSeconds: number; note?: string }
export interface JobInfo {
  id: string
  type: 'model' | 'archive' | 'map' | 'component'
  refId: string
  label: string
  domain: string
  sizeClass: 'large' | 'small'
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  attempts: number
  lastError: string | null
  progress: JobProgress | null
}
export interface JobGroup {
  counts: { total: number; pending: number; running: number; completed: number; failed: number; cancelled: number }
  pct: number
  active: number   // pending + running
  done: boolean
  jobs: JobInfo[]
  // Byte-level aggregate for the honest "X GB of Y GB · Z/s · ~N left" readout.
  downloadedBytes: number
  totalBytes: number
  speedBps: number
  etaSeconds: number
}
// Top-level fields = setup+content combined (backward-compatible); `setup`/`content` split
// the queue into the app-it-needs track and the optional-library-content track.
export interface JobsStatus extends JobGroup {
  setup: JobGroup
  content: JobGroup
}

interface SetupProgress {
  status: JobsStatus | null
  refresh: () => void
  /** Re-queue every failed/skipped download, then refresh. */
  retryFailed: () => Promise<void>
  /** Give up on every failed download (mark cancelled so the widget closes), then refresh. */
  dismissFailed: () => Promise<void>
  /** Cancel a single in-flight/queued download, then refresh. */
  cancelJob: (id: string) => Promise<void>
}

const Ctx = createContext<SetupProgress>({ status: null, refresh: () => {}, retryFailed: async () => {}, dismissFailed: async () => {}, cancelJob: async () => {} })
export function useSetupProgress(): SetupProgress { return useContext(Ctx) }

// Map an in-flight job to the app route(s) it's preparing, so the nav can badge them.
function jobToPaths(j: JobInfo): string[] {
  if (j.type === 'map') return ['/maps']
  if (j.type === 'model') return ['/chat']  // background models = vision etc.
  if (j.type === 'component') {
    if (j.refId.startsWith('comfyui') || j.domain === 'comfyui') return ['/imaging', '/videos']
    if (j.refId === 'maps-toolchain') return ['/maps']
    if (j.refId === 'tesseract') return ['/home-inventory']
  }
  return []
}

/** App routes that still have assets downloading — drives nav "busy" badges. */
export function useBusyAppPaths(): Set<string> {
  const { status } = useSetupProgress()
  const busy = new Set<string>()
  if (!status) return busy
  for (const j of status.jobs) {
    if (j.status === 'running' || j.status === 'pending') for (const p of jobToPaths(j)) busy.add(p)
  }
  return busy
}

/** Per-page "preparing" hint: is anything for this route still downloading, and how far? */
export function useAppPreparing(path: string): { preparing: boolean; pct: number; label: string | null } {
  const { status } = useSetupProgress()
  if (!status) return { preparing: false, pct: 0, label: null }
  const jobs = status.jobs.filter((j) => (j.status === 'running' || j.status === 'pending') && jobToPaths(j).includes(path))
  if (jobs.length === 0) return { preparing: false, pct: 0, label: null }
  const running = jobs.find((j) => j.status === 'running')
  const p = running?.progress
  const pct = p && p.total > 0 ? Math.round((p.completed / p.total) * 100) : 0
  return { preparing: true, pct, label: running?.label ?? jobs[0].label }
}

const ACTIVE_MS = 4_000
const IDLE_MS = 60_000

// Module-level generation token: guarantees only ONE poll loop is ever live, even if a
// stale closure survives StrictMode double-mount or a Vite HMR module swap. Any loop whose
// generation is no longer current stops itself — prevents the /api/jobs/status request storm.
let pollGeneration = 0

export function SetupProgressProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<JobsStatus | null>(null)
  const statusRef = useRef<JobsStatus | null>(null)
  // This is the most frequent background fetch in the app (4s while downloads run) —
  // feed every success into the server-health context so its starved /api/health probe
  // never false-alarms while heavy downloads hog the per-host connection budget.
  const { reportAlive } = useServerHealth()
  const reportAliveRef = useRef(reportAlive)
  reportAliveRef.current = reportAlive

  useEffect(() => {
    const myGen = ++pollGeneration
    let timer: ReturnType<typeof setTimeout> | null = null
    const alive = () => myGen === pollGeneration
    const schedule = (ms: number) => { if (timer) clearTimeout(timer); if (alive()) timer = setTimeout(poll, ms) }

    async function poll() {
      if (!alive()) return
      try {
        const r = await fetch('/api/jobs/status', { credentials: 'include', signal: AbortSignal.timeout(6000) })
        if (r.ok) reportAliveRef.current()
        if (alive() && r.ok) {
          const data = (await r.json()) as JobsStatus
          statusRef.current = data
          setStatus(data)
        }
      } catch { /* not logged in / offline — leave last value */ }
      schedule(statusRef.current && statusRef.current.active > 0 ? ACTIVE_MS : IDLE_MS)
    }

    poll()
    const onVisible = () => { if (document.visibilityState === 'visible' && alive()) poll() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      pollGeneration++          // invalidate this loop so it stops on its next tick
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const refresh = () => { if (document.visibilityState === 'visible') document.dispatchEvent(new Event('visibilitychange')) }

  const retryFailed = async () => {
    try { await fetch('/api/jobs/retry-all-failed', { method: 'POST', credentials: 'include' }) } catch { /* ignore */ }
    refresh()
  }

  const dismissFailed = async () => {
    try { await fetch('/api/jobs/dismiss-failed', { method: 'POST', credentials: 'include' }) } catch { /* ignore */ }
    refresh()
  }

  const cancelJob = async (id: string) => {
    try { await fetch(`/api/jobs/${id}/cancel`, { method: 'POST', credentials: 'include' }) } catch { /* ignore */ }
    refresh()
  }

  return <Ctx.Provider value={{ status, refresh, retryFailed, dismissFailed, cancelJob }}>{children}</Ctx.Provider>
}
