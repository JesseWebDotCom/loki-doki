import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, DownloadCloud, GitBranch, Power, PowerOff, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { RichOptionSelect } from '@/components/shared/RichOptionSelect'
import { ServerMaintenanceDialog } from '@/components/shared/ServerMaintenanceDialog'
import { useServerMaintenance } from '@/hooks/useServerMaintenance'

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

export function ServerPanel() {
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [confirming, setConfirming] = useState<'update' | 'restart' | 'shutdown' | null>(null)
  const maintenance = useServerMaintenance()

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
        maintenance.attachUpdateStream()
      } else {
        // `behind` isn't persisted across server restarts, so a fresh load
        // reports null. Silently check on open so the Update button reflects
        // the real state right away.
        void checkNow({ silent: true })
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Refresh the version/behind status once maintenance work finishes (e.g. a
  // dismissed error, or a 409-conflict bounce back to idle). Skips the initial
  // mount, which the effect above already covers.
  const wasBusy = useRef(false)
  useEffect(() => {
    if (wasBusy.current && !maintenance.busy) void refreshStatus()
    wasBusy.current = maintenance.busy
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maintenance.busy])

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

  const busy = maintenance.busy
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
        onConfirm={() => { setConfirming(null); void maintenance.runExitAction('restart') }}
      />
      <ConfirmDialog
        open={confirming === 'shutdown'}
        onOpenChange={(o) => { if (!o) setConfirming(null) }}
        title="Shut down the server?"
        description="The app goes offline for everyone. It stays off until someone launches it again on the server machine (run.ps1 or run.sh)."
        confirmLabel="Shut down"
        destructive
        onConfirm={() => { setConfirming(null); void maintenance.runExitAction('shutdown') }}
      />
      <ConfirmDialog
        open={confirming === 'update'}
        onOpenChange={(o) => { if (!o) setConfirming(null) }}
        title="Update and restart?"
        description="The server pulls the latest code, refreshes dependencies, rebuilds the app, and restarts. This can take a few minutes; the app keeps running until the restart at the end."
        confirmLabel="Update"
        onConfirm={() => { setConfirming(null); void maintenance.startUpdate() }}
      />

      <ServerMaintenanceDialog
        flow={maintenance.flow}
        steps={maintenance.steps}
        logLines={maintenance.logLines}
        error={maintenance.error}
        onDismissError={maintenance.dismissError}
      />
    </section>
  )
}
