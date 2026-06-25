import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/cn'
import { useTimeApp } from '@/context/TimeAlarmContext'
import { TonePicker } from '@/components/time/TonePicker'
import { DEFAULT_TIMER_TONE, toneDisplayName } from '@/lib/time/tones'
import { splitDuration } from '@/lib/time/format'
import type { ClockTimer } from '@/lib/time/api'

const SELECT_CLS = 'rounded-lg border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand'

export function TimerEditorDialog({ open, onOpenChange, timer }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  timer?: ClockTimer | null
}) {
  const { saveTimerPreset } = useTimeApp()
  const [label, setLabel] = useState('Timer')
  const [h, setH] = useState(0)
  const [m, setM] = useState(5)
  const [s, setS] = useState(0)
  const [tone, setTone] = useState(DEFAULT_TIMER_TONE)
  const [toneName, setToneName] = useState<string | null>(null)
  const [announce, setAnnounce] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    if (timer) {
      const d = splitDuration(timer.durationSec)
      setLabel(timer.label); setH(d.h); setM(d.m); setS(d.s)
      setTone(timer.tone); setToneName(timer.toneName); setAnnounce(timer.announce)
    } else {
      setLabel('Timer'); setH(0); setM(5); setS(0)
      setTone(DEFAULT_TIMER_TONE); setToneName(null); setAnnounce(true)
    }
  }, [open, timer])

  const durationSec = h * 3600 + m * 60 + s

  async function handleSave() {
    if (durationSec < 1) return
    setSaving(true)
    await saveTimerPreset({
      label: label.trim() || 'Timer', durationSec, tone, toneName, announce,
    }, timer?.id)
    setSaving(false)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{timer ? 'Edit timer' : 'New timer'}</DialogTitle>
          <DialogDescription className="sr-only">Set the timer duration and label.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-end justify-center gap-2">
            {([['hours', h, setH, 24], ['min', m, setM, 60], ['sec', s, setS, 60]] as const).map(([lbl, val, set, count]) => (
              <div key={lbl} className="flex flex-col items-center gap-1">
                <select className={cn(SELECT_CLS, 'text-base')} value={val} onChange={(e) => set(Number(e.target.value))}>
                  {Array.from({ length: count }, (_, i) => i).map((n) => <option key={n} value={n}>{String(n).padStart(2, '0')}</option>)}
                </select>
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{lbl}</span>
              </div>
            ))}
          </div>

          <div className="space-y-1.5">
            <Label>Label</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Timer" maxLength={80} />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>Companion announcement</Label>
              <p className="text-xs text-muted-foreground">Your companion says a line when it's done.</p>
            </div>
            <Switch checked={announce} onCheckedChange={setAnnounce} />
          </div>

          <div className="space-y-1.5">
            <Label>Sound — {toneDisplayName(tone, toneName)}</Label>
            <TonePicker value={tone} onChange={(t, n) => { setTone(t); setToneName(n) }} />
          </div>
        </div>

        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => void handleSave()} disabled={saving || durationSec < 1}>{timer ? 'Save' : 'Add timer'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
