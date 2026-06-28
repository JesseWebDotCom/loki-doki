import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlarmClock, Plus, Trash2, Loader2, Save, X, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { toast } from '@/lib/toast'
import { opts, JSON_HEADERS, getJSON, audioUrl, type AlarmRow, type ChimeRow } from '@/lib/pod/layout'

interface DeviceRow { id: string; name: string; userId: string }
const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

// Centralised, server-owned alarms (§8): created here or in the Time app, fired by the
// server engine to the target devices, with snooze/cancel coordinated across devices.
export function DeviceAlarmsPanel({ id }: { id?: string }) {
  const qc = useQueryClient()
  const { data: alarms = [] } = useQuery({ queryKey: ['pod-alarms'], queryFn: () => getJSON<AlarmRow[]>('/api/pod/studio/alarms') })
  const { data: devices = [] } = useQuery({ queryKey: ['pod-devices'], queryFn: () => getJSON<DeviceRow[]>('/api/pod/devices') })
  const { data: chimes = [] } = useQuery({ queryKey: ['pod-chimes'], queryFn: () => getJSON<ChimeRow[]>('/api/pod/studio/chimes') })
  const alarmTones = chimes.filter((c) => c.category === 'alarm')
  const [edit, setEdit] = useState<AlarmRow | 'new' | null>(null)
  const [del, setDel] = useState<AlarmRow | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['pod-alarms'] })
  const deviceName = (i: string) => devices.find((d) => d.id === i)?.name ?? i

  return (
    <section id={id} className="space-y-4 rounded-3xl border border-border/40 bg-card p-5 scroll-mt-20">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl" style={{ backgroundImage: 'linear-gradient(135deg,#fb7185,#e11d48)' }}><AlarmClock className="size-5 text-white" /></div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold">Alarms</h3>
          <p className="text-sm text-muted-foreground">Server-owned alarms that ring on your screen devices. Snooze/cancel on one device quiets the rest. These also appear in the Time app.</p>
        </div>
        <Button size="sm" onClick={() => setEdit('new')}><Plus className="size-4" /> New alarm</Button>
      </div>

      {alarms.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No alarms yet.</p>
      ) : (
        <div className="space-y-2">
          {alarms.map((a) => (
            <div key={a.id} className="flex items-center gap-3 rounded-2xl border border-border/40 bg-background/40 px-4 py-3">
              <div className="w-20 text-2xl font-semibold tabular-nums">{String(((a.hour % 12) || 12)).padStart(2, ' ')}:{String(a.minute).padStart(2, '0')}<span className="ml-1 text-xs text-muted-foreground">{a.hour < 12 ? 'AM' : 'PM'}</span></div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{a.label} <span className="text-muted-foreground">· {a.userName}</span></p>
                <p className="truncate text-xs text-muted-foreground">
                  {a.repeatDays.length ? a.repeatDays.map((d) => DAYS[d]).join(' ') : 'One time'}
                  {' · '}{a.targets?.length ? a.targets.map(deviceName).join(', ') : 'All devices'}
                  {a.toneName ? ` · ${a.toneName}` : ''}
                </p>
              </div>
              <span className={`rounded-full px-2 py-0.5 text-[10px] ${a.enabled ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground'}`}>{a.enabled ? 'On' : 'Off'}</span>
              <Button size="sm" variant="ghost" className="text-xs" onClick={() => setEdit(a)}>Edit</Button>
              <Button size="icon" variant="ghost" className="size-8 text-muted-foreground hover:text-destructive" onClick={() => setDel(a)}><Trash2 className="size-4" /></Button>
            </div>
          ))}
        </div>
      )}

      {edit && <AlarmEditor alarm={edit === 'new' ? null : edit} devices={devices} alarmTones={alarmTones} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refresh() }} />}
      <ConfirmDialog
        open={!!del} onOpenChange={(o) => { if (!o) setDel(null) }} title="Delete this alarm?" destructive confirmLabel="Delete"
        description={del ? `"${del.label}" will be removed.` : undefined}
        onConfirm={async () => { if (del) { const r = await fetch(`/api/pod/studio/alarms/${del.id}`, { ...opts, method: 'DELETE' }); if (r.ok) { toast.success('Alarm deleted'); refresh() } else toast.error('Delete failed') } setDel(null) }}
      />
    </section>
  )
}

