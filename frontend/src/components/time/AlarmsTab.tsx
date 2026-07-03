import { useState } from 'react'
import { AlarmClock, Plus, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/cn'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useTimeApp } from '@/context/TimeAlarmContext'
import { AlarmEditorDialog } from '@/components/time/AlarmEditorDialog'
import { repeatLabel } from '@/lib/time/format'
import { toneDisplayName } from '@/lib/time/tones'
import type { ClockAlarm } from '@/lib/time/api'

function timeLabel(h: number, m: number): { time: string; ampm: string } {
  const ampm = h >= 12 ? 'PM' : 'AM'
  const hr = h % 12 === 0 ? 12 : h % 12
  return { time: `${hr}:${String(m).padStart(2, '0')}`, ampm }
}

const WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

/** iOS-style repeat indicator: a "Once" pill for one-time alarms, otherwise the
 *  seven weekday letters with the active days highlighted (so daily = all lit,
 *  weekly = one lit, specific = those lit). Hover/`title` shows the worded label. */
function WeekdayPips({ days }: { days: number[] }) {
  if (days.length === 0) {
    return <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Once</span>
  }
  return (
    <div className="flex items-center gap-1" title={repeatLabel(days)}>
      {WEEKDAY_LETTERS.map((d, i) => (
        <span key={i} className={cn('flex size-4 items-center justify-center text-[11px] tabular-nums',
          days.includes(i) ? 'font-bold text-brand' : 'font-medium text-muted-foreground/30')}>
          {d}
        </span>
      ))}
    </div>
  )
}

export function AlarmsTab() {
  const { alarms, toggleAlarm, removeAlarm } = useTimeApp()
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<ClockAlarm | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)

  function openNew() { setEditing(null); setEditorOpen(true) }
  function openEdit(a: ClockAlarm) { setEditing(a); setEditorOpen(true) }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={openNew}><Plus className="size-4" /> Add alarm</Button>
      </div>

      {alarms.length === 0 ? (
        <Card variant="dashed" className="flex flex-col items-center gap-3 border-border/60 py-14 text-center">
          <AlarmClock className="size-10 text-muted-foreground/60" />
          <div>
            <p className="font-semibold">No alarms</p>
            <p className="text-sm text-muted-foreground">Add an alarm with a custom tone and a companion announcement.</p>
          </div>
          <Button size="sm" variant="outline" onClick={openNew}><Plus className="size-4" /> Add alarm</Button>
        </Card>
      ) : (
        <div className="space-y-2.5">
          {alarms.map((a) => {
            const t = timeLabel(a.hour, a.minute)
            return (
              <Card key={a.id} className="group flex items-center gap-3 border-border/60 px-4 py-3.5">
                <div className={cn('min-w-0 flex-1 space-y-1', !a.enabled && 'opacity-50')}>
                  <div className="tabular-nums">
                    <span className="text-3xl font-light tracking-tight">{t.time}</span>
                    <span className="ml-1 text-sm font-medium text-muted-foreground">{t.ampm}</span>
                  </div>
                  <WeekdayPips days={a.repeatDays} />
                  <p className="truncate text-xs text-muted-foreground">
                    {a.label} · {toneDisplayName(a.tone, a.toneName)}
                  </p>
                </div>
                <button onClick={() => openEdit(a)} className="text-muted-foreground/0 transition-colors hover:text-foreground group-hover:text-muted-foreground" aria-label="Edit alarm">
                  <Pencil className="size-4" />
                </button>
                <button onClick={() => setDeleteId(a.id)} className="text-muted-foreground/0 transition-colors hover:text-destructive group-hover:text-muted-foreground" aria-label="Delete alarm">
                  <Trash2 className="size-4" />
                </button>
                <Switch checked={a.enabled} onCheckedChange={(v) => void toggleAlarm(a.id, v)} />
              </Card>
            )
          })}
        </div>
      )}

      <AlarmEditorDialog open={editorOpen} onOpenChange={setEditorOpen} alarm={editing} />

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={(o) => { if (!o) setDeleteId(null) }}
        title="Delete this alarm?"
        description="This alarm will be permanently removed."
        confirmLabel="Delete"
        destructive
        onConfirm={() => { if (deleteId) { void removeAlarm(deleteId); setDeleteId(null) } }}
      />
    </div>
  )
}
