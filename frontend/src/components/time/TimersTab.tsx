import { useState } from 'react'
import { Timer as TimerIcon, Plus, Play, Pause, Pencil, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useTimeApp } from '@/context/TimeAlarmContext'
import { useNow } from '@/hooks/useNow'
import { TimerEditorDialog } from '@/components/time/TimerEditorDialog'
import { formatCountdown, formatDurationLabel } from '@/lib/time/format'
import { toneDisplayName, DEFAULT_TIMER_TONE } from '@/lib/time/tones'
import type { ClockTimer } from '@/lib/time/api'

const SELECT_CLS = 'rounded-lg border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand'

export function TimersTab() {
  const { timers, running, startTimer, pauseTimer, resumeTimer, cancelTimer, removeTimerPreset } = useTimeApp()
  const now = useNow(250)

  const [qh, setQh] = useState(0)
  const [qm, setQm] = useState(5)
  const [qs, setQs] = useState(0)

  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<ClockTimer | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const quickDuration = qh * 3600 + qm * 60 + qs

  function startQuick() {
    if (quickDuration < 1) return
    startTimer({ label: 'Timer', tone: DEFAULT_TIMER_TONE, announce: true, durationSec: quickDuration })
  }

  return (
    <div className="space-y-6">
      {/* Running timers */}
      {running.length > 0 && (
        <div className="space-y-2.5">
          {running.map((t) => {
            const remainingMs = t.paused ? t.remainingMs : Math.max(0, (t.endsAt ?? now) - now)
            const pct = Math.max(0, Math.min(100, (remainingMs / (t.durationSec * 1000)) * 100))
            return (
              <div key={t.id} className="rounded-2xl border border-border/60 bg-card px-4 py-3.5">
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-muted-foreground">{t.label}</p>
                    <p className="text-4xl font-light tabular-nums tracking-tight">{formatCountdown(remainingMs)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="icon" variant="outline" onClick={() => (t.paused ? resumeTimer(t.id) : pauseTimer(t.id))} aria-label={t.paused ? 'Resume' : 'Pause'}>
                      {t.paused ? <Play className="size-4" /> : <Pause className="size-4" />}
                    </Button>
                    <Button size="icon" variant="outline" onClick={() => cancelTimer(t.id)} aria-label="Cancel timer">
                      <X className="size-4" />
                    </Button>
                  </div>
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-foreground/8">
                  <div className={cn('h-full rounded-full bg-brand transition-[width] duration-200', t.paused && 'opacity-50')} style={{ width: `${pct}%` }} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Quick start */}
      <div className="rounded-2xl border border-border/60 bg-card p-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Quick timer</p>
        <div className="flex flex-wrap items-end gap-2">
          {([['hours', qh, setQh, 24], ['min', qm, setQm, 60], ['sec', qs, setQs, 60]] as const).map(([lbl, val, set, count]) => (
            <div key={lbl} className="flex flex-col items-center gap-1">
              <select className={SELECT_CLS} value={val} onChange={(e) => set(Number(e.target.value))}>
                {Array.from({ length: count }, (_, i) => i).map((n) => <option key={n} value={n}>{String(n).padStart(2, '0')}</option>)}
              </select>
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{lbl}</span>
            </div>
          ))}
          <Button className="ml-auto" onClick={startQuick} disabled={quickDuration < 1}><Play className="size-4" /> Start</Button>
        </div>
      </div>

      {/* Saved presets */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Saved timers</p>
          <Button size="sm" variant="outline" onClick={() => { setEditing(null); setEditorOpen(true) }}><Plus className="size-4" /> Add timer</Button>
        </div>

        {timers.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-border/60 bg-card/40 py-10 text-center">
            <TimerIcon className="size-9 text-muted-foreground/60" />
            <p className="text-sm text-muted-foreground">Save a named timer to start it with one tap.</p>
          </div>
        ) : (
          timers.map((t) => (
            <div key={t.id} className="group flex items-center gap-3 rounded-2xl border border-border/60 bg-card px-4 py-3">
              <Button size="icon" variant="outline" onClick={() => startTimer({ label: t.label, tone: t.tone, toneName: t.toneName, announce: t.announce, durationSec: t.durationSec })} aria-label={`Start ${t.label}`}>
                <Play className="size-4" />
              </Button>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{t.label}</p>
                <p className="truncate text-xs text-muted-foreground">{formatDurationLabel(t.durationSec)} · {toneDisplayName(t.tone, t.toneName)}</p>
              </div>
              <button onClick={() => { setEditing(t); setEditorOpen(true) }} className="text-muted-foreground/0 transition-colors hover:text-foreground group-hover:text-muted-foreground" aria-label="Edit timer">
                <Pencil className="size-4" />
              </button>
              <button onClick={() => setDeleteId(t.id)} className="text-muted-foreground/0 transition-colors hover:text-destructive group-hover:text-muted-foreground" aria-label="Delete timer">
                <Trash2 className="size-4" />
              </button>
            </div>
          ))
        )}
      </div>

      <TimerEditorDialog open={editorOpen} onOpenChange={setEditorOpen} timer={editing} />

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={(o) => { if (!o) setDeleteId(null) }}
        title="Delete this timer?"
        description="This saved timer will be permanently removed."
        confirmLabel="Delete"
        destructive
        onConfirm={() => { if (deleteId) { void removeTimerPreset(deleteId); setDeleteId(null) } }}
      />
    </div>
  )
}
