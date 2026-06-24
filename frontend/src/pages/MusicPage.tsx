import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Music, Sparkles, Shuffle, ListMusic, Play, Pause, Download, Trash2, Loader2,
  RefreshCw, Upload, Pencil, Check, Save, X, Radio, Video,
} from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageShell } from '@/components/shared/PageShell'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { TrackVariantGrid } from '@/components/shared/TrackVariantGrid'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import {
  MUSIC_STYLES, MUSIC_KEYS, resolveStyle, renderArrangement, wavDurationSec, hashStr, getStyle,
  type Structure, type ResolvedArrangement, type LayerToggles,
} from '@/lib/music/engine'
import '@/lib/music/engines'   // register built-in engines (future-proofing seam)
import { analyzeMidiFile, renderRemixVariants, renderOriginal, type ParsedMidi } from '@/lib/music/remix'
import {
  saveTrack, listTracks, renameTrack, deleteTrack, trackAudioUrl,
  type MusicTrack, type TrackKind,
} from '@/lib/music/api'
import { ListenTab } from '@/pages/music/ListenTab'
import { VideosTab } from '@/pages/music/VideosTab'
import { RadioTab } from '@/pages/music/RadioTab'

const GRADIENT = 'linear-gradient(135deg,#f97316,#fb923c)'

type Tab = 'listen' | 'radio' | 'videos' | 'generate' | 'remix' | 'library'
const NAV: { id: Tab; icon: React.ElementType; label: string }[] = [
  { id: 'listen', icon: Radio, label: 'Listen' },
  { id: 'radio', icon: Music, label: 'AI Radio' },
  { id: 'videos', icon: Video, label: 'Videos' },
  { id: 'generate', icon: Sparkles, label: 'Generate' },
  { id: 'remix', icon: Shuffle, label: 'Remix' },
  { id: 'library', icon: ListMusic, label: 'Library' },
]

const TRACK_TYPES: { id: TrackKind; label: string; structure: Structure; bars: number; barsEditable: boolean }[] = [
  { id: 'track', label: 'Full track', structure: 'full', bars: 8, barsEditable: true },
  { id: 'loop', label: 'Loop / bed', structure: 'loop', bars: 4, barsEditable: true },
  { id: 'intro', label: 'Intro', structure: 'intro', bars: 2, barsEditable: false },
  { id: 'outro', label: 'Outro', structure: 'outro', bars: 1, barsEditable: false },
]

const LAYER_KEYS: { id: keyof LayerToggles; label: string }[] = [
  { id: 'drums', label: 'Drums' }, { id: 'bass', label: 'Bass' }, { id: 'pad', label: 'Pad' },
  { id: 'keys', label: 'Keys' }, { id: 'lead', label: 'Lead' },
]

// Which of the MIDI's existing parts to keep, plus the added drum groove.
const REMIX_LAYERS: { id: 'melody' | 'drums' | 'bass' | 'pad'; label: string }[] = [
  { id: 'melody', label: 'Melody' }, { id: 'bass', label: 'Bass' },
  { id: 'pad', label: 'Chords' }, { id: 'drums', label: 'Drums' },
]

interface Variant { key: number; label: string; previewUrl: string; blob: Blob; durationSec: number; styleId: string; bpm: number; keyName: string }

// ── Small UI helpers ──────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      {children}
    </div>
  )
}

