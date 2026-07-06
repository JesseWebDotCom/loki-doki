import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { AlertTriangle, HardDrive, DownloadCloud } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { useSetupProgress } from '@/context/SetupProgressContext'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

// Admin-facing consent prompt for the boot-time restore plan: shown when reconcile
// found previously-installed components missing and the re-download is big enough
// (or the OS fingerprint changed — a fresh Windows/macOS/Linux install) that we ask
// before pulling gigabytes. "Restore now" hands the whole plan to the durable
// background queue; progress then shows in the global BackgroundSetupWidget.

interface RestoreItem { id: string; label: string; approxBytes: number }
interface AttentionItem { id: string; label: string; reason: string }
interface RestorePlanView {
  osChanged: boolean
  totalBytes: number
  components: RestoreItem[]
  models: RestoreItem[]
  attention: AttentionItem[]
  status: 'pending' | 'started' | 'dismissed'
}

function formatBytes(b: number): string {
  if (b >= 1_000_000_000) return `${(b / 1_000_000_000).toFixed(1)} GB`
  if (b >= 1_000_000) return `${Math.round(b / 1_000_000)} MB`
  if (b > 0) return `${Math.max(1, Math.round(b / 1_000))} KB`
  return ''
}

export function RestorePrompt() {
  const { user } = useAuth()
  const { pathname } = useLocation()
  const { refresh } = useSetupProgress()
  const [plan, setPlan] = useState<RestorePlanView | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const isAdmin = user?.role === 'admin'

  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    async function load() {
      try {
        // The plan is written near the end of the boot sequence — wait for boot to
        // finish before asking, instead of racing it.
        const ready = await fetch('/api/system/ready', { credentials: 'include' })
        if (!ready.ok) { if (!cancelled) timer = setTimeout(load, 5_000); return }
        const res = await fetch('/api/system/restore', { credentials: 'include' })
        if (!res.ok || cancelled) return
        const data = (await res.json()) as { plan: RestorePlanView | null }
        if (cancelled) return
        setPlan(data.plan)
        if (data.plan && data.plan.status === 'pending') setOpen(true)
      } catch { /* offline or logged out — no prompt */ }
    }

    load()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [isAdmin])

  // Chrome-less surfaces never get modals (mirrors GlobalSetupWidget).
  if (!isAdmin || pathname === '/save' || pathname === '/login' || pathname === '/setup' || pathname === '/display') return null
  if (!plan || plan.status !== 'pending') return null

  const items = [...plan.models, ...plan.components]
  const hasDownloads = items.length > 0

  async function act(endpoint: 'start' | 'dismiss') {
    setBusy(true)
    try {
      await fetch(`/api/system/restore/${endpoint}`, { method: 'POST', credentials: 'include' })
      if (endpoint === 'start') refresh()  // wake the jobs poller so the widget appears right away
      setPlan((p) => (p ? { ...p, status: endpoint === 'start' ? 'started' : 'dismissed' } : p))
      setOpen(false)
    } catch { /* leave the dialog up — the user can retry */ }
    setBusy(false)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !busy) void act('dismiss') }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HardDrive className="size-4 text-brand" />
            {plan.osChanged ? 'Restore after system reinstall' : 'Restore missing components'}
          </DialogTitle>
          <DialogDescription>
            {plan.osChanged
              ? 'It looks like the operating system was reinstalled. Your library, settings, and AI models on the data drive are intact — but some supporting components lived on the system drive and need to be reinstalled.'
              : 'Some previously installed components are missing and restoring them needs a large download.'}
          </DialogDescription>
        </DialogHeader>

        {hasDownloads && (
          <div className="max-h-56 space-y-1 overflow-y-auto rounded-card border border-border/60 p-3">
            {items.map((it) => (
              <div key={it.id} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">{it.label}</span>
                <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{formatBytes(it.approxBytes)}</span>
              </div>
            ))}
            <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-border/60 pt-2 text-sm font-medium">
              <span>Total download</span>
              <span className="tabular-nums">{formatBytes(plan.totalBytes) || '—'}</span>
            </div>
          </div>
        )}

        {plan.attention.length > 0 && (
          <div className="space-y-2 rounded-card border border-warning/30 bg-warning/5 p-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-warning">
              <AlertTriangle className="size-3.5 shrink-0" />
              Needs your attention — can't be restored automatically
            </p>
            <ul className="space-y-1.5">
              {plan.attention.map((a) => (
                <li key={a.id} className="text-xs leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground">{a.label}:</span> {a.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" disabled={busy} onClick={() => void act('dismiss')}>
            Not now
          </Button>
          {hasDownloads ? (
            <Button disabled={busy} onClick={() => void act('start')}>
              <DownloadCloud className="size-4" />
              Restore now{plan.totalBytes > 0 ? ` (${formatBytes(plan.totalBytes)})` : ''}
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => void act('dismiss')}>Got it</Button>
          )}
        </DialogFooter>

        {hasDownloads && (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Everything downloads in the background — you can keep using the app while it finishes.
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
