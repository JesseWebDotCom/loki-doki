import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/cn'
import { useTimeApp } from '@/context/TimeAlarmContext'
import { TonePicker } from '@/components/time/TonePicker'
import { DEFAULT_ALARM_TONE, toneDisplayName } from '@/lib/time/tones'
import { WEEKDAYS } from '@/lib/time/format'
import type { ClockAlarm } from '@/lib/time/api'

const SELECT_CLS = 'rounded-lg border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand'
const SNOOZE_OPTS = [1, 3, 5, 9, 10, 15]

function to24(h12: number, ampm: 'AM' | 'PM'): number {
  if (ampm === 'AM') return h12 === 12 ? 0 : h12
  return h12 === 12 ? 12 : h12 + 12
}
function from24(h: number): { h12: number; ampm: 'AM' | 'PM' } {
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return { h12, ampm }
}

export function AlarmEditorDialog({ open, onOpenChange, alarm }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  alarm?: ClockAlarm | null
}) {
  const { saveAlarm } = useTimeApp()
  const [label, setLabel] = useState('Alarm')
  const [h12, setH12] = useState(7)
  const [minute, setMinute] = useState(0)
  const [ampm, setAmpm] = useState<'AM' | 'PM'>('AM')
  const [days, setDays] = useState<number[]>([])
  const [tone, setTone] = useState(DEFAULT_ALARM_TONE)
  const [toneName, setToneName] = useState<string | null>(null)
  const [announce, setAnnounce] = useState(true)
  const [snooze, setSnooze] = useState(9)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    if (alarm) {
      const { h12: hh, ampm: ap } = from24(alarm.hour)
      setLabel(alarm.label); setH12(hh); setMinute(alarm.minute); setAmpm(ap)
      setDays(alarm.repeatDays); setTone(alarm.tone); setToneName(alarm.toneName)
      setAnnounce(alarm.announce); setSnooze(alarm.snoozeMinutes)
    } else {
      setLabel('Alarm'); setH12(7); setMinute(0); setAmpm('AM')
      setDays([]); setTone(DEFAULT_ALARM_TONE); setToneName(null); setAnnounce(true); setSnooze(9)
    }
  }, [open, alarm])

  function toggleDay(d: number) {
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => a - b)))
  }

  async function handleSave() {
    setSaving(true)
    await saveAlarm({
      label: label.trim() || 'Alarm',
      hour: to24(h12, ampm), minute,
      repeatDays: days, enabled: true,
      tone, toneName, announce, snoozeMinutes: snooze,
    }, alarm?.id)
    setSaving(false)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{alarm ? 'Edit alarm' : 'New alarm'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center justify-center gap-2">
            <select className={cn(SELECT_CLS, 'text-base')} value={h12} onChange={(e) => setH12(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
            <span className="text-base font-semibold">:</span>
            <select className={cn(SELECT_CLS, 'text-base')} value={minute} onChange={(e) => setMinute(Number(e.target.value))}>
              {Array.from({ length: 60 }, (_, i) => i).map((m) => <option key={m} value={m}>{String(m).padStart(2, '0')}</option>)}
            </select>
            <select className={cn(SELECT_CLS, 'text-base')} value={ampm} onChange={(e) => setAmpm(e.target.value as 'AM' | 'PM')}>
              <option value="AM">AM</option>
              <option value="PM">PM</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <Label>Label</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Alarm" maxLength={80} />
          </div>

          <div className="space-y-1.5">
            <Label>Repeat</Label>
            <div className="flex gap-1.5">
              {WEEKDAYS.map((w, i) => (
                <button key={i} type="button" onClick={() => toggleDay(i)}
                  className={cn('flex size-9 items-center justify-center rounded-full text-xs font-semibold transition-colors',
                    days.includes(i) ? 'bg-brand text-brand-foreground' : 'bg-foreground/8 text-muted-foreground hover:bg-foreground/12')}>
                  {w[0]}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{days.length === 0 ? 'Rings once, then turns off.' : 'Repeats on the selected days.'}</p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>Companion announcement</Label>
              <p className="text-xs text-muted-foreground">Your companion says a line when it rings.</p>
            </div>
            <Switch checked={announce} onCheckedChange={setAnnounce} />
          </div>

          <div className="flex items-center justify-between">
            <Label>Snooze</Label>
            <select className={SELECT_CLS} value={snooze} onChange={(e) => setSnooze(Number(e.target.value))}>
              {SNOOZE_OPTS.map((m) => <option key={m} value={m}>{m} min</option>)}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label>Sound — {toneDisplayName(tone, toneName)}</Label>
            <TonePicker value={tone} onChange={(t, n) => { setTone(t); setToneName(n) }} />
          </div>
        </div>

        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => void handleSave()} disabled={saving}>{alarm ? 'Save' : 'Add alarm'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
