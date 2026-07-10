import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ChevronDown, ChevronUp, CheckCircle2, AlertTriangle, PackageOpen, RefreshCw, Library, X } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { fmtBytes } from '@/lib/youtube/format'
import { useSetupProgress, type JobInfo, type JobGroup } from '@/context/SetupProgressContext'
import { useAuth } from '@/context/AuthContext'

// Corner card stack showing the background download queue. Two independent tracks:
//   • Setup: runtimes/models/components the app needs (finishes in minutes)
//   • Library: optional ZIM/map content that can be many GB (downloads honestly, never blocks)
// Splitting them stops a 140 GB library download from masquerading as "Setting up your apps … 87%"
// and making a fully-usable app look broken for hours.

/** Compact "~5m left" / "~2h left" / "~40s left". */
function fmtEta(s: number): string {
  if (!s || s <= 0) return ''
  if (s >= 3600) return `~${Math.round(s / 3600)}h left`
  if (s >= 60) return `~${Math.round(s / 60)}m left`
  return `~${Math.round(s)}s left`
}

function jobTypeTag(j: Pick<JobInfo, 'type' | 'refId' | 'domain'>): string {
  if (j.type === 'model') return 'AI Model'
  if (j.type === 'archive') return 'Library'
  if (j.type === 'map') return 'Maps'
  if (j.type === 'component') {
    if (j.refId === 'kiwix-tools') return 'Library'
    if (j.refId === 'maps-toolchain') return 'Maps'
    if (j.refId.startsWith('comfyui') || j.domain === 'comfyui') return 'AI Image'
    if (/voice|whisper|wakeword|kokoro|piper|f5/i.test(j.refId)) return 'Voice'
    if (j.refId === 'tesseract') return 'OCR'
  }
  return 'App'
}

export function BackgroundSetupWidget() {
  const { status, retryFailed, dismissFailed, cancelJob } = useSetupProgress()
  const { user, welcomeComplete } = useAuth()
  const { pathname } = useLocation()
  const [minimized, setMinimized] = useState(true)
  const [retrying, setRetrying] = useState(false)
  // Sit above whatever bottom chrome is actually rendered (media bar, mobile dock);
  // the shell measures it into --bottom-chrome. The old youtube/radio heuristic
  // missed podcast/live-radio bars and the mobile dock entirely.
  const bottomClass = 'bottom-[calc(var(--bottom-chrome,0px)+1rem)]'

  // Setup has its own inline progress; nothing to show before login or when idle/clean.
  if (!status || pathname.startsWith('/setup') || pathname.startsWith('/login')) return null
  // The admin's post-boot welcome wizard is a full-screen takeover; do not overlap it.
  if (user?.role === 'admin' && welcomeComplete === false) return null

  const setup = status.setup
  const content = status.content
  const showSetup = setup.active > 0 || setup.counts.failed > 0
  const showLibrary = content.active > 0 || content.counts.failed > 0
  if (!showSetup && !showLibrary) return null

  const onRetry = async () => { setRetrying(true); try { await retryFailed() } finally { setRetrying(false) } }
  const onDismiss = async () => { await dismissFailed() }

  if (minimized) {
    const allDone = status.active === 0 && status.counts.failed === 0
    return (
      <Button
        type="button"
        variant="outline"
        onClick={() => setMinimized(false)}
        className={cn('fixed right-4 z-[120] transition-[bottom] duration-200 gap-2 border-border/60 bg-card shadow-lg hover:bg-muted', bottomClass)}
      >
        {allDone ? <CheckCircle2 className="size-4 text-success" /> : <Spinner className="text-brand" />}
        {showLibrary && !showSetup ? 'Downloading library' : 'Setting up'} · {status.pct}%
        <ChevronUp className="size-3.5 text-muted-foreground" />
      </Button>
    )
  }

  return (
    <div className={cn('fixed right-4 z-[120] transition-[bottom] duration-200 w-80 space-y-2.5', bottomClass)}>
      {showSetup && (
        <SetupCard group={setup} onMinimize={() => setMinimized(true)} retrying={retrying} onRetry={onRetry} onDismiss={onDismiss} />
      )}
      {showLibrary && (
        <LibraryCard group={content} onCancel={cancelJob} retrying={retrying} onRetry={onRetry} onDismiss={onDismiss} showMinimize={!showSetup} onMinimize={() => setMinimized(true)} />
      )}
    </div>
  )
}

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-card border border-border/60 bg-card shadow-xl animate-in slide-in-from-bottom-2">
      {children}
    </div>
  )
}

