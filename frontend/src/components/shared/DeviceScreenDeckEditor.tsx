import { useEffect, useState } from 'react'
import {
  Loader2, Plus, Trash2, ChevronUp, ChevronDown, Lock, LayoutGrid, Clock, CloudSun,
  Moon, Music, MonitorPlay, AlertCircle, Settings2, ChevronRight,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/cn'

// Shared screen-deck editor — the single UI for "which screens does this device show, in
// what order" — used by BOTH Admin → Devices (asAdmin, never lock-gated) and the owner-facing
// Settings → Devices page (asAdmin=false, server enforces the two lock flags). Both surfaces
// read/write the exact same device_screens rows; there is no separate per-user override.
//
// Controller (the button-grid "stream deck") is deliberately just ONE screen kind here, same
// as an analog clock or a status screen — per the unified screen-deck design.

export interface DeckLocks { lockScreenSelection: boolean; lockScreenConfig: boolean }

interface DeckRow {
  id: string; deviceId: string; position: number
  screenId: string | null; kind: string; params: string; enabled: boolean
}
interface CatalogEntry { screenId: string; kind: string; name: string; renderer: 'lvgl' | 'jpeg'; builtin: boolean }

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }

const FIRMWARE_READY_KINDS = new Set(['clock-weather', 'controller', 'activity', 'status', 'sleeping'])

const KIND_META: Record<string, { label: string; icon: React.ReactNode }> = {
  'clock-weather': { label: 'Clock & Weather', icon: <CloudSun className="size-4" /> },
  'digital-clock': { label: 'Digital Clock', icon: <Clock className="size-4" /> },
  'analog-clock': { label: 'Analog Clock', icon: <Clock className="size-4" /> },
  'big-weather': { label: 'Big Weather', icon: <CloudSun className="size-4" /> },
  'nightstand': { label: 'Nightstand', icon: <Moon className="size-4" /> },
  'controller': { label: 'Controller', icon: <LayoutGrid className="size-4" /> },
  'activity': { label: 'Now Playing', icon: <Music className="size-4" /> },
  'status': { label: 'Status', icon: <AlertCircle className="size-4" /> },
  'sleeping': { label: 'Sleeping', icon: <Moon className="size-4" /> },
}

function parseJson<T>(s: string | null | undefined, fallback: T): T { try { return s ? JSON.parse(s) as T : fallback } catch { return fallback } }

function basePaths(deviceId: string, asAdmin: boolean) {
  const deviceRoot = asAdmin ? `/api/pod/devices/${deviceId}/screens` : `/api/pod/my/devices/${deviceId}/screens`
  const instanceRoot = asAdmin ? '/api/pod/screens' : '/api/pod/my/screens'
  return { deviceRoot, instanceRoot }
}

