import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Music, Plus, Play, Trash2, Copy, Save, Bell } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/lib/toast'
import {
  SOUND_EVENTS, SOUND_EVENT_HELP, audioUrl, opts, JSON_HEADERS, getJSON, parse,
  type SoundPackRow, type ChimeRow, type SoundEventMap, type SoundEvent, type ChimeRecipe,
} from '@/lib/pod/layout'

// Shared <audio> element so previews don't stack.
function usePlayer() {
  const ref = useRef<HTMLAudioElement | null>(null)
  return {
    playUrl(url: string) { ref.current?.pause(); const a = new Audio(url); ref.current = a; a.play().catch(() => toast.error('Couldn’t play')) },
    async playBlob(blob: Blob) { ref.current?.pause(); const a = new Audio(URL.createObjectURL(blob)); ref.current = a; await a.play().catch(() => toast.error('Couldn’t play')) },
  }
}

export function DeviceSoundsPanel({ id }: { id?: string }) {
  const qc = useQueryClient()
  const { data: packs = [] } = useQuery({ queryKey: ['pod-sound-packs'], queryFn: () => getJSON<SoundPackRow[]>('/api/pod/studio/sound-packs') })
  const { data: chimes = [] } = useQuery({ queryKey: ['pod-chimes'], queryFn: () => getJSON<ChimeRow[]>('/api/pod/studio/chimes') })
  const player = usePlayer()
  const [editPack, setEditPack] = useState<SoundPackRow | null>(null)
  const [editChime, setEditChime] = useState<ChimeRow | 'new' | null>(null)
  const refresh = () => { qc.invalidateQueries({ queryKey: ['pod-sound-packs'] }); qc.invalidateQueries({ queryKey: ['pod-chimes'] }) }

  const earcons = chimes.filter((c) => c.category === 'earcon')
  const alarms = chimes.filter((c) => c.category === 'alarm')
  const chimeName = (cid: string | null) => (cid ? chimes.find((c) => c.id === cid)?.name ?? cid : 'Silent')

  return (
    <section id={id} className="space-y-4 rounded-card border border-border/40 bg-card p-5 scroll-mt-20">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-card bg-brand/10 text-brand"><Music className="size-5" /></div>
        <div className="flex-1">
          <h3 className="text-section">Sound packs & chimes</h3>
          <p className="text-sm text-muted-foreground">UI earcons (wake, success, …) and alarm tones. Packs map each event to a chime; design custom chimes below and the server renders them to audio.</p>
        </div>
      </div>

      {/* Packs */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-overline text-muted-foreground">Packs</h4>
          <Button size="sm" variant="secondary" className="gap-1 text-xs" onClick={() => setEditPack({ id: '', name: 'New pack', builtin: false, events: '{}' })}><Plus className="size-3.5" /> New pack</Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {packs.map((p) => {
            const events = parse<SoundEventMap>(p.events, {})
            return (
              <div key={p.id} className="space-y-2 rounded-card border border-border/40 bg-background/40 p-3">
                <div className="flex items-center gap-2"><span className="flex-1 truncate text-sm font-medium">{p.name}</span>{p.builtin && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">Built-in</span>}</div>
                <ul className="space-y-0.5 text-[11px] text-muted-foreground">
                  {SOUND_EVENTS.map((ev) => <li key={ev} className="flex justify-between gap-2"><span className="capitalize">{ev}</span><span className="truncate text-foreground/70">{chimeName(events[ev] ?? null)}</span></li>)}
                </ul>
                <div className="flex gap-1.5 pt-1">
                  {!p.builtin && <Button size="sm" variant="secondary" className="flex-1 text-xs" onClick={() => setEditPack(p)}>Edit</Button>}
                  <Button size="sm" variant="ghost" className="gap-1 text-xs" onClick={() => setEditPack({ ...p, id: '', name: `${p.name} copy`, builtin: false })}><Copy className="size-3.5" /> Duplicate</Button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Chime library */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-overline text-muted-foreground">Chime library</h4>
          <Button size="sm" variant="secondary" className="gap-1 text-xs" onClick={() => setEditChime('new')}><Plus className="size-3.5" /> New chime</Button>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <ChimeList title="Earcons" items={earcons} onPlay={(c) => player.playUrl(audioUrl(c.id)!)} onEdit={setEditChime} />
          <ChimeList title="Alarm tones" icon={Bell} items={alarms} onPlay={(c) => player.playUrl(audioUrl(c.id)!)} onEdit={setEditChime} />
        </div>
      </div>

      {editPack && <PackEditor pack={editPack} chimes={chimes} player={player} onClose={() => setEditPack(null)} onSaved={() => { setEditPack(null); refresh() }} />}
      {editChime && <ChimeEditor chime={editChime === 'new' ? null : editChime} player={player} onClose={() => setEditChime(null)} onSaved={() => { setEditChime(null); refresh() }} />}
    </section>
  )
}

function ChimeList({ title, icon: Icon, items, onPlay, onEdit }: { title: string; icon?: typeof Bell; items: ChimeRow[]; onPlay: (c: ChimeRow) => void; onEdit: (c: ChimeRow) => void }) {
  return (
    <div className="space-y-1.5 rounded-card border border-border/40 bg-background/40 p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">{Icon && <Icon className="size-3.5" />} {title}</p>
      {items.map((c) => (
        <div key={c.id} className="flex items-center gap-2 rounded-control bg-card px-2 py-1.5">
          <Button size="icon-sm" variant="tinted" aria-label={`Play ${c.name}`} onClick={() => onPlay(c)}><Play className="size-3.5" /></Button>
          <span className="flex-1 truncate text-sm">{c.name}</span>
          {c.builtin ? <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">Built-in</span>
            : <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onEdit(c)}>Edit</Button>}
        </div>
      ))}
    </div>
  )
}

// ── Pack editor ──────────────────────────────────────────────────────────────────
function PackEditor({ pack, chimes, player, onClose, onSaved }: { pack: SoundPackRow; chimes: ChimeRow[]; player: ReturnType<typeof usePlayer>; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(pack.name)
  const [events, setEvents] = useState<SoundEventMap>(parse(pack.events, {}))
  const [busy, setBusy] = useState(false)
  const isNew = !pack.id
  // alarm event uses alarm tones; everything else uses earcons.
  const optionsFor = (ev: SoundEvent) => chimes.filter((c) => (ev === 'alarm' ? c.category === 'alarm' : c.category === 'earcon'))

  async function save() {
    setBusy(true)
    try {
      const url = isNew ? '/api/pod/studio/sound-packs' : `/api/pod/studio/sound-packs/${pack.id}`
      const r = await fetch(url, { ...opts, method: isNew ? 'POST' : 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ name: name.trim(), events }) })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Save failed')
      toast.success('Pack saved'); onSaved()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Save failed') } finally { setBusy(false) }
  }

  return (
    <Overlay title={isNew ? 'New sound pack' : 'Edit sound pack'} onClose={onClose} onSave={save} busy={busy}>
      <Input value={name} onChange={(e) => setName(e.target.value)} className="max-w-xs" placeholder="Pack name" />
      <div className="space-y-2">
        {SOUND_EVENTS.map((ev) => (
          <div key={ev} className="flex items-center gap-2 rounded-control bg-background/40 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium capitalize">{ev}</p>
              <p className="truncate text-[11px] text-muted-foreground">{SOUND_EVENT_HELP[ev]}</p>
            </div>
            <select value={events[ev] ?? ''} onChange={(e) => setEvents({ ...events, [ev]: e.target.value || null })} className="h-8 rounded-control border border-input bg-background px-2 text-xs">
              <option value="">Silent</option>
              {optionsFor(ev).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {events[ev] && <Button size="icon-sm" variant="tinted" aria-label="Play chime" onClick={() => player.playUrl(audioUrl(events[ev]!)!)}><Play className="size-3.5" /></Button>}
          </div>
        ))}
      </div>
    </Overlay>
  )
}

// ── Chime designer (recipe → server render → browser preview) ────────────────────
const WAVES = ['sine', 'triangle', 'square', 'sawtooth', 'fm'] as const
function ChimeEditor({ chime, player, onClose, onSaved }: { chime: ChimeRow | null; player: ReturnType<typeof usePlayer>; onClose: () => void; onSaved: () => void }) {
  const isNew = !chime
  const [name, setName] = useState(chime?.name ?? 'New chime')
  const [category, setCategory] = useState<'earcon' | 'alarm'>(chime?.category ?? 'earcon')
  const initial = parse<ChimeRecipe>(chime?.recipe, { waveform: 'sine', envelope: { attack_ms: 5, decay_ms: 40, sustain: 0.3, release_ms: 120 }, notes: [{ freq: 880, start_ms: 0, dur_ms: 120, gain: 0.85 }, { freq: 1320, start_ms: 60, dur_ms: 150, gain: 0.7 }] })
  const [recipe, setRecipe] = useState<ChimeRecipe>(initial)
  const [busy, setBusy] = useState(false)
  const env = recipe.envelope ?? {}
  const notes = recipe.notes ?? []
  const setEnv = (p: Partial<NonNullable<ChimeRecipe['envelope']>>) => setRecipe({ ...recipe, envelope: { ...env, ...p } })

  async function preview() {
    try {
      const r = await fetch('/api/pod/studio/render', { ...opts, method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(category === 'alarm' ? { ...recipe, loop_ms: recipe.loop_ms ?? 2000 } : recipe) })
      if (!r.ok) throw new Error()
      await player.playBlob(await r.blob())
    } catch { toast.error('Render failed') }
  }
  async function save() {
    setBusy(true)
    try {
      const url = isNew ? '/api/pod/studio/chimes' : `/api/pod/studio/chimes/${chime!.id}`
      const body = JSON.stringify({ name: name.trim(), category, loop: category === 'alarm', recipe })
      const r = await fetch(url, { ...opts, method: isNew ? 'POST' : 'PUT', headers: JSON_HEADERS, body })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Save failed')
      toast.success('Chime saved'); onSaved()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Save failed') } finally { setBusy(false) }
  }

  return (
    <Overlay title={isNew ? 'New chime' : 'Edit chime'} onClose={onClose} onSave={save} busy={busy} extra={<Button size="sm" variant="secondary" className="gap-1" onClick={preview}><Play className="size-4" /> Preview</Button>}>
      <div className="flex flex-wrap items-center gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} className="max-w-[200px]" placeholder="Chime name" />
        <select value={category} onChange={(e) => setCategory(e.target.value as 'earcon' | 'alarm')} className="h-9 rounded-control border border-input bg-background px-2 text-sm">
          <option value="earcon">Earcon</option><option value="alarm">Alarm tone (loops)</option>
        </select>
        <select value={recipe.waveform ?? 'sine'} onChange={(e) => setRecipe({ ...recipe, waveform: e.target.value as ChimeRecipe['waveform'] })} className="h-9 rounded-control border border-input bg-background px-2 text-sm capitalize">
          {WAVES.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Range label="Attack" unit="ms" min={0} max={300} step={1} value={env.attack_ms ?? 5} onChange={(v) => setEnv({ attack_ms: v })} />
        <Range label="Decay" unit="ms" min={0} max={400} step={1} value={env.decay_ms ?? 40} onChange={(v) => setEnv({ decay_ms: v })} />
        <Range label="Sustain" unit="" min={0} max={1} step={0.05} value={env.sustain ?? 0.3} onChange={(v) => setEnv({ sustain: v })} />
        <Range label="Release" unit="ms" min={0} max={600} step={1} value={env.release_ms ?? 120} onChange={(v) => setEnv({ release_ms: v })} />
        <Range label="Reverb" unit="" min={0} max={1} step={0.05} value={recipe.effects?.reverb ?? 0} onChange={(v) => setRecipe({ ...recipe, effects: { reverb: v } })} />
        {category === 'alarm' && <Range label="Loop length" unit="ms" min={600} max={4000} step={100} value={recipe.loop_ms ?? 2000} onChange={(v) => setRecipe({ ...recipe, loop_ms: v })} />}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-overline text-muted-foreground">Notes</p>
          <Button size="sm" variant="ghost" className="gap-1 text-xs" onClick={() => setRecipe({ ...recipe, notes: [...notes, { freq: 880, start_ms: 0, dur_ms: 120, gain: 0.8 }] })}><Plus className="size-3.5" /> Add note</Button>
        </div>
        <div className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-1.5 text-[11px] text-muted-foreground">
          <span>Freq (Hz)</span><span>Start (ms)</span><span>Dur (ms)</span><span>Gain</span><span />
          {notes.map((n, i) => {
            const upd = (p: Partial<typeof n>) => { const ns = notes.slice(); ns[i] = { ...n, ...p }; setRecipe({ ...recipe, notes: ns }) }
            return (
              <NoteRow key={i} n={n} onChange={upd} onRemove={() => setRecipe({ ...recipe, notes: notes.filter((_, j) => j !== i) })} />
            )
          })}
        </div>
      </div>
    </Overlay>
  )
}

function NoteRow({ n, onChange, onRemove }: { n: { freq: number; start_ms: number; dur_ms: number; gain?: number }; onChange: (p: Partial<{ freq: number; start_ms: number; dur_ms: number; gain: number }>) => void; onRemove: () => void }) {
  const numInput = (val: number, k: 'freq' | 'start_ms' | 'dur_ms' | 'gain', step = 1) => (
    <input type="number" step={step} value={val} onChange={(e) => onChange({ [k]: Number(e.target.value) } as never)} className="h-8 rounded-control border border-input bg-background px-2 text-xs text-foreground" />
  )
  return (
    <>
      {numInput(n.freq, 'freq')}{numInput(n.start_ms, 'start_ms')}{numInput(n.dur_ms, 'dur_ms')}{numInput(n.gain ?? 0.8, 'gain', 0.05)}
      <Button size="icon-sm" variant="ghost" aria-label="Remove note" onClick={onRemove} className="size-8 text-muted-foreground hover:text-destructive"><Trash2 className="size-3.5" /></Button>
    </>
  )
}

function Range({ label, unit, min, max, step, value, onChange }: { label: string; unit: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <label className="text-xs text-muted-foreground">{label} <span className="text-foreground">{value}{unit}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="mt-1 w-full" />
    </label>
  )
}

// Simple modal overlay on the shared dialog.
function Overlay({ title, children, onClose, onSave, busy, extra }: { title: string; children: React.ReactNode; onClose: () => void; onSave: () => void; busy?: boolean; extra?: React.ReactNode }) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">{children}</div>
        <DialogFooter className="items-center gap-2">
          {extra}
          <Button size="sm" onClick={onSave} disabled={busy}>{busy ? <Spinner className="text-current" /> : <Save className="size-4" />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
