import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  CheckCircle2, DownloadCloud, GitBranch, Power, PowerOff, RefreshCw, XCircle, AlertCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { RichOptionSelect } from '@/components/shared/RichOptionSelect'
import { useServerHealth } from '@/context/ServerHealthContext'

// ── Types mirrored from the backend (routes/adminServer.ts) ─────────────────────

interface ServerStatus {
  gitCheckout: boolean
  version: { shortHash: string; subject: string; date: string; branch: string } | null
  behind: number | null
  lastCheckedAt: number | null
  phase: 'idle' | 'checking' | 'updating' | 'restarting'
  settings: { mode: 'off' | 'notify' | 'auto'; intervalHours: number }
  devMode: boolean
}

type StepStatus = 'run' | 'ok' | 'fail' | 'skip'
interface StepState { key: string; label: string; status: StepStatus; detail?: string }

// Panel-level flow: idle → (confirm) → running update/restart/shutdown →
// waiting for the server to come back (restart paths) or 'off' (shutdown) →
// the page reloads itself onto the new bundle.
type Flow = 'idle' | 'updating' | 'restarting' | 'shuttingdown' | 'waiting' | 'gone' | 'off' | 'error'

const MODE_OPTIONS = [{
  options: [
    { value: 'off', label: 'Off', description: 'Never check for updates in the background' },
    { value: 'notify', label: 'Notify', description: 'Check periodically and notify admins when an update is available', recommended: true },
    { value: 'auto', label: 'Automatic', description: 'Download, install, and restart on its own when an update is available' },
  ],
}]

const INTERVAL_OPTIONS = [{
  options: [
    { value: '1', label: 'Every hour' },
    { value: '6', label: 'Every 6 hours' },
    { value: '12', label: 'Every 12 hours' },
    { value: '24', label: 'Once a day' },
  ],
}]

function StepRow({ step }: { step: StepState }) {
  const Icon = step.status === 'ok' ? CheckCircle2
    : step.status === 'fail' ? XCircle
    : AlertCircle
  const color = step.status === 'ok' ? 'text-success'
    : step.status === 'fail' ? 'text-destructive'
    : 'text-muted-foreground'
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2.5 text-sm">
        {step.status === 'run'
          ? <Spinner className="size-4 shrink-0 text-brand" />
          : <Icon className={`size-4 shrink-0 ${color}`} />}
        <span className="font-medium">{step.label}</span>
      </div>
      {step.detail && <p className="ml-[26px] text-[11px] text-muted-foreground">{step.detail}</p>}
    </div>
  )
}