function FailureBlock({ jobs, retrying, onRetry, onDismiss }: { jobs: JobInfo[]; retrying: boolean; onRetry: () => void; onDismiss: () => void }) {
  const names = jobs.map((j) => j.label)
  const shown = names.slice(0, 2).join(', ')
  const extra = names.length > 2 ? ` +${names.length - 2} more` : ''
  return (
    <div className="space-y-2 rounded-control border border-warning/25 bg-warning/5 p-2.5">
      <p className="flex items-start gap-1.5 text-xs text-warning">
        <AlertTriangle className="size-3.5 shrink-0 mt-px" />
        <span>Couldn&apos;t reach <span className="font-medium">{shown}{extra}</span>. Retrying automatically.</span>
      </p>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={retrying}
          onClick={onRetry}
          className="flex-1 gap-1.5 bg-warning/15 font-semibold text-warning hover:bg-warning/25"
        >
          {retrying ? <Spinner size="sm" className="text-warning" /> : <RefreshCw className="size-3.5" />}
          {retrying ? 'Retrying…' : 'Retry now'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          title="Stop trying and hide this"
        >
          Dismiss
        </Button>
      </div>
    </div>
  )
}

function SetupCard({ group, onMinimize, retrying, onRetry, onDismiss }: { group: JobGroup; onMinimize: () => void; retrying: boolean; onRetry: () => void; onDismiss: () => void }) {
  const failed = group.counts.failed
  const allDone = group.active === 0 && failed === 0
  const running = group.jobs.filter((j) => j.status === 'running')
  const pending = group.counts.pending

  const rowLabel = (j: JobInfo) => {
    const p = j.progress
    if (p?.note) return p.note
    if (p && p.total > 0) return `${Math.round((p.completed / p.total) * 100)}%`
    return 'starting…'
  }

  return (
    <CardShell>
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <PackageOpen className="size-4 text-brand" />
          {allDone ? 'Setup finished' : 'Setting up your apps'}
        </div>
        <button type="button" onClick={onMinimize} className="text-muted-foreground hover:text-foreground" aria-label="Minimize">
          <ChevronDown className="size-4" />
        </button>
      </div>
      <div className="px-4 py-3 space-y-2.5">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{group.counts.completed} of {group.counts.total} ready</span>
          <span className="font-semibold text-foreground">{group.pct}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className={cn('h-full rounded-full transition-[width] duration-500', failed > 0 ? 'bg-warning' : 'bg-brand')} style={{ width: `${group.pct}%` }} />
        </div>

        {running.length > 0 && (
          <div className="space-y-1.5 pt-0.5">
            {running.slice(0, 3).map((j) => (
              <div key={j.id} className="flex items-center gap-2 text-xs">
                <Spinner size="sm" className="size-3 shrink-0 text-brand" />
                <div className="min-w-0 flex-1 flex items-center gap-1.5 overflow-hidden">
                  <span className="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium bg-brand/15 text-brand leading-none">{jobTypeTag(j)}</span>
                  <span className="truncate text-foreground/80">{j.label}</span>
                </div>
                <span className="shrink-0 tabular-nums text-muted-foreground">{rowLabel(j)}</span>
              </div>
            ))}
          </div>
        )}

        {pending > 0 && !allDone && <p className="text-xs text-muted-foreground">{pending} more queued…</p>}
        {failed > 0 && <FailureBlock jobs={group.jobs.filter((j) => j.status === 'failed')} retrying={retrying} onRetry={onRetry} onDismiss={onDismiss} />}
        {allDone && (
          <p className="flex items-center gap-1.5 text-xs text-success">
            <CheckCircle2 className="size-3.5 shrink-0" /> Everything is ready.
          </p>
        )}
      </div>
    </CardShell>
  )
}

function LibraryCard({ group, onCancel, retrying, onRetry, onDismiss, showMinimize, onMinimize }: { group: JobGroup; onCancel: (id: string) => Promise<void>; retrying: boolean; onRetry: () => void; onDismiss: () => void; showMinimize: boolean; onMinimize: () => void }) {
  const failed = group.counts.failed
  const allDone = group.active === 0 && failed === 0
  const running = group.jobs.filter((j) => j.status === 'running')
  const pending = group.counts.pending

  // Honest aggregate readout: GB done / GB total · speed · ETA.
  const sizeLine = group.totalBytes > 0
    ? `${fmtBytes(group.downloadedBytes)} of ${fmtBytes(group.totalBytes)}`
    : null
  const speedLine = group.speedBps > 0 ? `${fmtBytes(group.speedBps)}/s` : null
  const etaLine = fmtEta(group.etaSeconds)

  const rowDetail = (j: JobInfo) => {
    const p = j.progress
    if (p?.note && !(p.total > 0)) return p.note
    if (p && p.total > 0) {
      const pct = Math.round((p.completed / p.total) * 100)
      const spd = p.speedBps > 0 ? ` · ${fmtBytes(p.speedBps)}/s` : ''
      return `${pct}% of ${fmtBytes(p.total)}${spd}`
    }
    return 'starting…'
  }

  return (
    <CardShell>
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Library className="size-4 text-brand" />
          {allDone ? 'Library ready' : 'Downloading library'}
        </div>
        {showMinimize && (
          <button type="button" onClick={onMinimize} className="text-muted-foreground hover:text-foreground" aria-label="Minimize">
            <ChevronDown className="size-4" />
          </button>
        )}
      </div>
      <div className="px-4 py-3 space-y-2.5">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{group.counts.completed} of {group.counts.total} ready</span>
          <span className="font-semibold text-foreground">{group.pct}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className={cn('h-full rounded-full transition-[width] duration-500', failed > 0 ? 'bg-warning' : 'bg-brand')} style={{ width: `${group.pct}%` }} />
        </div>

        {!allDone && (sizeLine || speedLine || etaLine) && (
          <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground tabular-nums">
            {sizeLine && <span>{sizeLine}</span>}
            {speedLine && <span className="text-foreground/70">{speedLine}</span>}
            {etaLine && <span>{etaLine}</span>}
          </p>
        )}

        {running.length > 0 && (
          <div className="space-y-1.5 pt-0.5">
            {running.slice(0, 3).map((j) => (
              <div key={j.id} className="flex items-center gap-2 text-xs group">
                <Spinner size="sm" className="size-3 shrink-0 text-brand" />
                <div className="min-w-0 flex-1 overflow-hidden">
                  <div className="truncate text-foreground/80">{j.label}</div>
                  <div className="truncate text-[10px] text-muted-foreground tabular-nums">{rowDetail(j)}</div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => { void onCancel(j.id) }}
                  className="size-5 shrink-0 text-muted-foreground/60 hover:text-foreground"
                  aria-label={`Cancel ${j.label}`}
                  title="Cancel this download"
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {pending > 0 && !allDone && <p className="text-xs text-muted-foreground">{pending} more queued…</p>}
        {failed > 0 && <FailureBlock jobs={group.jobs.filter((j) => j.status === 'failed')} retrying={retrying} onRetry={onRetry} onDismiss={onDismiss} />}
        {allDone && (
          <p className="flex items-center gap-1.5 text-xs text-success">
            <CheckCircle2 className="size-3.5 shrink-0" /> Library downloads finished.
          </p>
        )}
      </div>
    </CardShell>
  )
}
