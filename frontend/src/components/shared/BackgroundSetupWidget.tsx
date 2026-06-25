import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Loader2, ChevronDown, ChevronUp, CheckCircle2, AlertTriangle, PackageOpen, RefreshCw, Library, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { fmtBytes } from '@/lib/youtube/format'
import { useSetupProgress, type JobInfo, type JobGroup } from '@/context/SetupProgressContext'
import { useAuth } from '@/context/AuthContext'
import { useYoutubePlayback } from '@/context/YoutubePlaybackContext'
import { useRadio } from '@/context/RadioContext'

// Corner card stack showing the background download queue. Two independent tracks:
//   • Setup    — runtimes/models/components the app needs (finishes in minutes)
//   • Library  — optional ZIM/map content that can be many GB (downloads honestly, never blocks)
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
  const { status, retryFailed, cancelJob } = useSetupProgress()
  const { user, welcomeComplete } = useAuth()
  const { pathname } = useLocation()
  const { track } = useYoutubePlayback()
  const { active: radioActive } = useRadio()
  const [minimized, setMinimized] = useState(false)
  const [retrying, setRetrying] = useState(false)
  // Shift up when a footer player (YouTube dock or AI Radio mini-bar) is visible so we don't overlap it.
  const bottomClass = track || radioActive ? 'bottom-20' : 'bottom-4'

  // Setup has its own inline progress; nothing to show before login or when idle/clean.
  if (!status || pathname.startsWith('/setup') || pathname.startsWith('/login')) return null
  // The admin's post-boot welcome wizard is a full-screen takeover — don't overlap it.
  if (user?.role === 'admin' && welcomeComplete === false) return null

  const setup = status.setup
  const content = status.content
  const showSetup = setup.active > 0 || setup.counts.failed > 0
  const showLibrary = content.active > 0 || content.counts.failed > 0
  if (!showSetup && !showLibrary) return null

  const onRetry = async () => { setRetrying(true); try { await retryFailed() } finally { setRetrying(false) } }

  if (minimized) {
    const allDone = status.active === 0
    return (
      <button
        type="button"
        onClick={() => setMinimized(false)}
        className={cn('fixed right-4 z-[120] transition-[bottom] duration-200 flex items-center gap-2 rounded-full border border-border/60 bg-card px-3.5 py-2 text-sm font-medium shadow-lg hover:bg-muted', bottomClass)}
      >
        {allDone ? <CheckCircle2 className="size-4 text-emerald-400" /> : <Loader2 className="size-4 animate-spin text-violet-400" />}
        {showLibrary && !showSetup ? 'Downloading library' : 'Setting up'} · {status.pct}%
        <ChevronUp className="size-3.5 text-muted-foreground" />
      </button>
    )
  }

  return (
    <div className={cn('fixed right-4 z-[120] transition-[bottom] duration-200 w-80 space-y-2.5', bottomClass)}>
      {showSetup && (
        <SetupCard group={setup} onMinimize={() => setMinimized(true)} retrying={retrying} onRetry={onRetry} />
      )}
      {showLibrary && (
        <LibraryCard group={content} onCancel={cancelJob} retrying={retrying} onRetry={onRetry} showMinimize={!showSetup} onMinimize={() => setMinimized(true)} />
      )}
    </div>
  )
}

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-xl animate-in slide-in-from-bottom-2">
      {children}
    </div>
  )
}

function FailureBlock({ jobs, retrying, onRetry }: { jobs: JobInfo[]; retrying: boolean; onRetry: () => void }) {
  const names = jobs.map((j) => j.label)
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
        onClick={onRetry}
        className="flex w-full items-center justify-center gap-1.5 rounded-md bg-amber-500/15 px-2 py-1.5 text-xs font-semibold text-amber-300 hover:bg-amber-500/25 disabled:opacity-50 transition-colors"
      >
        <RefreshCw className={cn('size-3.5', retrying && 'animate-spin')} />
        {retrying ? 'Retrying…' : 'Retry now'}
      </button>
    </div>
  )
}

function SetupCard({ group, onMinimize, retrying, onRetry }: { group: JobGroup; onMinimize: () => void; retrying: boolean; onRetry: () => void }) {
  const allDone = group.active === 0
  const failed = group.counts.failed
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
          <PackageOpen className="size-4 text-violet-400" />
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
          <div className={cn('h-full rounded-full transition-[width] duration-500', failed > 0 && allDone ? 'bg-amber-500' : 'bg-gradient-to-r from-violet-500 to-blue-400')} style={{ width: `${group.pct}%` }} />
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
                <span className="shrink-0 tabular-nums text-muted-foreground">{rowLabel(j)}</span>
              </div>
            ))}
          </div>
        )}

        {pending > 0 && !allDone && <p className="text-xs text-muted-foreground">{pending} more queued…</p>}
        {failed > 0 && <FailureBlock jobs={group.jobs.filter((j) => j.status === 'failed')} retrying={retrying} onRetry={onRetry} />}
        {allDone && failed === 0 && (
          <p className="flex items-center gap-1.5 text-xs text-emerald-400">
            <CheckCircle2 className="size-3.5 shrink-0" /> Everything is ready.
          </p>
        )}
      </div>
    </CardShell>
  )
}

function LibraryCard({ group, onCancel, retrying, onRetry, showMinimize, onMinimize }: { group: JobGroup; onCancel: (id: string) => Promise<void>; retrying: boolean; onRetry: () => void; showMinimize: boolean; onMinimize: () => void }) {
  const allDone = group.active === 0
  const failed = group.counts.failed
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
          <Library className="size-4 text-violet-400" />
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
          <div className={cn('h-full rounded-full transition-[width] duration-500', failed > 0 && allDone ? 'bg-amber-500' : 'bg-gradient-to-r from-violet-500 to-blue-400')} style={{ width: `${group.pct}%` }} />
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
                <Loader2 className="size-3 shrink-0 animate-spin text-violet-400" />
                <div className="min-w-0 flex-1 overflow-hidden">
                  <div className="truncate text-foreground/80">{j.label}</div>
                  <div className="truncate text-[10px] text-muted-foreground tabular-nums">{rowDetail(j)}</div>
                </div>
                <button
                  type="button"
                  onClick={() => { void onCancel(j.id) }}
                  className="shrink-0 rounded p-0.5 text-muted-foreground/60 hover:text-foreground hover:bg-muted"
                  aria-label={`Cancel ${j.label}`}
                  title="Cancel this download"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {pending > 0 && !allDone && <p className="text-xs text-muted-foreground">{pending} more queued…</p>}
        {failed > 0 && <FailureBlock jobs={group.jobs.filter((j) => j.status === 'failed')} retrying={retrying} onRetry={onRetry} />}
        {allDone && failed === 0 && (
          <p className="flex items-center gap-1.5 text-xs text-emerald-400">
            <CheckCircle2 className="size-3.5 shrink-0" /> Library downloads finished.
          </p>
        )}
      </div>
    </CardShell>
  )
}