export function ServerPanel() {
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [flow, setFlow] = useState<Flow>('idle')
  const [confirming, setConfirming] = useState<'update' | 'restart' | 'shutdown' | null>(null)
  const [steps, setSteps] = useState<StepState[]>([])
  const [logLines, setLogLines] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const { recheck } = useServerHealth()
  const esRef = useRef<EventSource | null>(null)
  const logRef = useRef<HTMLPreElement | null>(null)

  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/server/status', { credentials: 'include' })
      if (r.ok) {
        const s = (await r.json()) as ServerStatus
        setStatus(s)
        return s
      }
    } catch { /* leave stale status */ }
    return null
  }, [])

  useEffect(() => {
    void refreshStatus().then((s) => {
      // An update kicked off elsewhere (another admin, auto mode) is still
      // running: attach to its progress stream instead of showing idle.
      if (s && (s.phase === 'updating' || s.phase === 'restarting')) {
        attachUpdateStream()
      } else {
        // `behind` isn't persisted across server restarts, so a fresh load
        // reports null. Silently check on open so the Update button reflects
        // the real state right away.
        void checkNow({ silent: true })
      }
    })
    return () => { esRef.current?.close() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logLines])

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

  async function waitForServer() {
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
  }

  // ── update flow ───────────────────────────────────────────────────────────────

  function attachUpdateStream() {
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
      void refreshStatus()
    })
    es.addEventListener('done', (e) => {
      es.close()
      let data: { upToDate?: boolean; willRestart?: boolean; idle?: boolean } = {}
      try { data = JSON.parse((e as MessageEvent).data) } catch { /* keep empty */ }
      if (data.willRestart) {
        void waitForServer()
      } else if (data.upToDate) {
        toast.success('Already up to date')
        setFlow('idle')
        void refreshStatus()
      } else {
        setFlow('idle')
        void refreshStatus()
      }
    })
  }

  async function startUpdate() {
    const r = await fetch('/api/admin/server/update', { method: 'POST', credentials: 'include' })
    if (r.status === 409) {
      // Another admin beat us to it: watch their run.
      attachUpdateStream()
      return
    }
    if (!r.ok) {
      toast.error(`Could not start the update (server returned ${r.status})`)
      return
    }
    attachUpdateStream()
  }

  // ── restart / shutdown flows ─────────────────────────────────────────────────
  // Same SSE-until-the-process-exits shape; they differ only in the endpoint
  // (shutdown drops a sentinel the launcher's supervise loop honors) and in
  // what comes after: restart waits for the server, shutdown is final.

  async function runExitAction(kind: 'restart' | 'shutdown') {
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
  }

  // ── check + settings ──────────────────────────────────────────────────────────

  async function checkNow(opts?: { silent?: boolean }) {
    const silent = opts?.silent === true
    setChecking(true)
    try {
      const r = await fetch('/api/admin/server/check', { method: 'POST', credentials: 'include' })
      if (r.ok) {
        const { behind } = (await r.json()) as { behind: number }
        if (!silent) {
          if (behind > 0) toast.info(`${behind} update${behind === 1 ? '' : 's'} available`)
          else toast.success('Up to date')
        }
      } else if (!silent) {
        const { error: msg } = (await r.json().catch(() => ({}))) as { error?: string }
        toast.error(msg ?? 'Could not check for updates')
      }
    } catch {
      if (!silent) toast.error('Could not check for updates')
    }
    await refreshStatus()
    setChecking(false)
  }

  async function saveSettings(patch: { mode?: string; intervalHours?: number }) {
    try {
      const r = await fetch('/api/admin/server/settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!r.ok) throw new Error()
      const settings = (await r.json()) as ServerStatus['settings']
      setStatus((prev) => (prev ? { ...prev, settings } : prev))
      toast.success('Update settings saved')
    } catch {
      toast.error('Could not save the update settings')
    }
  }

  // ── render ────────────────────────────────────────────────────────────────────

  if (!status) {
    return (
      <div className="flex items-center gap-2 p-5 text-sm text-muted-foreground">
        <Spinner className="size-4" /> Loading server status…
      </div>
    )
  }

  const busy = flow !== 'idle'
  const behindLabel = status.behind === null ? null
    : status.behind > 0 ? `${status.behind} update${status.behind === 1 ? '' : 's'} available`
    : 'Up to date'

  return (
    <section className="space-y-4 p-5">
      {/* Version + update check */}
      <div className="rounded-card border border-border/60 bg-muted/20 p-4">
        {status.version ? (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-semibold">{status.version.shortHash}</span>
                <Badge variant="secondary" className="gap-1">
                  <GitBranch className="size-3" /> {status.version.branch}
                </Badge>
                {status.behind !== null && (
                  <Badge variant={status.behind > 0 ? 'default' : 'secondary'}>{behindLabel}</Badge>
                )}
              </div>
              <p className="truncate text-xs text-muted-foreground">{status.version.subject}</p>
              <p className="text-[11px] text-muted-foreground">
                {status.version.date && `Committed ${new Date(status.version.date).toLocaleString()}`}
                {status.lastCheckedAt && ` · Last checked ${new Date(status.lastCheckedAt).toLocaleString()}`}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => checkNow()} disabled={checking || busy}>
              {checking ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}
              Check for updates
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            The server is not running from a git checkout, so updates are not available here. You can
            still restart it below.
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        {status.gitCheckout && (
          status.behind === 0 ? (
            <Button size="sm" variant="outline" disabled>
              <CheckCircle2 className="size-4" />
              Up to date
            </Button>
          ) : (
            <Button size="sm" onClick={() => setConfirming('update')} disabled={busy}>
              <DownloadCloud className="size-4" />
              Update &amp; restart
            </Button>
          )
        )}
        <Button variant="outline" size="sm" onClick={() => setConfirming('restart')} disabled={busy}>
          <Power className="size-4" />
          Restart server
        </Button>
        <Button
          variant="outline" size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => setConfirming('shutdown')} disabled={busy}
        >
          <PowerOff className="size-4" />
          Shut down server
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Restart comes back automatically when the server was started with the launcher (run.ps1 or
        run.sh), which supervises and restarts it. Shut down stops it for good: bringing it back
        means launching it again on the server machine.
      </p>

      {/* Background update checks */}
      {status.gitCheckout && (
        <div className="space-y-3 border-t border-border/60 pt-4">
          <div>
            <h4 className="text-sm font-medium">Background update checks</h4>
            <p className="text-xs text-muted-foreground">
              How the server looks for new versions on its own.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <RichOptionSelect
              value={status.settings.mode}
              onChange={(mode) => void saveSettings({ mode })}
              groups={MODE_OPTIONS}
            />
            {status.settings.mode !== 'off' && (
              <RichOptionSelect
                value={String(status.settings.intervalHours)}
                onChange={(v) => void saveSettings({ intervalHours: Number(v) })}
                groups={INTERVAL_OPTIONS}
              />
            )}
          </div>
        </div>
      )}

      {/* Confirmations */}
      <ConfirmDialog
        open={confirming === 'restart'}
        onOpenChange={(o) => { if (!o) setConfirming(null) }}
        title="Restart the server?"
        description="Everyone using the app will lose their connection for a few seconds while the server restarts."
        confirmLabel="Restart"
        onConfirm={() => { setConfirming(null); void runExitAction('restart') }}
      />
      <ConfirmDialog
        open={confirming === 'shutdown'}
        onOpenChange={(o) => { if (!o) setConfirming(null) }}
        title="Shut down the server?"
        description="The app goes offline for everyone. It stays off until someone launches it again on the server machine (run.ps1 or run.sh)."
        confirmLabel="Shut down"
        destructive
        onConfirm={() => { setConfirming(null); void runExitAction('shutdown') }}
      />
      <ConfirmDialog
        open={confirming === 'update'}
        onOpenChange={(o) => { if (!o) setConfirming(null) }}
        title="Update and restart?"
        description="The server pulls the latest code, refreshes dependencies, rebuilds the app, and restarts. This can take a few minutes; the app keeps running until the restart at the end."
        confirmLabel="Update"
        onConfirm={() => { setConfirming(null); void startUpdate() }}
      />

      {/* Progress / waiting / error dialog */}
      <Dialog open={busy} onOpenChange={() => {}}>
        <DialogContent className="max-w-lg space-y-4 [&>button:last-child]:hidden">
          {(flow === 'updating' || flow === 'restarting' || flow === 'shuttingdown') && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2.5 text-base">
                  <Spinner className="size-5 text-brand" />
                  {flow === 'updating' ? 'Updating the server…'
                    : flow === 'restarting' ? 'Restarting the server…'
                    : 'Shutting down the server…'}
                </DialogTitle>
                <DialogDescription className="text-xs">
                  {flow === 'shuttingdown'
                    ? 'The server stops in a moment.'
                    : <>You can close this page; the {flow === 'updating' ? 'update' : 'restart'} continues on the server.</>}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                {steps.map((s) => <StepRow key={s.key} step={s} />)}
              </div>
              {logLines.length > 0 && (
                <pre
                  ref={logRef}
                  className="max-h-40 overflow-y-auto rounded-control border border-border/60 bg-muted/30 p-2 text-[10px] leading-relaxed text-muted-foreground"
                >
                  {logLines.join('\n')}
                </pre>
              )}
            </>
          )}

          {flow === 'waiting' && (
            <DialogHeader className="space-y-3 text-center sm:text-center">
              <Spinner className="mx-auto size-8 text-brand" />
              <DialogTitle className="text-base">Waiting for the server to come back…</DialogTitle>
              <DialogDescription className="text-xs">
                The page reloads automatically once the server is reachable again.
              </DialogDescription>
            </DialogHeader>
          )}

          {flow === 'off' && (
            <DialogHeader className="space-y-3 text-center sm:text-center">
              <PowerOff className="mx-auto size-8 text-muted-foreground" />
              <DialogTitle className="text-base">The server has shut down</DialogTitle>
              <DialogDescription className="text-xs">
                Launch it again on the server machine (run.ps1 or run.sh) to bring the app back.
                You can close this page.
              </DialogDescription>
            </DialogHeader>
          )}

          {flow === 'gone' && (
            <div className="space-y-3">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2.5 text-base">
                  <XCircle className="size-5 text-destructive" />
                  The server did not come back
                </DialogTitle>
              </DialogHeader>
              <p className="text-xs text-muted-foreground">
                It has been a few minutes without a response. Check the launcher console on the server
                machine (run.ps1 or run.sh) and start it again if needed.
              </p>
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={() => window.location.reload()}>Reload page</Button>
              </div>
            </div>
          )}

          {flow === 'error' && (
            <div className="space-y-3">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2.5 text-base">
                  <XCircle className="size-5 text-destructive" />
                  {steps.some((s) => s.key === 'merge' && s.status === 'ok') ? 'Update failed after pulling code' : 'Operation failed'}
                </DialogTitle>
              </DialogHeader>
              <p className="text-xs text-muted-foreground">{error}</p>
              <div className="space-y-3">
                {steps.map((s) => <StepRow key={s.key} step={s} />)}
              </div>
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={() => { setFlow('idle'); void refreshStatus() }}>Close</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}