export function DeviceScreenDeckEditor({
  deviceId, asAdmin, locks, onLocksChange,
}: {
  deviceId: string
  asAdmin: boolean
  /** Current lock state (admin editor always passes locks + onLocksChange; settings passes
   *  locks so it can render read-only when a capability is locked). */
  locks?: DeckLocks
  onLocksChange?: (next: DeckLocks) => void
}) {
  const { deviceRoot, instanceRoot } = basePaths(deviceId, asAdmin)
  const [deck, setDeck] = useState<DeckRow[] | null>(null)
  const [catalog, setCatalog] = useState<CatalogEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [addingKind, setAddingKind] = useState('')
  const [removeConfirm, setRemoveConfirm] = useState<DeckRow | null>(null)

  const selectionLocked = !asAdmin && !!locks?.lockScreenSelection
  const configLocked = !asAdmin && !!locks?.lockScreenConfig

  async function load() {
    const [deckRes, catalogRes] = await Promise.all([
      fetch(deviceRoot, opts).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch('/api/pod/screens/available', opts).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    ])
    setDeck(Array.isArray(deckRes) ? [...deckRes].sort((a, b) => a.position - b.position) : [])
    setCatalog(Array.isArray(catalogRes) ? catalogRes : [])
  }
  useEffect(() => { void load() }, [deviceId, asAdmin]) // eslint-disable-line react-hooks/exhaustive-deps

  function catalogName(row: DeckRow): string {
    const found = row.screenId ? catalog.find((c) => c.screenId === row.screenId) : undefined
    return found?.name ?? KIND_META[row.kind]?.label ?? row.kind
  }

  async function addScreen(screenId: string, kind: string) {
    setBusy(true)
    try {
      const r = await fetch(deviceRoot, { ...opts, method: 'POST', headers: J, body: JSON.stringify({ screenId, kind, params: {} }) })
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || 'Failed')
      toast.success('Screen added')
      setAddingKind('')
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't add screen") } finally { setBusy(false) }
  }

  async function removeScreen(row: DeckRow) {
    setBusy(true)
    try {
      const r = await fetch(`${instanceRoot}/${row.id}`, { ...opts, method: 'DELETE' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || 'Failed')
      toast.success('Screen removed')
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't remove screen") } finally { setBusy(false); setRemoveConfirm(null) }
  }

  async function move(row: DeckRow, dir: -1 | 1) {
    if (!deck) return
    const idx = deck.findIndex((r) => r.id === row.id)
    const swapIdx = idx + dir
    if (idx < 0 || swapIdx < 0 || swapIdx >= deck.length) return
    const next = [...deck]
    ;[next[idx], next[swapIdx]] = [next[swapIdx]!, next[idx]!]
    setDeck(next) // optimistic
    setBusy(true)
    try {
      const r = await fetch(`${deviceRoot}/reorder`, { ...opts, method: 'PUT', headers: J, body: JSON.stringify({ order: next.map((r2) => r2.id) }) })
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || 'Failed')
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't reorder"); await load() } finally { setBusy(false) }
  }

  async function saveParams(row: DeckRow, params: Record<string, unknown>) {
    setBusy(true)
    try {
      const r = await fetch(`${instanceRoot}/${row.id}`, { ...opts, method: 'PATCH', headers: J, body: JSON.stringify({ params }) })
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || 'Failed')
      toast.success('Saved')
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't save") } finally { setBusy(false) }
  }

  async function toggleLock(key: keyof DeckLocks) {
    if (!asAdmin || !locks || !onLocksChange) return
    const next = { ...locks, [key]: !locks[key] }
    onLocksChange(next)
    try {
      const r = await fetch(`/api/pod/devices/${deviceId}/screen-locks`, { ...opts, method: 'PUT', headers: J, body: JSON.stringify(next) })
      if (!r.ok) throw new Error()
    } catch { toast.error("Couldn't update lock"); onLocksChange(locks) }
  }

  if (deck === null) {
    return <div className="flex justify-center py-8"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
  }

  return (
    <div className="space-y-3">
      {asAdmin && locks && onLocksChange && (
        <div className="flex flex-wrap gap-2">
          <LockChip label="Lock screen selection" active={locks.lockScreenSelection} onClick={() => void toggleLock('lockScreenSelection')} />
          <LockChip label="Lock screen configuration" active={locks.lockScreenConfig} onClick={() => void toggleLock('lockScreenConfig')} />
        </div>
      )}
      {(selectionLocked || configLocked) && !asAdmin && (
        <p className="flex items-center gap-1.5 rounded-lg bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground">
          <Lock className="size-3.5 shrink-0" />
          {selectionLocked && configLocked ? 'An admin has locked this device’s screens — you can’t change or reorder them.'
            : selectionLocked ? 'An admin has locked which screens this device shows — you can still configure each one.'
              : 'An admin has locked how each screen is configured — you can still add, remove, and reorder.'}
        </p>
      )}

      <div className="divide-y divide-border/40 overflow-hidden rounded-2xl border border-border/50 bg-card">
        {deck.length === 0 && (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">No screens yet — add one below.</p>
        )}
        {deck.map((row, i) => {
          const meta = KIND_META[row.kind] ?? { label: row.kind, icon: <Settings2 className="size-4" /> }
          const pending = !FIRMWARE_READY_KINDS.has(row.kind)
          const isOpen = expanded === row.id
          return (
            <div key={row.id}>
              <div className="flex items-center gap-3 px-4 py-3">
                <div className="flex flex-col">
                  <button disabled={selectionLocked || busy || i === 0} onClick={() => void move(row, -1)} className="text-muted-foreground/60 hover:text-foreground disabled:opacity-20">
                    <ChevronUp className="size-3.5" />
                  </button>
                  <button disabled={selectionLocked || busy || i === deck.length - 1} onClick={() => void move(row, 1)} className="text-muted-foreground/60 hover:text-foreground disabled:opacity-20">
                    <ChevronDown className="size-3.5" />
                  </button>
                </div>
                <span className="text-muted-foreground">{meta.icon}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{catalogName(row)}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {meta.label}{i === 0 ? ' · primary' : ''}{pending ? ' · firmware pending' : ''}
                  </p>
                </div>
                <button
                  onClick={() => setExpanded(isOpen ? null : row.id)}
                  disabled={configLocked && row.kind !== 'clock-weather'}
                  className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-30"
                  aria-label="Configure"
                >
                  <ChevronRight className={cn('size-4 transition-transform', isOpen && 'rotate-90')} />
                </button>
                <button
                  onClick={() => setRemoveConfirm(row)}
                  disabled={selectionLocked || busy}
                  className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-30"
                  aria-label="Remove"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
              {isOpen && (
                <div className="border-t border-border/30 bg-muted/20 px-4 py-3">
                  <ScreenParamsEditor row={row} readOnly={configLocked} busy={busy} onSave={(p) => void saveParams(row, p)} />
                </div>
              )}
            </div>
          )
        })}
      </div>

      {!selectionLocked && (
        <div className="flex items-center gap-2">
          <select
            value={addingKind}
            onChange={(e) => setAddingKind(e.target.value)}
            className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="">Add a screen…</option>
            {catalog.map((c) => (
              <option key={`${c.kind}:${c.screenId}`} value={`${c.kind}::${c.screenId}`}>
                {KIND_META[c.kind]?.label ?? c.kind} — {c.name}{!FIRMWARE_READY_KINDS.has(c.kind) ? ' (firmware pending)' : ''}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            disabled={!addingKind || busy}
            onClick={() => { const [kind, screenId] = addingKind.split('::'); if (kind && screenId) void addScreen(screenId, kind) }}
          >
            <Plus className="size-4" /> Add
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={!!removeConfirm}
        onOpenChange={(o) => { if (!o) setRemoveConfirm(null) }}
        title="Remove this screen?"
        description="It will no longer appear in this device's swipe deck."
        confirmLabel="Remove"
        destructive
        onConfirm={() => { if (removeConfirm) void removeScreen(removeConfirm) }}
      />
    </div>
  )
}

function LockChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
        active ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400' : 'border-border/50 text-muted-foreground hover:bg-muted/40',
      )}
    >
      <Lock className="size-3" /> {label}
    </button>
  )
}

// ── Per-kind param editor ──────────────────────────────────────────────────────────
// Kept deliberately simple (a representative config form, not a WYSIWYG builder) — matches
// the "representative card" preview decision. Controller button overrides + clock-weather
// theme both defer to their existing richer editors where one already exists.

interface ButtonOverride { pageIndex: number; row: number; col: number; patch: Record<string, unknown> }
type ControllerAction =
  | { type: 'none' } | { type: 'navigate'; app: string }
  | { type: 'app_action'; action: string } | { type: 'play_station'; stationId: string }
  | { type: 'ha_toggle'; entityId: string } | { type: 'webhook'; url: string; method?: string }

function ScreenParamsEditor({ row, readOnly, busy, onSave }: { row: DeckRow; readOnly: boolean; busy: boolean; onSave: (p: Record<string, unknown>) => void }) {
  if (row.kind === 'clock-weather') {
    return (
      <p className="text-xs text-muted-foreground">
        Colors and widget placement for this template are edited in <span className="font-medium text-foreground">Admin → Devices → Layouts</span>.
        This deck entry only controls whether — and where — it appears in the swipe order.
      </p>
    )
  }
  if (row.kind === 'status') return <StatusParamsEditor row={row} readOnly={readOnly} busy={busy} onSave={onSave} />
  if (row.kind === 'controller') return <ControllerParamsEditor row={row} readOnly={readOnly} busy={busy} onSave={onSave} />
  return (
    <p className="text-xs text-muted-foreground">
      Nothing to configure for this screen yet{!FIRMWARE_READY_KINDS.has(row.kind) ? ' — it also needs a firmware update before it renders on the device.' : '.'}
    </p>
  )
}

function StatusParamsEditor({ row, readOnly, busy, onSave }: { row: DeckRow; readOnly: boolean; busy: boolean; onSave: (p: Record<string, unknown>) => void }) {
  const initial = parseJson<{ label?: string; color?: string }>(row.params, {})
  const [label, setLabel] = useState(initial.label ?? 'Busy')
  const [color, setColor] = useState(initial.color ?? '#dc2626')
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1">
        <label className="text-[11px] text-muted-foreground">Default label</label>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} disabled={readOnly} className="h-8 w-40" />
      </div>
      <div className="space-y-1">
        <label className="text-[11px] text-muted-foreground">Color</label>
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} disabled={readOnly} className="h-8 w-12 rounded border border-input bg-transparent p-0.5" />
      </div>
      <p className="basis-full text-[11px] text-muted-foreground">
        The live label/color while actually busy comes from whatever your companion or an automation sets — this is just the default shown otherwise.
      </p>
      {!readOnly && (
        <Button size="sm" disabled={busy} onClick={() => onSave({ label, color })}>Save</Button>
      )}
    </div>
  )
}