function Pills<T extends string | number>({ options, value, onChange }: {
  options: { id: T; label: string }[]; value: T; onChange: (v: T) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button key={o.id} type="button" onClick={() => onChange(o.id)}
          className={cn('rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
            value === o.id ? 'border-brand bg-brand/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ── Generate tab ────────────────────────────────────────────────────────────

function GenerateTab({ onSaved }: { onSaved: () => void }) {
  const [styleId, setStyleId] = useState(MUSIC_STYLES[6]!.id)   // synthwave
  const [type, setType] = useState<TrackKind>('track')
  const [bars, setBars] = useState(8)
  const [bpm, setBpm] = useState(110)
  const [bpmAuto, setBpmAuto] = useState(true)
  const [keyName, setKeyName] = useState<string>('auto')
  const [layers, setLayers] = useState<Record<string, boolean>>({ drums: true, bass: true, pad: true, keys: true, lead: true })
  const regenRef = useRef(0)
  const [variants, setVariants] = useState<Variant[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [title, setTitle] = useState('')

  const typeDef = TRACK_TYPES.find((t) => t.id === type)!

  async function generate() {
    const regen = ++regenRef.current
    setBusy(true); setError(null); setSelected(null)
    try {
      const style = getStyle(styleId)!
      const structure = typeDef.structure
      const barCount = typeDef.barsEditable ? bars : typeDef.bars
      const out: Variant[] = []
      for (let i = 0; i < 6; i++) {
        const seed = hashStr(`${styleId}:${structure}:${regen}:${i}`) >>> 0
        const resolved: ResolvedArrangement = resolveStyle(style, seed, {
          bpm: bpmAuto ? undefined : bpm,
          keyName: keyName === 'auto' ? undefined : keyName,
        })
        const blob = await renderArrangement(resolved, {
          structure, bars: barCount,
          layers: layers as LayerToggles,
        })
        out.push({
          key: i, blob, durationSec: wavDurationSec(blob), previewUrl: URL.createObjectURL(blob),
          styleId: style.id, bpm: resolved.bpm, keyName: resolved.keyName,
          label: `${style.label} · ${resolved.bpm} BPM · ${resolved.keyName}`,
        })
      }
      setVariants(out)
    } catch {
      setError('Couldn’t prepare the music engine. Make sure the SoundFont finished downloading, then try again.')
      setVariants([])
    } finally { setBusy(false) }
  }

  function pick(v: Variant) {
    setSelected(v.key)
    setTitle(`${getStyle(v.styleId)?.label ?? 'Track'} ${typeDef.label.toLowerCase()}`)
  }

  async function save() {
    const v = variants.find((x) => x.key === selected); if (!v) return
    setSaving(true)
    try {
      await saveTrack(v.blob, {
        title: title.trim() || 'Untitled track', kind: type, engine: 'midi-offline',
        styleId: v.styleId, bpm: v.bpm, keyName: v.keyName, durationSec: v.durationSec,
      })
      toast.success('Saved to Library')
      setSelected(null)
      onSaved()
    } catch { toast.error('Could not save track') }
    finally { setSaving(false) }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
      {/* Controls */}
      <div className="space-y-4">
        <Field label="Style">
          <div className="grid grid-cols-2 gap-1.5">
            {MUSIC_STYLES.map((s) => (
              <button key={s.id} type="button" onClick={() => setStyleId(s.id)}
                className={cn('rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors',
                  styleId === s.id ? 'border-brand bg-brand/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
                {s.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Type">
          <Pills options={TRACK_TYPES.map((t) => ({ id: t.id, label: t.label }))} value={type} onChange={(v) => setType(v as TrackKind)} />
        </Field>

        {typeDef.barsEditable && (
          <Field label="Length">
            <Pills options={[2, 4, 8, 16].map((b) => ({ id: b, label: `${b} bars` }))} value={bars} onChange={setBars} />
          </Field>
        )}

        <Field label={`Tempo${bpmAuto ? ' · auto' : ` · ${bpm} BPM`}`}>
          <div className="flex items-center gap-2">
            <input type="range" min={60} max={170} value={bpm} disabled={bpmAuto}
              onChange={(e) => setBpm(Number(e.target.value))}
              className="h-1.5 flex-1 accent-[var(--brand,#f97316)] disabled:opacity-40" />
            <button type="button" onClick={() => setBpmAuto((a) => !a)}
              className={cn('rounded-md border px-2 py-1 text-[11px] font-medium', bpmAuto ? 'border-brand bg-brand/10' : 'border-border text-muted-foreground')}>
              Auto
            </button>
          </div>
        </Field>

        <Field label="Key">
          <Pills options={[{ id: 'auto', label: 'Auto' }, ...MUSIC_KEYS.map((k) => ({ id: k, label: k }))]} value={keyName} onChange={setKeyName} />
        </Field>

        <Field label="Layers">
          <div className="flex flex-wrap gap-1.5">
            {LAYER_KEYS.map((l) => (
              <button key={l.id} type="button" onClick={() => setLayers((p) => ({ ...p, [l.id]: !p[l.id] }))}
                className={cn('rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
                  layers[l.id] ? 'border-brand bg-brand/10 text-foreground' : 'border-border text-muted-foreground line-through opacity-60')}>
                {l.label}
              </button>
            ))}
          </div>
        </Field>

        <Button onClick={() => void generate()} disabled={busy} className="w-full" style={{ background: GRADIENT }}>
          {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Sparkles className="mr-2 size-4" />}
          {variants.length ? 'Regenerate' : 'Generate'}
        </Button>
      </div>

      {/* Variants + save */}
      <div className="space-y-4">
        {!variants.length && !busy && !error ? (
          <div className="flex h-full min-h-48 flex-col items-center justify-center rounded-2xl border border-dashed border-border/60 text-center text-sm text-muted-foreground">
            <Music className="mb-2 size-8 opacity-50" />
            Pick a style and hit Generate to hear six takes.
          </div>
        ) : (
          <TrackVariantGrid<Variant>
            variants={variants} loading={busy} error={error} selectedKey={selected}
            onSelect={pick} columns={2}
          />
        )}

        {selected != null && (
          <div className="space-y-2 rounded-xl border border-border bg-card/40 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Save to Library</div>
            <div className="flex items-center gap-2">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Track title" className="flex-1" />
              <Button onClick={save} disabled={saving} style={{ background: GRADIENT }}>
                {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Save className="mr-2 size-4" />} Save
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Remix tab ──────────────────────────────────────────────────────────────

function RemixTab({ onSaved }: { onSaved: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const origRef = useRef<HTMLAudioElement | null>(null)
  const [parsed, setParsed] = useState<ParsedMidi | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [origUrl, setOrigUrl] = useState<string | null>(null)
  const [origLoading, setOrigLoading] = useState(false)
  const [origPlaying, setOrigPlaying] = useState(false)
  const [styleId, setStyleId] = useState(MUSIC_STYLES[6]!.id)
  const [intensity, setIntensity] = useState(0.3)
  const [rLayers, setRLayers] = useState<Record<string, boolean>>({ melody: true, bass: true, pad: true, drums: true })
  const [variants, setVariants] = useState<{ key: number; label: string; previewUrl: string; blob: Blob; durationSec: number; bpm: number; keyName: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [title, setTitle] = useState('')

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    setAnalyzing(true); setParsed(null); setVariants([]); setSelected(null); setError(null)
    setOrigPlaying(false)
    setOrigUrl((u) => { if (u) URL.revokeObjectURL(u); return null })
    try {
      const p = await analyzeMidiFile(file)
      setParsed(p)
      setTitle(file.name.replace(/\.midi?$/i, '') + ' (remix)')
    } catch { toast.error('Could not read that MIDI file') }
    finally { setAnalyzing(false) }
  }

  // Render the imported MIDI on first play (lazy — full songs can be long), then cache.
  async function toggleOriginal() {
    if (!parsed) return
    const el = origRef.current
    if (origPlaying) { el?.pause(); return }
    if (origUrl) { if (el) { el.src = origUrl; void el.play().catch(() => {}) } return }
    setOrigLoading(true)
    try {
      const blob = await renderOriginal(parsed)
      const url = URL.createObjectURL(blob)
      setOrigUrl(url)
      if (el) { el.src = url; void el.play().catch(() => {}) }
    } catch { toast.error('Could not render the original') }
    finally { setOrigLoading(false) }
  }

  async function generate() {
    if (!parsed) return
    setBusy(true); setError(null); setSelected(null)
    try {
      const vs = await renderRemixVariants(parsed, {
        styleId, intensity,
        layers: { drums: rLayers.drums, bass: rLayers.bass, pad: rLayers.pad },
        includeMelody: rLayers.melody,
      })
      setVariants(vs.map((v) => ({ key: v.key, label: v.label, previewUrl: v.previewUrl, blob: v.blob, durationSec: v.durationSec, bpm: v.bpm, keyName: v.keyName })))
    } catch { setError('Remix failed — try a different MIDI file or style.'); setVariants([]) }
    finally { setBusy(false) }
  }

  async function save() {
    const v = variants.find((x) => x.key === selected); if (!v || !parsed) return
    setSaving(true)
    try {
      await saveTrack(v.blob, {
        title: title.trim() || 'Remix', kind: 'track', engine: 'remix',
        styleId, bpm: v.bpm, keyName: v.keyName, durationSec: v.durationSec, sourceName: parsed.analysis.name,
      })
      toast.success('Saved to Library'); setSelected(null); onSaved()
    } catch { toast.error('Could not save track') }
    finally { setSaving(false) }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
      <div className="space-y-4">
        <button type="button" onClick={() => fileRef.current?.click()}
          className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border/60 py-6 text-muted-foreground hover:bg-muted/40">
          {analyzing ? <Loader2 className="size-6 animate-spin" /> : <Upload className="size-6" />}
          <span className="text-sm">{parsed ? 'Choose a different .mid' : 'Drop a .mid file to remix'}</span>
        </button>
        <input ref={fileRef} type="file" accept=".mid,.midi,audio/midi" className="hidden" onChange={onFile} />

        {parsed && (
          <>
            <div className="rounded-xl border border-border bg-card/40 p-3 text-xs">
              <audio ref={origRef} className="hidden"
                onPlay={() => setOrigPlaying(true)} onPause={() => setOrigPlaying(false)} onEnded={() => setOrigPlaying(false)} />
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => void toggleOriginal()} disabled={origLoading}
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-foreground hover:bg-muted/70 disabled:opacity-50"
                  aria-label={origPlaying ? 'Pause original' : 'Play original'}>
                  {origLoading ? <Loader2 className="size-3.5 animate-spin" /> : origPlaying ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                </button>
                <div className="min-w-0">
                  <div className="truncate font-semibold">{parsed.analysis.name}</div>
                  <div className="text-[11px] text-muted-foreground">Play original</div>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-1 text-muted-foreground">
                <span>Key: {parsed.analysis.keyName} {parsed.analysis.mode}</span>
                <span>{parsed.analysis.bpm} BPM</span>
                <span>{parsed.analysis.noteCount} notes</span>
                <span>{parsed.analysis.trackCount} tracks</span>
              </div>
            </div>

            <Field label="Restyle as">
              <div className="grid grid-cols-2 gap-1.5">
                {MUSIC_STYLES.map((s) => (
                  <button key={s.id} type="button" onClick={() => setStyleId(s.id)}
                    className={cn('rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors',
                      styleId === s.id ? 'border-brand bg-brand/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
                    {s.label}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="Build">
              <div className="flex flex-wrap gap-1.5">
                {REMIX_LAYERS.map((l) => (
                  <button key={l.id} type="button" onClick={() => setRLayers((p) => ({ ...p, [l.id]: !p[l.id] }))}
                    className={cn('rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
                      rLayers[l.id] ? 'border-brand bg-brand/10 text-foreground' : 'border-border text-muted-foreground line-through opacity-60')}>
                    {l.label}
                  </button>
                ))}
              </div>
            </Field>

            <Field label={`Quantize melody · ${intensity >= 0.85 ? '16ths' : intensity >= 0.55 ? '8ths' : 'off (original timing)'}`}>
              <input type="range" min={0} max={1} step={0.1} value={intensity}
                onChange={(e) => setIntensity(Number(e.target.value))}
                className="h-1.5 w-full accent-[var(--brand,#f97316)]" />
            </Field>

            <Button onClick={generate} disabled={busy} className="w-full" style={{ background: GRADIENT }}>
              {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Shuffle className="mr-2 size-4" />}
              {variants.length ? 'Regenerate' : 'Remix'}
            </Button>
            <p className="text-[11px] leading-snug text-muted-foreground">
              Keeps the melody and rebuilds the groove, bass, and instruments in the chosen style. For your own use — imported music may be copyrighted.
            </p>
          </>
        )}
      </div>

      <div className="space-y-4">
        {!parsed ? (
          <div className="flex h-full min-h-48 flex-col items-center justify-center rounded-2xl border border-dashed border-border/60 text-center text-sm text-muted-foreground">
            <Shuffle className="mb-2 size-8 opacity-50" />
            Import a MIDI file to restyle it.
          </div>
        ) : (
          <TrackVariantGrid variants={variants} loading={busy} error={error} selectedKey={selected}
            onSelect={(v) => { setSelected(v.key) }} columns={2} />
        )}

        {selected != null && (
          <div className="space-y-2 rounded-xl border border-border bg-card/40 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Save to Library</div>
            <div className="flex items-center gap-2">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Track title" className="flex-1" />
              <Button onClick={save} disabled={saving} style={{ background: GRADIENT }}>
                {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Save className="mr-2 size-4" />} Save
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Library tab ──────────────────────────────────────────────────────────────

function fmtDur(s: number | null): string {
  if (!s) return ''
  const m = Math.floor(s / 60); const sec = Math.round(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

function TrackRow({ track, onChanged }: { track: MusicTrack; onChanged: () => void }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(track.title)
  const [confirmDel, setConfirmDel] = useState(false)

  function toggle() {
    const el = audioRef.current; if (!el) return
    if (playing) { el.pause(); return }
    el.play().catch(() => setPlaying(false))
  }

  async function rename() {
    setEditing(false)
    const t = name.trim()
    if (!t || t === track.title) { setName(track.title); return }
    try { await renameTrack(track.id, t); onChanged() } catch { toast.error('Rename failed'); setName(track.title) }
  }

  async function del() {
    try { await deleteTrack(track.id); toast.success('Deleted'); onChanged() } catch { toast.error('Delete failed') }
  }

  const sub = [track.kind !== 'track' ? track.kind : null, track.styleId, track.bpm ? `${track.bpm} BPM` : null, track.keyName, fmtDur(track.durationSec)]
    .filter(Boolean).join(' · ')

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card/40 px-3 py-2.5">
      <audio ref={audioRef} src={trackAudioUrl(track.id)} preload="none"
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setProgress(0) }}
        onTimeUpdate={(e) => { const a = e.currentTarget; setProgress(a.duration ? a.currentTime / a.duration : 0) }} />
      <button type="button" onClick={toggle}
        className="flex size-9 shrink-0 items-center justify-center rounded-full text-white" style={{ background: GRADIENT }}
        aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
      </button>

      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex items-center gap-1.5">
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') void rename(); if (e.key === 'Escape') { setEditing(false); setName(track.title) } }}
              className="h-7 py-0 text-sm" />
            <button type="button" onClick={() => void rename()} className="text-brand"><Check className="size-4" /></button>
            <button type="button" onClick={() => { setEditing(false); setName(track.title) }} className="text-muted-foreground"><X className="size-4" /></button>
          </div>
        ) : (
          <>
            <div className="truncate text-sm font-medium">{track.title}</div>
            <div className="truncate text-xs capitalize text-muted-foreground">{sub}</div>
          </>
        )}
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-brand transition-[width]" style={{ width: `${progress * 100}%` }} />
        </div>
      </div>

      {!editing && (
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" onClick={() => setEditing(true)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Rename"><Pencil className="size-4" /></button>
          <a href={trackAudioUrl(track.id)} download={`${track.title}.wav`} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Download"><Download className="size-4" /></a>
          <button type="button" onClick={() => setConfirmDel(true)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive" aria-label="Delete"><Trash2 className="size-4" /></button>
        </div>
      )}

      <ConfirmDialog open={confirmDel} onOpenChange={setConfirmDel} title="Delete track?"
        description={`“${track.title}” will be permanently removed.`} destructive confirmLabel="Delete" onConfirm={() => void del()} />
    </div>
  )
}

function LibraryTab({ reloadKey }: { reloadKey: number }) {
  const [tracks, setTracks] = useState<MusicTrack[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try { setTracks(await listTracks()) } catch { /* keep prior */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load, reloadKey])

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
  if (!tracks.length) return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/60 py-16 text-center text-sm text-muted-foreground">
      <ListMusic className="mb-2 size-8 opacity-50" />
      No saved tracks yet. Generate or remix something to fill your library.
    </div>
  )
  return <div className="space-y-2">{tracks.map((t) => <TrackRow key={t.id} track={t} onChanged={load} />)}</div>
}

// ── Page ───────────────────────────────────────────────────────────────────

export function MusicPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const urlTab = searchParams.get('tab') as Tab | null
  const [tab, setTab] = useState<Tab>(urlTab ?? 'listen')
  const [reloadKey, setReloadKey] = useState(0)
  const bumpLibrary = useCallback(() => setReloadKey((n) => n + 1), [])

  // Sync tab state when URL param changes (e.g. companion deeplink).
  useEffect(() => {
    if (urlTab && urlTab !== tab) setTab(urlTab)
  }, [urlTab]) // eslint-disable-line react-hooks/exhaustive-deps

  function switchTab(t: Tab) {
    setTab(t)
    setSearchParams((p) => { p.set('tab', t); return p }, { replace: true })
  }

  const subtitle = {
    listen: 'Stream 40,000+ live radio stations worldwide.',
    radio: 'AI-hosted stations — your companion DJs between tracks.',
    videos: 'YouTube music videos with artist info & soundtrack history.',
    generate: 'Create original tracks — fully offline.',
    remix: 'Restyle a MIDI file in any genre.',
    library: 'Your saved tracks.',
  }[tab]

  return (
    <PageShell gradient={GRADIENT} GhostIcon={Music}>
      <div className="mx-auto w-full max-w-5xl flex-1 px-4 pt-5 pb-8 sm:px-6">
        {/* Tab nav */}
        <div className="mb-6 overflow-x-auto">
          <div className="flex gap-0.5 rounded-2xl border border-border/50 bg-muted/30 p-1">
            {NAV.map((n) => (
              <button key={n.id} type="button" onClick={() => switchTab(n.id)}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-semibold transition-all',
                  tab === n.id
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}>
                <n.icon className="size-4" />
                <span className="hidden sm:inline">{n.label}</span>
                <span className="sm:hidden">{n.label.split(' ')[0]}</span>
              </button>
            ))}
          </div>
        </div>

        {tab === 'listen' && <ListenTab />}
        {tab === 'radio' && <RadioTab />}
        {tab === 'videos' && <VideosTab />}
        {tab === 'generate' && <GenerateTab onSaved={bumpLibrary} />}
        {tab === 'remix' && <RemixTab onSaved={bumpLibrary} />}
        {tab === 'library' && <LibraryTab reloadKey={reloadKey} />}
      </div>
    </PageShell>
  )
}
