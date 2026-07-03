import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { LayoutGrid, Plus, Copy, Trash2, Clock, CloudSun, Mic, Volume2, Save, X, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { StatusDot } from '@/components/shared/StatusDot'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { DevicePreview } from '@/components/admin/DevicePreview'
import { toast } from '@/lib/toast'
import {
  validateWidgets, firstFreeAnchor, footprint, WEATHER_CONDITIONS, DEFAULT_TEMPLATE_ID, rendererForTemplateId,
  type WidgetPlacement, type WidgetType, type WidgetSize, type ThemeTokens, type WeatherCondition,
  type TemplateRow, type SoundPackRow, type ChimeRow,
  opts, JSON_HEADERS, getJSON, parse,
} from '@/lib/pod/layout'

interface DeviceRow { id: string; name: string; kind: string; model: string | null; layoutTemplateId?: string | null; layoutOverrides?: string | null }

interface DraftTemplate {
  id: string | null
  name: string
  theme: ThemeTokens
  widgets: WidgetPlacement[]
  soundPackId: string | null
  volume: number
  alarmVolume: number
  alarmToneId: string | null
}

// design-ok(hex-in-tsx): device-screen theme defaults rendered on the Pod display, not app UI
const DEFAULT_THEME: ThemeTokens = { bg: '#0E0B1A', accent: '#7C3AED', text: '#EAEAF2', font_scale: 1 }
const WIDGET_ICON: Record<WidgetType, typeof Clock> = { clock: Clock, weather: CloudSun, mic: Mic, mute: Volume2 }
// The device draws its OWN native, tappable mic/mute buttons over the screen image, so
// adding mic/mute as layout widgets just paints a non-functional duplicate, so offer only
// the real content widgets in the editor.
const PALETTE: WidgetType[] = ['clock', 'weather']
const defaultSize = (t: WidgetType): WidgetSize => (t === 'clock' || t === 'weather' ? 'medium' : 'small')

export function DeviceLayoutsPanel({ id }: { id?: string }) {
  const qc = useQueryClient()
  const { data: templates = [] } = useQuery({ queryKey: ['pod-templates'], queryFn: () => getJSON<TemplateRow[]>('/api/pod/studio/templates') })
  const { data: packs = [] } = useQuery({ queryKey: ['pod-sound-packs'], queryFn: () => getJSON<SoundPackRow[]>('/api/pod/studio/sound-packs') })
  const { data: chimes = [] } = useQuery({ queryKey: ['pod-chimes'], queryFn: () => getJSON<ChimeRow[]>('/api/pod/studio/chimes') })
  const { data: devices = [] } = useQuery({ queryKey: ['pod-devices'], queryFn: () => getJSON<DeviceRow[]>('/api/pod/devices') })

  const [draft, setDraft] = useState<DraftTemplate | null>(null)
  const [del, setDel] = useState<TemplateRow | null>(null)
  const alarmTones = chimes.filter((c) => c.category === 'alarm')

  function startNew() {
    setDraft({ id: null, name: 'New layout', theme: { ...DEFAULT_THEME }, widgets: [{ type: 'clock', size: 'large', anchor: [0, 0] }], soundPackId: packs[0]?.id ?? null, volume: 0.7, alarmVolume: 1, alarmToneId: alarmTones[0]?.id ?? null })
  }
  function startEdit(t: TemplateRow, asCopy = false) {
    setDraft({
      id: asCopy ? null : t.id,
      name: asCopy ? `${t.name} copy` : t.name,
      theme: parse<ThemeTokens>(t.theme, DEFAULT_THEME),
      widgets: parse<WidgetPlacement[]>(t.widgets, []),
      soundPackId: t.soundPackId, volume: t.volume, alarmVolume: t.alarmVolume, alarmToneId: t.alarmToneId,
    })
  }

  if (draft) {
    return <LayoutEditor draft={draft} setDraft={setDraft} packs={packs} alarmTones={alarmTones} onClose={() => setDraft(null)} onSaved={() => { setDraft(null); qc.invalidateQueries({ queryKey: ['pod-templates'] }); qc.invalidateQueries({ queryKey: ['pod-devices'] }) }} />
  }

  return (
    <section id={id} className="space-y-4 rounded-card border border-border/40 bg-card p-5 scroll-mt-20">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-card bg-brand/10 text-brand"><LayoutGrid className="size-5" /></div>
        <div className="flex-1">
          <h3 className="text-section">Screen layouts</h3>
          <p className="text-sm text-muted-foreground">Arrange widgets into a 3×3 grid and theme it. Assign a layout to a screen device: changing it updates the device live, no re-flash.</p>
        </div>
        <Button size="sm" onClick={startNew}><Plus className="size-4" /> New layout</Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {templates.map((t) => {
          const theme = parse<ThemeTokens>(t.theme, DEFAULT_THEME)
          const widgets = parse<WidgetPlacement[]>(t.widgets, [])
          // Which devices actually SHOW this layout (a device with no assignment uses
          // the built-in default). This is what makes "edit → device changes" make sense.
          const usedBy = devices.filter((d) => (d.layoutTemplateId ?? DEFAULT_TEMPLATE_ID) === t.id)
          return (
            <div key={t.id} className="flex flex-col gap-3 rounded-card border border-border/40 bg-background/40 p-3">
              <div className="overflow-hidden rounded-control"><DevicePreview theme={theme} widgets={widgets} /></div>
              <div className="flex items-center gap-2">
                <span className="flex-1 truncate text-sm font-medium">{t.name}</span>
                {rendererForTemplateId(t.id) === 'lvgl' && (
                  <span className="rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-semibold text-brand" title="Rendered natively on-device in LVGL (experiment)">LVGL</span>
                )}
                {t.builtin && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">Built-in</span>}
              </div>
              {usedBy.length > 0
                ? <p className="-mt-1 flex items-center gap-1.5 text-[11px] font-medium text-success"><StatusDot status="ok" /><span className="truncate">On {usedBy.map((d) => d.name).join(', ')}</span></p>
                : <p className="-mt-1 text-[11px] text-muted-foreground">Not on any device</p>}
              <div className="flex items-center gap-1.5">
                <Button size="sm" variant="secondary" className="flex-1 gap-1 text-xs" onClick={() => startEdit(t)}>Edit</Button>
                <Button size="sm" variant="ghost" className="gap-1 text-xs" onClick={() => startEdit(t, true)}><Copy className="size-3.5" /> Duplicate</Button>
                {!t.builtin && <Button size="icon" variant="ghost" className="size-8 text-muted-foreground hover:text-destructive" onClick={() => setDel(t)}><Trash2 className="size-4" /></Button>}
              </div>
            </div>
          )
        })}
      </div>

      {/* Assignment */}
      <div className="space-y-2 rounded-card border border-border/40 bg-background/40 p-4">
        <h4 className="text-sm font-semibold">Assign to devices</h4>
        <p className="text-xs text-muted-foreground">Pick which layout each screen device shows. Saving pushes it live.</p>
        {devices.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">No devices yet.</p>
        ) : (
          <div className="space-y-2">
            {devices.map((d) => <AssignRow key={d.id} device={d} templates={templates} />)}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!del} onOpenChange={(o) => { if (!o) setDel(null) }}
        title="Delete this layout?" destructive confirmLabel="Delete"
        description={del ? `"${del.name}" will be removed. Devices using it fall back to the default layout.` : undefined}
        onConfirm={async () => {
          if (del) {
            const r = await fetch(`/api/pod/studio/templates/${del.id}`, { ...opts, method: 'DELETE' })
            if (r.ok) { toast.success('Layout deleted'); qc.invalidateQueries({ queryKey: ['pod-templates'] }) } else toast.error('Delete failed')
          }
          setDel(null)
        }}
      />
    </section>
  )
}

function AssignRow({ device, templates }: { device: DeviceRow; templates: TemplateRow[] }) {
  const [value, setValue] = useState(device.layoutTemplateId ?? '')
  const [photoUrl, setPhotoUrl] = useState<string>(() => parse<{ photoUrl?: string }>(device.layoutOverrides, {}).photoUrl ?? '')
  const [busy, setBusy] = useState(false)
  // The native-LVGL dashboard can show a per-user family photo (stored in the device's
  // layoutOverrides). The field appears only for an LVGL template; the same hardware-decode
  // path will later serve a thumbnail atlas to the controller's many buttons.
  const isLvgl = rendererForTemplateId(value) === 'lvgl'
  // Persist templateId + overrides together (the route replaces overrides on each save,
  // so we always send the current photo URL alongside).
  async function save(v: string, photo: string) {
    setBusy(true)
    try {
      const overrides = photo.trim() ? { photoUrl: photo.trim() } : undefined
      const r = await fetch(`/api/pod/devices/${device.id}/layout`, { ...opts, method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ templateId: v || null, overrides }) })
      if (!r.ok) throw new Error()
      toast.success(`Layout updated for ${device.name}`)
    } catch { toast.error('Couldn’t update layout') } finally { setBusy(false) }
  }
  return (
    <div className="flex flex-col gap-2 rounded-card bg-card px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate text-sm">{device.name}</span>
        {busy && <Spinner />}
        <select value={value} onChange={(e) => { setValue(e.target.value); void save(e.target.value, photoUrl) }} className="h-8 rounded-control border border-input bg-background px-2 text-xs">
          <option value="">Default layout</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        {/* Preview THIS device's live layout in a browser tab (what the screen shows). */}
        <a href={`/display?deviceId=${device.id}`} target="_blank" rel="noreferrer" title="Open this device's display" className="inline-flex size-8 items-center justify-center rounded-control text-muted-foreground hover:text-foreground">
          <ExternalLink className="size-4" />
        </a>
      </div>
      {isLvgl && (
        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="shrink-0">Family photo URL</span>
          <input
            type="url" value={photoUrl} placeholder="https://…/photo.jpg"
            onChange={(e) => setPhotoUrl(e.target.value)}
            onBlur={() => void save(value, photoUrl)}
            className="h-7 flex-1 rounded-control border border-input bg-background px-2 text-xs text-foreground"
          />
        </label>
      )}
    </div>
  )
}

