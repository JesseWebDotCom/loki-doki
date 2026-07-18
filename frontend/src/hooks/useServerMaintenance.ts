import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useServerHealth } from '@/context/ServerHealthContext'

// Drives the server maintenance state machine shared by Admin > System > Server
// (ServerPanel) and the sidebar update badge: kick off the update pipeline or a
// restart/shutdown, stream its progress over SSE, then wait for the server to come
// back and reload. Extracted so both surfaces show the same run instead of each
// opening its own EventSource against the same backend broadcast.

export type StepStatus = 'run' | 'ok' | 'fail' | 'skip'
export interface StepState { key: string; label: string; status: StepStatus; detail?: string }

// idle → (confirm, elsewhere) → updating/restarting/shuttingdown → waiting for the
// server to come back (restart paths) or 'off' (shutdown) → the page reloads itself.
export type MaintenanceFlow = 'idle' | 'updating' | 'restarting' | 'shuttingdown' | 'waiting' | 'gone' | 'off' | 'error'

export interface UseServerMaintenanceReturn {
  flow: MaintenanceFlow
  steps: StepState[]
  logLines: string[]
  error: string | null
  busy: boolean
  /** Start the update pipeline (git fetch/merge, deps, build, restart). */
  startUpdate: () => Promise<void>
  /** Attach to an update pipeline already running (this tab loaded mid-run, or another admin/auto mode started one). */
  attachUpdateStream: () => void
  /** Restart or shut down the server. */
  runExitAction: (kind: 'restart' | 'shutdown') => Promise<void>
  /** Dismiss an error and return to idle. */
  dismissError: () => void
}

export function useServerMaintenance(): UseServerMaintenanceReturn {
  const [flow, setFlow] = useState<MaintenanceFlow>('idle')
  const [steps, setSteps] = useState<StepState[]>([])
  const [logLines, setLogLines] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const { recheck } = useServerHealth()
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => () => { esRef.current?.close() }, [])

  function upsertStep(next: StepState) {
    setSteps((prev) => {
      const i = prev.findIndex((s) => s.key === next.key)
      if (i === -1) return [...prev, next]
      const copy = [...prev]
      copy[i] = { ...copy[i], ...next }
      return copy
    })
  }

  // ── waiting for the server to come back ──────────────────────────────────────

  const waitForServer = useCallback(async () => {
    setFlow('waiting')
    recheck()
    let okStreak = 0
    for (let attempt = 0; attempt < 90; attempt++) {
      await new Promise((r) => setTimeout(r, 2_000))
      try {
        const r = await fetch('/api/health', { cache: 'no-store' })
        okStreak = r.ok ? okStreak + 1 : 0
      } catch {
        okStreak = 0
      }
      if (okStreak >= 2) {
        window.location.reload()
        return
      }
    }
    setFlow('gone')
  }, [recheck])

  // ── update flow ───────────────────────────────────────────────────────────────

  const attachUpdateStream = useCallback(() => {
    setFlow('updating')
    setSteps([])
    setLogLines([])
    setError(null)
    esRef.current?.close()
    const es = new EventSource('/api/admin/server/update/stream')
    esRef.current = es
    // Every (re)connect replays the full buffer, so reset so nothing duplicates.
    es.addEventListener('open', () => {
      setSteps([])
      setLogLines([])
    })
    es.addEventListener('step', (e) => {
      try { upsertStep(JSON.parse((e as MessageEvent).data) as StepState) } catch { /* skip */ }
    })
    es.addEventListener('log', (e) => {
      try {
        const { line } = JSON.parse((e as MessageEvent).data) as { line: string }
        setLogLines((prev) => [...prev.slice(-199), line])
      } catch { /* skip */ }
    })
    es.addEventListener('error', (e) => {
      // Only messages with data are pipeline errors. Bare error events are
      // connection hiccups: let EventSource auto-reconnect (the stream replays
      // its buffer, and step upserts dedupe by key). The server always flushes
      // done {willRestart} before exiting, so an exit is never signaled here.
      const data = (e as MessageEvent).data
      if (!data) return
      try { setError((JSON.parse(data) as { message: string }).message) } catch { setError(String(data)) }
      es.close()
      setSteps((prev) => prev.map((s) => (s.status === 'run' ? { ...s, status: 'fail' } : s)))
      setFlow('error')
    })
    es.addEventListener('done', (e) => {
      es.close()
      let data: { upToDate?: boolean; willRestart?: boolean; idle?: boolean } = {}
      try { data = JSON.parse((e as MessageEvent).data) } catch { /* keep empty */ }
      if (data.willRestart) {
        void waitForServer()
      } else {
        if (data.upToDate) toast.success('Already up to date')
        setFlow('idle')
      }
    })
  }, [waitForServer])

  const startUpdate = useCallback(async () => {
    const r = await fetch('/api/admin/server/update', { method: 'POST', credentials: 'include' })
    if (r.status === 409) {
      // Another admin beat us to it (or auto mode kicked in): watch their run.
      attachUpdateStream()
      return
    }
    if (!r.ok) {
      toast.error(`Could not start the update (server returned ${r.status})`)
      return
    }
    attachUpdateStream()
  }, [attachUpdateStream])

  // ── restart / shutdown flows ─────────────────────────────────────────────────
  // Same SSE-until-the-process-exits shape; they differ only in the endpoint
  // (shutdown drops a sentinel the launcher's supervise loop honors) and in
  // what comes after: restart waits for the server, shutdown is final.

  const runExitAction = useCallback(async (kind: 'restart' | 'shutdown') => {
    setFlow(kind === 'restart' ? 'restarting' : 'shuttingdown')
    setSteps([])
    setError(null)
    try {
      const res = await fetch(`/api/admin/server/${kind}`, { method: 'POST', credentials: 'include' })
      if (res.status === 409) {
        toast.error('The server is busy with another maintenance task.')
        setFlow('idle')
        return
      }
      if (!res.ok || !res.body) {
        setError(`Server returned ${res.status}`)
        setFlow('error')
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let currentEvent = 'message'
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n'); buf = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('event:')) { currentEvent = line.slice(6).trim(); continue }
          if (!line.startsWith('data:')) continue
          let data: Record<string, unknown> = {}
          try { data = JSON.parse(line.slice(5).trim()) } catch { /* keep empty */ }
          if (currentEvent === 'step') upsertStep(data as unknown as StepState)
        }
      }
      // Stream ended: the server is exiting.
      if (kind === 'restart') await waitForServer()
      else setFlow('off')
    } catch {
      // Dropped connection mid-stream is the expected exit path.
      if (kind === 'restart') await waitForServer()
      else setFlow('off')
    }
  }, [waitForServer])

  const dismissError = useCallback(() => {
    setFlow('idle')
    esRef.current?.close()
  }, [])

  return {
    flow,
    steps,
    logLines,
    error,
    busy: flow !== 'idle',
    startUpdate,
    attachUpdateStream,
    runExitAction,
    dismissError,
  }
}