function AlarmEditor({ alarm, devices, alarmTones, onClose, onSaved }: { alarm: AlarmRow | null; devices: DeviceRow[]; alarmTones: ChimeRow[]; onClose: () => void; onSaved: () => void }) {
  const isNew = !alarm
  const [label, setLabel] = useState(alarm?.label ?? 'Alarm')
  const [hour, setHour] = useState(alarm?.hour ?? 7)
  const [minute, setMinute] = useState(alarm?.minute ?? 0)
  const [repeat, setRepeat] = useState<number[]>(alarm?.repeatDays ?? [])
  const [enabled, setEnabled] = useState(alarm?.enabled ?? true)
  const [targets, setTargets] = useState<string[]>(alarm?.targets ?? [])
  const [toneId, setToneId] = useState<string | null>(alarm?.toneId ?? null)
  const [snooze, setSnooze] = useState(alarm?.snoozeMinutes ?? 9)
  const [busy, setBusy] = useState(false)

  const toggleDay = (d: number) => setRepeat((r) => (r.includes(d) ? r.filter((x) => x !== d) : [...r, d].sort()))
  const toggleTarget = (id: string) => setTargets((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]))

  async function save() {
    setBusy(true)
    try {
      const toneName = toneId ? alarmTones.find((t) => t.id === toneId)?.name ?? null : null
      const body = JSON.stringify({ label: label.trim(), hour, minute, repeatDays: repeat, enabled, targets, toneId, toneName, snoozeMinutes: snooze })
      const url = isNew ? '/api/pod/studio/alarms' : `/api/pod/studio/alarms/${alarm!.id}`
      const r = await fetch(url, { ...opts, method: isNew ? 'POST' : 'PUT', headers: JSON_HEADERS, body })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Save failed')
      toast.success('Alarm saved'); onSaved()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Save failed') } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-lg space-y-4 rounded-3xl border border-border/50 bg-card p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold">{isNew ? 'New alarm' : 'Edit alarm'}</h3>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}><X className="size-4" /></Button>
            <Button size="sm" onClick={save} disabled={busy}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save</Button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label" className="flex-1" />
          <input type="number" min={0} max={23} value={hour} onChange={(e) => setHour(Math.max(0, Math.min(23, Number(e.target.value))))} className="h-9 w-16 rounded-md border border-input bg-background px-2 text-center text-sm" />
          <span>:</span>
          <input type="number" min={0} max={59} value={minute} onChange={(e) => setMinute(Math.max(0, Math.min(59, Number(e.target.value))))} className="h-9 w-16 rounded-md border border-input bg-background px-2 text-center text-sm" />
          <label className="ml-2 flex items-center gap-1.5 text-xs text-muted-foreground">On <Switch checked={enabled} onCheckedChange={setEnabled} /></label>
        </div>

        <div>
          <p className="mb-1 text-xs text-muted-foreground">Repeat</p>
          <div className="flex gap-1">
            {DAYS.map((d, i) => <button key={i} onClick={() => toggleDay(i)} className={`size-9 rounded-full text-xs font-medium ${repeat.includes(i) ? 'bg-brand text-white' : 'bg-background/60 text-muted-foreground'}`}>{d}</button>)}
          </div>
        </div>

        <div>
          <p className="mb-1 text-xs text-muted-foreground">Ring on devices {targets.length === 0 && <span>(all of the owner’s devices)</span>}</p>
          <div className="flex flex-wrap gap-1.5">
            {devices.length === 0 && <span className="text-sm text-muted-foreground">No devices</span>}
            {devices.map((d) => <button key={d.id} onClick={() => toggleTarget(d.id)} className={`rounded-lg border px-2.5 py-1 text-xs ${targets.includes(d.id) ? 'border-brand bg-brand/10 text-foreground' : 'border-border/50 text-muted-foreground'}`}>{d.name}</button>)}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <label className="flex-1 text-xs text-muted-foreground">Tone
            <select value={toneId ?? ''} onChange={(e) => setToneId(e.target.value || null)} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              <option value="">Device default</option>
              {alarmTones.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          {toneId && <button onClick={() => new Audio(audioUrl(toneId)!).play().catch(() => {})} className="mt-5 flex size-9 items-center justify-center rounded-full bg-brand/15 text-brand"><Play className="size-4" /></button>}
          <label className="w-28 text-xs text-muted-foreground">Snooze (min)
            <input type="number" min={1} max={60} value={snooze} onChange={(e) => setSnooze(Math.max(1, Math.min(60, Number(e.target.value))))} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm" />
          </label>
        </div>
      </div>
    </div>
  )
}