// ── The editor ─────────────────────────────────────────────────────────────────────
function LayoutEditor({ draft, setDraft, packs, alarmTones, onClose, onSaved }: {
  draft: DraftTemplate; setDraft: (d: DraftTemplate) => void
  packs: SoundPackRow[]; alarmTones: ChimeRow[]; onClose: () => void; onSaved: () => void
}) {
  const [selected, setSelected] = useState<number | null>(null)
  const [addType, setAddType] = useState<WidgetType>('clock')
  const [previewWeather, setPreviewWeather] = useState<WeatherCondition>('partly-cloudy')
  const [previewNight, setPreviewNight] = useState(false)
  const [busy, setBusy] = useState(false)
  const error = useMemo(() => validateWidgets(draft.widgets), [draft.widgets])
  const set = (patch: Partial<DraftTemplate>) => setDraft({ ...draft, ...patch })
  const setWidget = (i: number, w: WidgetPlacement) => { const ws = draft.widgets.slice(); ws[i] = w; set({ widgets: ws }) }

  function placeAt(r: number, c: number) {
    // If a widget already covers this cell, select it. Else add the palette widget here.
    const hit = draft.widgets.findIndex((w) => footprint(w).some(([fr, fc]) => fr === r && fc === c))
    if (hit >= 0) { setSelected(hit); return }
    const candidate: WidgetPlacement = { type: addType, size: defaultSize(addType), anchor: [r, c], orient: 'horizontal' }
    if (validateWidgets([...draft.widgets, candidate]) !== null) { toast.error('Doesn’t fit there'); return }
    set({ widgets: [...draft.widgets, candidate] }); setSelected(draft.widgets.length)
  }
  function addWidget(t: WidgetType) {
    const size = defaultSize(t)
    const anchor = firstFreeAnchor(draft.widgets, size, 'horizontal')
    if (!anchor) { toast.error('No room, remove a widget first'); return }
    set({ widgets: [...draft.widgets, { type: t, size, anchor, orient: 'horizontal' }] }); setSelected(draft.widgets.length)
  }
  function removeSelected() { if (selected == null) return; set({ widgets: draft.widgets.filter((_, i) => i !== selected) }); setSelected(null) }
  function changeSize(size: WidgetSize) {
    if (selected == null) return
    // 'full' always spans the whole grid → force its anchor to the top-left origin.
    const w: WidgetPlacement = { ...draft.widgets[selected]!, size, ...(size === 'full' ? { anchor: [0, 0] as [number, number] } : {}) }
    const others = draft.widgets.filter((_, i) => i !== selected)
    if (validateWidgets([...others, w]) !== null) { toast.error(size === 'full' ? 'Full-screen needs an empty grid: remove the other widgets first' : 'That size collides or runs off the grid here'); return }
    setWidget(selected, w)
  }
  function toggleOrient() {
    if (selected == null) return
    const cur = draft.widgets[selected]!
    const w = { ...cur, orient: (cur.orient ?? 'horizontal') === 'horizontal' ? 'vertical' as const : 'horizontal' as const }
    const others = draft.widgets.filter((_, i) => i !== selected)
    if (validateWidgets([...others, w]) !== null) { toast.error('Doesn’t fit rotated here'); return }
    setWidget(selected, w)
  }

  async function save() {
    if (error) { toast.error(error); return }
    if (!draft.name.trim()) { toast.error('Name required'); return }
    setBusy(true)
    const body = JSON.stringify({
      name: draft.name.trim(), theme: draft.theme, widgets: draft.widgets,
      soundPackId: draft.soundPackId, volume: draft.volume, alarmVolume: draft.alarmVolume, alarmToneId: draft.alarmToneId,
    })
    try {
      const url = draft.id ? `/api/pod/studio/templates/${draft.id}` : '/api/pod/studio/templates'
      const r = await fetch(url, { ...opts, method: draft.id ? 'PUT' : 'POST', headers: JSON_HEADERS, body })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Save failed')
      toast.success('Layout saved'); onSaved()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Save failed') } finally { setBusy(false) }
  }

  const sel = selected != null ? draft.widgets[selected] : null

  return (
    <section className="space-y-4 rounded-card border border-border/40 bg-card p-5">
      <div className="flex items-center gap-3">
        <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} className="max-w-xs font-medium" />
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}><X className="size-4" /> Cancel</Button>
          <Button size="sm" onClick={save} disabled={busy || !!error}>{busy ? <Spinner className="text-current" /> : <Save className="size-4" />} Save</Button>
        </div>
      </div>
      {error && <p className="rounded-control bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}

      <div className="grid gap-5 lg:grid-cols-[minmax(440px,1fr)_minmax(0,1fr)]">
        {/* Preview / grid editor */}
        <div className="space-y-3">
          <DevicePreview theme={draft.theme} widgets={draft.widgets} weather={previewWeather} isNight={previewNight} selectedIndex={selected ?? undefined} onSelect={setSelected} onSlotClick={placeAt} />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Place:</span>
            {PALETTE.map((t) => {
              const Icon = WIDGET_ICON[t]
              return <Button key={t} size="sm" variant="outline" onClick={() => setAddType(t)} className={cn('h-7 gap-1 px-2 text-xs capitalize', addType === t ? 'border-brand bg-brand/10 text-foreground' : 'border-border/50 text-muted-foreground')}><Icon className="size-3.5" /> {t}</Button>
            })}
            <span className="ml-2 text-muted-foreground">then tap a slot</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Preview sky:</span>
            <select value={previewWeather} onChange={(e) => setPreviewWeather(e.target.value as WeatherCondition)} className="h-7 rounded-control border border-input bg-background px-2 text-xs">
              {WEATHER_CONDITIONS.map((w) => <option key={w} value={w}>{w}</option>)}
            </select>
            <Button size="sm" variant="outline" onClick={() => setPreviewNight((n) => !n)} className="h-7 border-border/50 px-2 text-xs">{previewNight ? '🌙 Night' : '☀️ Day'}</Button>
          </div>
        </div>

        {/* Controls */}
        <div className="space-y-4">
          {/* Selected widget */}
          <div className="space-y-2 rounded-card border border-border/40 bg-background/40 p-3">
            <h4 className="text-overline text-muted-foreground">Selected widget</h4>
            {!sel ? <p className="text-sm text-muted-foreground">Tap a widget in the preview, or place one from the palette. You can also quick-add:</p> : (
              <div className="space-y-2">
                <p className="text-sm font-medium capitalize">{sel.type} at slot [{sel.anchor.join(', ')}]</p>
                <div className="flex items-center gap-1.5">
                  {(['small', 'medium', 'large', 'full'] as WidgetSize[]).map((s) => (
                    <Button key={s} size="sm" variant="outline" onClick={() => changeSize(s)} className={cn('h-7 px-2.5 text-xs capitalize', sel.size === s ? 'border-brand bg-brand/10' : 'border-border/50 text-muted-foreground')}>{s}</Button>
                  ))}
                  {sel.size === 'medium' && <Button size="sm" variant="outline" onClick={toggleOrient} className="h-7 border-border/50 px-2.5 text-xs">{(sel.orient ?? 'horizontal') === 'horizontal' ? '↔ Horizontal' : '↕ Vertical'}</Button>}
                  <Button size="sm" variant="ghost" className="ml-auto gap-1 text-xs text-muted-foreground hover:text-destructive" onClick={removeSelected}><Trash2 className="size-3.5" /> Remove</Button>
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-1.5 pt-1">
              {PALETTE.map((t) => { const Icon = WIDGET_ICON[t]; return <Button key={t} size="sm" variant="outline" onClick={() => addWidget(t)} className="h-7 gap-1 border-border/50 px-2 text-xs capitalize text-muted-foreground hover:text-foreground"><Plus className="size-3" /><Icon className="size-3.5" /> {t}</Button> })}
            </div>
          </div>

          {/* Theme */}
          <div className="space-y-2 rounded-card border border-border/40 bg-background/40 p-3">
            <h4 className="text-overline text-muted-foreground">Theme</h4>
            <div className="grid grid-cols-3 gap-2">
              <ColorField label="Background" value={draft.theme.bg} onChange={(v) => set({ theme: { ...draft.theme, bg: v } })} />
              <ColorField label="Accent" value={draft.theme.accent} onChange={(v) => set({ theme: { ...draft.theme, accent: v } })} />
              <ColorField label="Text" value={draft.theme.text} onChange={(v) => set({ theme: { ...draft.theme, text: v } })} />
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">Font scale
              <input type="range" min={0.7} max={1.4} step={0.05} value={draft.theme.font_scale} onChange={(e) => set({ theme: { ...draft.theme, font_scale: Number(e.target.value) } })} className="flex-1" />
              <span className="w-8 tabular-nums text-foreground">{draft.theme.font_scale.toFixed(2)}</span>
            </label>
          </div>

          {/* Sound */}
          <div className="space-y-2 rounded-card border border-border/40 bg-background/40 p-3">
            <h4 className="text-overline text-muted-foreground">Sound</h4>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-muted-foreground">Sound pack
                <select value={draft.soundPackId ?? ''} onChange={(e) => set({ soundPackId: e.target.value || null })} className="mt-1 h-8 w-full rounded-control border border-input bg-background px-2 text-xs text-foreground">
                  <option value="">None</option>
                  {packs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <label className="text-xs text-muted-foreground">Default alarm tone
                <select value={draft.alarmToneId ?? ''} onChange={(e) => set({ alarmToneId: e.target.value || null })} className="mt-1 h-8 w-full rounded-control border border-input bg-background px-2 text-xs text-foreground">
                  {alarmTones.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">Earcon volume
              <input type="range" min={0} max={1} step={0.05} value={draft.volume} onChange={(e) => set({ volume: Number(e.target.value) })} className="flex-1" />
              <span className="w-8 tabular-nums text-foreground">{Math.round(draft.volume * 100)}%</span>
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">Alarm volume
              <input type="range" min={0} max={1} step={0.05} value={draft.alarmVolume} onChange={(e) => set({ alarmVolume: Number(e.target.value) })} className="flex-1" />
              <span className="w-8 tabular-nums text-foreground">{Math.round(draft.alarmVolume * 100)}%</span>
            </label>
            <p className="text-[11px] text-muted-foreground">Alarms ignore the global mute and use their own volume so they can’t fail silently.</p>
          </div>
        </div>
      </div>
    </section>
  )
}

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  // Hold what's typed locally so an in-progress (temporarily invalid) hex like "0E0"
  // (missing its leading hash) doesn't get committed to the theme and blank the preview
  // to black. Only push up a valid hex color; on blur, snap back to the last good value
  // if it's still invalid.
  const [text, setText] = useState(value)
  useEffect(() => { setText(value) }, [value])
  return (
    <label className="text-xs text-muted-foreground">{label}
      <div className="mt-1 flex items-center gap-1.5 rounded-control border border-input bg-background px-1.5 py-1">
        {/* design-ok(hex-in-tsx): fallback value for the native color input editing device-screen theme art */}
        <input type="color" value={HEX_RE.test(value) ? value : '#000000'} onChange={(e) => { setText(e.target.value); onChange(e.target.value) }} className="size-6 cursor-pointer rounded border-0 bg-transparent p-0" />
        <input
          value={text}
          onChange={(e) => { const v = e.target.value; setText(v); if (HEX_RE.test(v)) onChange(v) }}
          onBlur={() => { if (!HEX_RE.test(text)) setText(value) }}
          className="w-full bg-transparent text-xs text-foreground outline-none"
        />
      </div>
    </label>
  )
}
