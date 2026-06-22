import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Loader2, ChevronDown, ChevronUp, CheckCircle2, AlertTriangle, PackageOpen, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useSetupProgress } from '@/context/SetupProgressContext'
import { useAuth } from '@/context/AuthContext'

// Corner card showing the background download queue (the non-essential set finishing
// after boot). Minimizable, but not dismissable until done — so failures stay visible.
export function BackgroundSetupWidget() {
  const { status, retryFailed } = useSetupProgress()
  const { user, welcomeComplete } = useAuth()
  const { pathname } = useLocation()
  const [minimized, setMinimized] = useState(false)
  const [retrying, setRetrying] = useState(false)

  // Setup has its own inline progress; nothing to show before login or when idle/clean.
  if (!status || pathname.startsWith('/setup') || pathname.startsWith('/login')) return null
  // The admin's post-boot welcome wizard is a full-screen takeover — don't overlap it.
  if (user?.role === 'admin' && welcomeComplete === false) return null
  const failed = status.counts.failed
  if (status.active === 0 && failed === 0) return null

  const running = status.jobs.filter((j) => j.status === 'running')
  const pending = status.counts.pending
  const allDone = status.active === 0

  const rowLabel = (note?: string, progress?: { completed: number; total: number } | null) => {
    if (note) return note
    if (progress && progress.total > 0) return `${Math.round((progress.completed / progress.total) * 100)}%`
    return 'starting…'
  }

  const jobTypeTag = (j: { type: string; refId: string; domain: string }) => {
    if (j.type === 'model') return 'AI Model'
    if (j.type === 'archive') return 'Library'
    if (j.type === 'map') return 'Maps'
    if (j.type === 'storage-move') return 'Storage'
    if (j.type === 'yt-media') return 'YouTube'
    if (j.type === 'podcast-generate') return 'Podcast'
    if (j.type === 'component') {
      if (j.refId === 'kiwix-tools') return 'Library'
      if (j.refId === 'maps-toolchain') return 'Maps'
      if (j.refId.startsWith('comfyui') || j.domain === 'comfyui') return 'AI Image'
      if (/voice|whisper|wakeword|kokoro|piper|f5/i.test(j.refId)) return 'Voice'
      if (j.refId === 'tesseract') return 'OCR'
    }
    return 'App'
  }

  if (minimized) {
    return (
      <button
        type="button"
        onClick={() => setMinimized(false)}
        className="fixed bottom-4 right-4 z-[120] flex items-center gap-2 rounded-full border border-border/60 bg-card px-3.5 py-2 text-sm font-medium shadow-lg hover:bg-muted transition-colors"
      >
        {allDone ? <CheckCircle2 className="size-4 text-emerald-400" /> : <Loader2 className="size-4 animate-spin text-violet-400" />}
        Setting up · {status.pct}%
        <ChevronUp className="size-3.5 text-muted-foreground" />
      </button>
    )
  }

  return (
    <div className="fixed bottom-4 right-4 z-[120] w-80 overflow-hidden rounded-2xl border border-border/60 bg-card shadow-xl animate-in slide-in-from-bottom-2">
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <PackageOpen className="size-4 text-violet-400" />
          {allDone ? 'Setup finished' : 'Setting up your apps'}
        </div>
        <button type="button" onClick={() => setMinimized(true)} className="text-muted-foreground hover:text-foreground" aria-label="Minimize">
          <ChevronDown className="size-4" />
        </button>
      </div>

      <div className="px-4 py-3 space-y-2.5">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{status.counts.completed} of {status.counts.total} ready</span>
          <span className="font-semibold text-foreground">{status.pct}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className={cn('h-full rounded-full transition-[width] duration-500', failed > 0 && allDone ? 'bg-amber-500' : 'bg-gradient-to-r from-violet-500 to-blue-400')} style={{ width: `${status.pct}%` }} />
        </div>

        {running.length > 0 && (
          <div className="space-y-1.5 pt-0.5">
            {running.slice(0, 3).map((j) => (
              <div key={j.id} className="flex items-center gap-2 text-xs">
                <Loader2 className="size-3 shrink-0 animate-spin text-violet-400" />
                <div className="min-w-0 flex-1 flex items-center gap-1.5 overflow-hidden">
                  <span className="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium bg-violet-500/15 text-violet-300 leading-none">{jobTypeTag(j)}</span>
                  <span className="truncate text-foreground/80">{j.label}</span>
                </div>
                <span className="shrink-0 tabular-nums text-muted-foreground">{rowLabel(j.progress?.note, j.progress)}</span>
              </div>
            ))}
          </div>
        )}

        {pending > 0 && !allDone && <p className="text-xs text-muted-foreground">{pending} more queued…</p>}

        {failed > 0 && (() => {
          const failedJobs = status.jobs.filter((j) => j.status === 'failed')
          const names = failedJobs.map((j) => j.label)
          const shown = names.slice(0, 2).join(', ')
          const extra = names.length > 2 ? ` +${names.length - 2} more` : ''
          return (
            <div className="space-y-2 rounded-lg border border-amber-500/25 bg-amber-500/5 p-2.5">
              <p className="flex items-start gap-1.5 text-xs text-amber-400">
                <AlertTriangle className="size-3.5 shrink-0 mt-px" />
                <span>Couldn&apos;t download: <span className="font-medium">{shown}{extra}</span></span>
              </p>
              <button
                type="button"
                disabled={retrying}
                onClick={async () => { setRetrying(true); try { await retryFailed() } finally { setRetrying(false) } }}
                className="flex w-full items-center justify-center gap-1.5 rounded-md bg-amber-500/15 px-2 py-1.5 text-xs font-semibold text-amber-300 hover:bg-amber-500/25 disabled:opacity-50 transition-colors"
              >
                <RefreshCw className={cn('size-3.5', retrying && 'animate-spin')} />
                {retrying ? 'Retrying…' : 'Retry now'}
              </button>
            </div>
          )
        })()}

        {allDone && failed === 0 && (
          <p className="flex items-center gap-1.5 text-xs text-emerald-400">
            <CheckCircle2 className="size-3.5 shrink-0" /> Everything is ready.
          </p>
        )}
      </div>
    </div>
  )
}
