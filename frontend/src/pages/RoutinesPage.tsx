import { useCallback, useEffect, useState } from 'react'
import { MessageSquare, Pencil, Play, Plus, Trash2, Webhook, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { PageContainer } from '@/components/shared/PageContainer'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { cn } from '@/lib/cn'

// ── Types (mirror backend lib/routines/types.ts) ──────────────────────────────

type Trigger =
  | { type: 'time'; time: string; days?: number[] }
  | { type: 'ha-state'; entityId: string; to?: string; from?: string }
  | { type: 'frigate'; camera?: string; label?: string; startHour?: number; endHour?: number }
  | { type: 'service'; monitor?: string; event?: 'down' | 'up' }
  | { type: 'webhook'; token: string }

type Action =
  | { type: 'notify'; title: string; body?: string }
  | { type: 'announce'; text: string }
  | { type: 'ha-action'; action: string; entityIds: string[]; brightnessPct?: number }
  | { type: 'ask-companion'; prompt: string; deliver?: 'notify' | 'announce' }

interface Routine {
  id: string
  name: string
  enabled: boolean
  trigger: Trigger | null
  actions: Action[]
  triggerSummary: string
  actionSummaries: string[]
  createdVia: string
  lastRunAt: string | null
  lastResult: string | null
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/routines${path}`, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  try {
    return (await r.json()) as T
  } catch {
    throw new Error(`Unexpected response (${r.status})`)
  }
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const TRIGGER_OPTIONS = [
  { value: 'time', label: 'At a time of day' },
  { value: 'ha-state', label: 'When a device changes' },
  { value: 'frigate', label: 'When a camera sees something' },
  { value: 'service', label: 'When a service goes down or up' },
  { value: 'webhook', label: 'When a webhook is called' },
] as const

const ACTION_OPTIONS = [
  { value: 'notify', label: 'Send a notification' },
  { value: 'announce', label: 'Announce out loud' },
  { value: 'ha-action', label: 'Control a home device' },
  { value: 'ask-companion', label: 'Ask the companion' },
] as const

const HA_ACTIONS = ['turn_on', 'turn_off', 'toggle', 'set_brightness', 'lock', 'open', 'close'] as const

function emptyAction(type: Action['type']): Action {
  switch (type) {
    case 'notify': return { type: 'notify', title: '' }
    case 'announce': return { type: 'announce', text: '' }
    case 'ha-action': return { type: 'ha-action', action: 'turn_on', entityIds: [] }
    case 'ask-companion': return { type: 'ask-companion', prompt: '', deliver: 'notify' }
  }
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function RoutinesPage() {
  usePublishUIContext({
    label: 'Routines',
    description: 'User is on the Routines page, managing when-this-then-that automations.',
  })
  useAppHeader({ query: '', setQuery: () => {}, searchable: false })

  const [routines, setRoutines] = useState<Routine[]>([])
  const [loading, setLoading] = useState(true)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<Routine | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Routine | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api<{ routines: Routine[] }>('')
      setRoutines(res.routines ?? [])
    } catch {
      toast.error('Could not load routines')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function toggle(routine: Routine, enabled: boolean) {
    setRoutines((rs) => rs.map((r) => (r.id === routine.id ? { ...r, enabled } : r)))
    const res = await api<{ ok: boolean; error?: string }>(`/${routine.id}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    })
    if (!res.ok) {
      toast.error(res.error ?? 'Could not update the routine')
      await load()
    }
  }

  async function runNow(routine: Routine) {
    const res = await api<{ ok: boolean; error?: string }>(`/${routine.id}/run`, { method: 'POST' })
    if (res.ok) toast.success(`Running "${routine.name}"`)
    else toast.error(res.error ?? 'Could not run the routine')
    window.setTimeout(() => { void load() }, 2500)
  }

  async function handleDelete() {
    if (!deleteTarget) return
    const res = await api<{ ok: boolean; error?: string }>(`/${deleteTarget.id}`, { method: 'DELETE' })
    setDeleteTarget(null)
    if (!res.ok) toast.error(res.error ?? 'Could not delete the routine')
    await load()
  }

  return (
    <PageShell>
      <PageContainer className="pb-24">
        <PageHeader subtitle="When this happens, do that. Runs on the server, even when nobody is home." />

        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MessageSquare className="size-4 shrink-0" />
            <span>Tip: just ask your companion. "Every weekday at 7am, give me a morning briefing."</span>
          </div>
          <Button size="sm" onClick={() => { setEditing(null); setEditorOpen(true) }}>
            <Plus className="size-4" /> New routine
          </Button>
        </div>

        {loading && <div className="flex justify-center py-12"><Spinner /></div>}

        {!loading && routines.length === 0 && (
          <div className="rounded-card border border-border bg-card p-8 text-center space-y-2">
            <Zap className="size-8 mx-auto text-brand" />
            <div className="font-medium">No routines yet</div>
            <p className="text-sm text-muted-foreground">
              Create one here, or describe it to your companion in chat and approve what it drafts.
            </p>
          </div>
        )}

        <div className="space-y-3">
          {routines.map((routine) => (
            <div key={routine.id} className="rounded-card border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{routine.name}</span>
                    {routine.createdVia === 'companion' && (
                      <span className="text-xs rounded-full border border-border px-2 py-0.5 text-muted-foreground shrink-0">From chat</span>
                    )}
                    {routine.lastResult === 'error' && (
                      <span className="text-xs text-destructive shrink-0">Last run failed</span>
                    )}
                  </div>
                  <div className="text-sm text-muted-foreground mt-1">{routine.triggerSummary}</div>
                  <ul className="text-sm text-muted-foreground/90 mt-1 space-y-0.5">
                    {routine.actionSummaries.map((s, i) => (
                      <li key={i} className="truncate">• {s}</li>
                    ))}
                  </ul>
                  {routine.trigger?.type === 'webhook' && (
                    <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Webhook className="size-3.5 shrink-0" />
                      <code className="truncate">{`${window.location.origin}/api/routines/hook/${routine.id}?token=${routine.trigger.token}`}</code>
                    </div>
                  )}
                  {routine.lastRunAt && (
                    <div className="text-xs text-muted-foreground mt-2">
                      Last ran {new Date(routine.lastRunAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="icon" variant="ghost" aria-label="Run now" onClick={() => void runNow(routine)}>
                    <Play className="size-4" />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label="Edit routine" onClick={() => { setEditing(routine); setEditorOpen(true) }}>
                    <Pencil className="size-4" />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label="Delete routine" onClick={() => setDeleteTarget(routine)}>
                    <Trash2 className="size-4 text-muted-foreground" />
                  </Button>
                  <Switch
                    checked={routine.enabled}
                    onCheckedChange={(v) => void toggle(routine, v)}
                    aria-label={`Enable ${routine.name}`}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>

        <RoutineEditor
          open={editorOpen}
          onOpenChange={setEditorOpen}
          routine={editing}
          onSaved={() => { setEditorOpen(false); void load() }}
        />
        <ConfirmDialog
          open={deleteTarget != null}
          onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
          title="Delete this routine?"
          description={deleteTarget ? `"${deleteTarget.name}" will stop running. This cannot be undone.` : ''}
          confirmLabel="Delete"
          destructive
          onConfirm={() => void handleDelete()}
        />
      </PageContainer>
    </PageShell>
  )
}

// ── Editor dialog ─────────────────────────────────────────────────────────────

function RoutineEditor({ open, onOpenChange, routine, onSaved }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  routine: Routine | null
  onSaved: () => void
}) {
  const [name, setName] = useState('')
  const [trigger, setTrigger] = useState<Trigger>({ type: 'time', time: '08:00' })
  const [actions, setActions] = useState<Action[]>([emptyAction('notify')])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(routine?.name ?? '')
    setTrigger(routine?.trigger ?? { type: 'time', time: '08:00' })
    setActions(routine?.actions?.length ? routine.actions : [emptyAction('notify')])
  }, [open, routine])

  function setTriggerType(type: Trigger['type']) {
    switch (type) {
      case 'time': setTrigger({ type: 'time', time: '08:00' }); break
      case 'ha-state': setTrigger({ type: 'ha-state', entityId: '' }); break
      case 'frigate': setTrigger({ type: 'frigate', label: 'person' }); break
      case 'service': setTrigger({ type: 'service', event: 'down' }); break
      case 'webhook': setTrigger({ type: 'webhook', token: '' }); break
    }
  }

  function updateAction(index: number, next: Action) {
    setActions((list) => list.map((a, i) => (i === index ? next : a)))
  }

  async function save() {
    if (!name.trim()) {
      toast.error('Give the routine a name')
      return
    }
    setSaving(true)
    try {
      const body = JSON.stringify({ name: name.trim(), trigger, actions })
      const res = routine
        ? await api<{ ok: boolean; error?: string }>(`/${routine.id}`, { method: 'PUT', body })
        : await api<{ ok: boolean; error?: string }>('', { method: 'POST', body })
      if (!res.ok) {
        toast.error(res.error ?? 'Could not save the routine')
        return
      }
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  const selectClass = 'h-9 rounded-control border border-input bg-transparent px-2.5 text-sm'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{routine ? 'Edit routine' : 'New routine'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          <label className="block space-y-1.5 text-sm">
            <span className="text-muted-foreground">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning briefing" />
          </label>

          {/* ── Trigger ── */}
          <div className="space-y-2.5">
            <div className="text-sm font-medium">When</div>
            <select className={cn(selectClass, 'w-full')} value={trigger.type} onChange={(e) => setTriggerType(e.target.value as Trigger['type'])}>
              {TRIGGER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>

            {trigger.type === 'time' && (
              <div className="space-y-2">
                <Input type="time" className="w-32" value={trigger.time}
                  onChange={(e) => setTrigger({ ...trigger, time: e.target.value })} />
                <div className="flex flex-wrap gap-1.5">
                  {DAY_LABELS.map((label, day) => {
                    const active = !trigger.days || trigger.days.includes(day)
                    return (
                      <button
                        key={day}
                        type="button"
                        className={cn(
                          'px-2.5 py-1 rounded-full text-xs border transition-colors',
                          active ? 'border-brand bg-brand/15 text-foreground' : 'border-border text-muted-foreground',
                        )}
                        onClick={() => {
                          const current = trigger.days ?? [0, 1, 2, 3, 4, 5, 6]
                          const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort()
                          setTrigger({ ...trigger, days: next.length === 7 ? undefined : next })
                        }}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {trigger.type === 'ha-state' && (
              <div className="grid grid-cols-2 gap-2">
                <Input className="col-span-2" placeholder="Entity id, e.g. binary_sensor.front_door" value={trigger.entityId}
                  onChange={(e) => setTrigger({ ...trigger, entityId: e.target.value })} />
                <Input placeholder="Becomes (e.g. on)" value={trigger.to ?? ''}
                  onChange={(e) => setTrigger({ ...trigger, to: e.target.value || undefined })} />
                <Input placeholder="From (optional)" value={trigger.from ?? ''}
                  onChange={(e) => setTrigger({ ...trigger, from: e.target.value || undefined })} />
              </div>
            )}

            {trigger.type === 'frigate' && (
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder="Camera (blank = any)" value={trigger.camera ?? ''}
                  onChange={(e) => setTrigger({ ...trigger, camera: e.target.value || undefined })} />
                <Input placeholder="Label, e.g. person" value={trigger.label ?? ''}
                  onChange={(e) => setTrigger({ ...trigger, label: e.target.value || undefined })} />
                <Input type="number" min={0} max={23} placeholder="From hour" value={trigger.startHour ?? ''}
                  onChange={(e) => setTrigger({ ...trigger, startHour: e.target.value === '' ? undefined : Number(e.target.value) })} />
                <Input type="number" min={0} max={23} placeholder="To hour" value={trigger.endHour ?? ''}
                  onChange={(e) => setTrigger({ ...trigger, endHour: e.target.value === '' ? undefined : Number(e.target.value) })} />
              </div>
            )}

            {trigger.type === 'service' && (
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder="Monitor name (blank = any)" value={trigger.monitor ?? ''}
                  onChange={(e) => setTrigger({ ...trigger, monitor: e.target.value || undefined })} />
                <select className={selectClass} value={trigger.event ?? 'down'}
                  onChange={(e) => setTrigger({ ...trigger, event: e.target.value as 'down' | 'up' })}>
                  <option value="down">Goes down</option>
                  <option value="up">Comes back up</option>
                </select>
              </div>
            )}

            {trigger.type === 'webhook' && (
              <p className="text-xs text-muted-foreground">
                The webhook URL (with its secret token) appears on the routine card after saving.
              </p>
            )}
          </div>

          {/* ── Actions ── */}
          <div className="space-y-2.5">
            <div className="text-sm font-medium">Do</div>
            {actions.map((action, i) => (
              <div key={i} className="rounded-card border border-border p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <select className={cn(selectClass, 'flex-1')} value={action.type}
                    onChange={(e) => updateAction(i, emptyAction(e.target.value as Action['type']))}>
                    {ACTION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  {actions.length > 1 && (
                    <Button size="icon" variant="ghost" aria-label="Remove action"
                      onClick={() => setActions((list) => list.filter((_, idx) => idx !== i))}>
                      <Trash2 className="size-4 text-muted-foreground" />
                    </Button>
                  )}
                </div>

                {action.type === 'notify' && (
                  <div className="space-y-2">
                    <Input placeholder="Title" value={action.title}
                      onChange={(e) => updateAction(i, { ...action, title: e.target.value })} />
                    <Input placeholder="Message (optional)" value={action.body ?? ''}
                      onChange={(e) => updateAction(i, { ...action, body: e.target.value || undefined })} />
                  </div>
                )}
                {action.type === 'announce' && (
                  <Input placeholder="What to say out loud" value={action.text}
                    onChange={(e) => updateAction(i, { ...action, text: e.target.value })} />
                )}
                {action.type === 'ha-action' && (
                  <div className="space-y-2">
                    <select className={cn(selectClass, 'w-full')} value={action.action}
                      onChange={(e) => updateAction(i, { ...action, action: e.target.value })}>
                      {HA_ACTIONS.map((a) => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}
                    </select>
                    <Input placeholder="Entity ids, comma separated (light.porch, switch.fan)"
                      value={action.entityIds.join(', ')}
                      onChange={(e) => updateAction(i, { ...action, entityIds: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
                    {action.action === 'set_brightness' && (
                      <Input type="number" min={1} max={100} placeholder="Brightness %" value={action.brightnessPct ?? ''}
                        onChange={(e) => updateAction(i, { ...action, brightnessPct: e.target.value === '' ? undefined : Number(e.target.value) })} />
                    )}
                  </div>
                )}
                {action.type === 'ask-companion' && (
                  <div className="space-y-2">
                    <Input placeholder='e.g. "Summarize today’s weather and my news feeds"' value={action.prompt}
                      onChange={(e) => updateAction(i, { ...action, prompt: e.target.value })} />
                    <select className={cn(selectClass, 'w-full')} value={action.deliver ?? 'notify'}
                      onChange={(e) => updateAction(i, { ...action, deliver: e.target.value as 'notify' | 'announce' })}>
                      <option value="notify">Send the answer as a notification</option>
                      <option value="announce">Speak the answer out loud</option>
                    </select>
                  </div>
                )}
              </div>
            ))}
            {actions.length < 10 && (
              <Button size="sm" variant="outline" onClick={() => setActions((list) => [...list, emptyAction('notify')])}>
                <Plus className="size-4" /> Add action
              </Button>
            )}
          </div>
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? <Spinner className="size-4" /> : null} {routine ? 'Save changes' : 'Create routine'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