function ControllerParamsEditor({ row, readOnly, busy, onSave }: { row: DeckRow; readOnly: boolean; busy: boolean; onSave: (p: Record<string, unknown>) => void }) {
  const initial = parseJson<{ buttonOverrides?: ButtonOverride[] }>(row.params, {})
  const [overrides, setOverrides] = useState<ButtonOverride[]>(initial.buttonOverrides ?? [])

  function addOverride() {
    setOverrides((prev) => [...prev, { pageIndex: 0, row: 0, col: 0, patch: { label: '', icon: '', bgColor: '#1e1e2e', action: { type: 'none' } } }])
  }
  function update(i: number, patch: Partial<ButtonOverride>) {
    setOverrides((prev) => prev.map((o, idx) => (idx === i ? { ...o, ...patch } : o)))
  }
  function updatePatch(i: number, key: string, value: unknown) {
    setOverrides((prev) => prev.map((o, idx) => (idx === i ? { ...o, patch: { ...o.patch, [key]: value } } : o)))
  }
  function remove(i: number) { setOverrides((prev) => prev.filter((_, idx) => idx !== i)) }

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-muted-foreground">
        Which controller page this device shows is picked when you added the screen. Below, override individual buttons —
        e.g. a Home Assistant toggle, or pin an exact music station — on top of the live dashboard.
      </p>
      {overrides.map((o, i) => {
        const action = (o.patch.action as ControllerAction | undefined) ?? { type: 'none' }
        return (
          <div key={i} className="space-y-2 rounded-xl border border-border/50 bg-card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <MiniField label="Page">
                <input type="number" min={0} value={o.pageIndex} disabled={readOnly}
                  onChange={(e) => update(i, { pageIndex: Number(e.target.value) || 0 })} className="h-7 w-14 rounded border border-input bg-background px-1.5 text-xs" />
              </MiniField>
              <MiniField label="Row">
                <input type="number" min={0} value={o.row} disabled={readOnly}
                  onChange={(e) => update(i, { row: Number(e.target.value) || 0 })} className="h-7 w-14 rounded border border-input bg-background px-1.5 text-xs" />
              </MiniField>
              <MiniField label="Col">
                <input type="number" min={0} value={o.col} disabled={readOnly}
                  onChange={(e) => update(i, { col: Number(e.target.value) || 0 })} className="h-7 w-14 rounded border border-input bg-background px-1.5 text-xs" />
              </MiniField>
              <MiniField label="Icon">
                <input value={(o.patch.icon as string) ?? ''} disabled={readOnly} placeholder="🏠"
                  onChange={(e) => updatePatch(i, 'icon', e.target.value)} className="h-7 w-16 rounded border border-input bg-background px-1.5 text-xs" />
              </MiniField>
              <MiniField label="Label">
                <input value={(o.patch.label as string) ?? ''} disabled={readOnly}
                  onChange={(e) => updatePatch(i, 'label', e.target.value)} className="h-7 w-28 rounded border border-input bg-background px-1.5 text-xs" />
              </MiniField>
              {!readOnly && (
                <button onClick={() => remove(i)} className="ml-auto rounded p-1 text-muted-foreground hover:text-destructive">
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <MiniField label="Action">
                <select
                  value={action.type} disabled={readOnly}
                  onChange={(e) => updatePatch(i, 'action', actionForType(e.target.value))}
                  className="h-7 rounded border border-input bg-background px-1.5 text-xs"
                >
                  <option value="none">None</option>
                  <option value="navigate">Navigate in app</option>
                  <option value="app_action">Playback action</option>
                  <option value="play_station">Play a specific station</option>
                  <option value="ha_toggle">Toggle a Home Assistant entity</option>
                  <option value="webhook">Webhook</option>
                </select>
              </MiniField>
              {action.type === 'navigate' && (
                <MiniField label="App"><input value={action.app} disabled={readOnly} onChange={(e) => updatePatch(i, 'action', { ...action, app: e.target.value })} placeholder="music" className="h-7 w-24 rounded border border-input bg-background px-1.5 text-xs" /></MiniField>
              )}
              {action.type === 'app_action' && (
                <MiniField label="Which">
                  <select value={action.action} disabled={readOnly} onChange={(e) => updatePatch(i, 'action', { ...action, action: e.target.value })} className="h-7 rounded border border-input bg-background px-1.5 text-xs">
                    <option value="play_pause">Play / Pause</option>
                    <option value="next_track">Next Track</option>
                    <option value="volume_up">Volume Up</option>
                    <option value="volume_down">Volume Down</option>
                  </select>
                </MiniField>
              )}
              {action.type === 'play_station' && (
                <MiniField label="Station ID"><input value={action.stationId} disabled={readOnly} onChange={(e) => updatePatch(i, 'action', { ...action, stationId: e.target.value })} placeholder="station id" className="h-7 w-40 rounded border border-input bg-background px-1.5 text-xs" /></MiniField>
              )}
              {action.type === 'ha_toggle' && (
                <MiniField label="Entity ID"><input value={action.entityId} disabled={readOnly} onChange={(e) => updatePatch(i, 'action', { ...action, entityId: e.target.value })} placeholder="light.living_room" className="h-7 w-44 rounded border border-input bg-background px-1.5 text-xs" /></MiniField>
              )}
              {action.type === 'webhook' && (
                <MiniField label="URL"><input value={action.url} disabled={readOnly} onChange={(e) => updatePatch(i, 'action', { ...action, url: e.target.value })} placeholder="https://…" className="h-7 w-48 rounded border border-input bg-background px-1.5 text-xs" /></MiniField>
              )}
            </div>
          </div>
        )
      })}
      {!readOnly && (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={addOverride}><Plus className="size-3.5" /> Override a button</Button>
          <Button size="sm" disabled={busy} onClick={() => onSave({ buttonOverrides: overrides })}>Save</Button>
        </div>
      )}
    </div>
  )
}

function actionForType(type: string): ControllerAction {
  switch (type) {
    case 'navigate': return { type: 'navigate', app: 'music' }
    case 'app_action': return { type: 'app_action', action: 'play_pause' }
    case 'play_station': return { type: 'play_station', stationId: '' }
    case 'ha_toggle': return { type: 'ha_toggle', entityId: '' }
    case 'webhook': return { type: 'webhook', url: '' }
    default: return { type: 'none' }
  }
}

function MiniField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
      {label}
      {children}
    </label>
  )
}

// Re-export a tiny icon so callers that just need the deck icon don't have to import lucide.
export const DeckIcon = MonitorPlay
