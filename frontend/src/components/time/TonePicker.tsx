// Tone chooser for alarms & timers. Three sources:
//   1. Built-in synthesized tones (instant, offline); see lib/time/tones.ts
//   2. Previously-saved generated tones (music_tracks, kind 'loop')
//   3. New tones generated on demand by the offline music engine
// Emits the chosen tone string ("builtin:<key>" | "track:<id>") + a display name.

import { useEffect, useRef, useState } from 'react'
import { Check, Pause, Play, Sparkles, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { TrackVariantGrid } from '@/components/shared/TrackVariantGrid'
import { BUILTIN_TONES, previewTone, type RingHandle } from '@/lib/time/tones'
import { generateToneVariants, saveToneVariant, type ToneVariant } from '@/lib/time/toneGen'
import { listTracks, type MusicTrack } from '@/lib/music/api'
import { toast } from '@/lib/toast'

export function TonePicker({ value, onChange }: {
  value: string
  onChange: (tone: string, name: string) => void
}) {
  const [saved, setSaved] = useState<MusicTrack[]>([])
  const [previewing, setPreviewing] = useState<string | null>(null)
  const previewRef = useRef<RingHandle | null>(null)

  const [genOpen, setGenOpen] = useState(false)
  const [variants, setVariants] = useState<ToneVariant[]>([])
  const [genLoading, setGenLoading] = useState(false)
  const [saving, setSaving] = useState<number | null>(null)
  const offsetRef = useRef(0)

  useEffect(() => {
    listTracks('loop').then(setSaved).catch(() => { /* non-fatal */ })
    return () => previewRef.current?.stop()
  }, [])

  function preview(tone: string) {
    previewRef.current?.stop()
    if (previewing === tone) { setPreviewing(null); return }
    previewRef.current = previewTone(tone, 3500)
    setPreviewing(tone)
    window.setTimeout(() => setPreviewing((p) => (p === tone ? null : p)), 3500)
  }

  async function runGenerate(regen = false) {
    setGenLoading(true)
    if (regen) offsetRef.current += 6
    try { setVariants(await generateToneVariants(offsetRef.current)) }
    catch { toast.error('Could not generate tones'); setVariants([]) }
    finally { setGenLoading(false) }
  }

  async function pickVariant(v: ToneVariant) {
    setSaving(v.key)
    try {
      const title = `${v.label} tone`
      const tone = await saveToneVariant(v, title)
      onChange(tone, title)
      setSaved(await listTracks('loop'))
      setGenOpen(false)
      setVariants([])
      toast.success('Tone saved')
    } catch { toast.error('Could not save tone') }
    finally { setSaving(null) }
  }

  function Row({ tone, label, selected }: { tone: string; label: string; selected: boolean }) {
    const isPlaying = previewing === tone
    return (
      <div className={cn('flex items-center gap-2 rounded-control border px-2.5 py-2 transition-all',
        selected ? 'border-brand bg-brand/5' : 'border-border hover:border-border/80')}>
        <button type="button" onClick={() => preview(tone)}
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-foreground hover:bg-muted/70"
          aria-label={isPlaying ? 'Stop preview' : 'Preview'}>
          {isPlaying ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        </button>
        <button type="button" onClick={() => onChange(tone, label)} className="min-w-0 flex-1 truncate text-left text-sm font-medium">
          {label}
        </button>
        {selected && <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand text-brand-foreground"><Check className="size-3" strokeWidth={3} /></span>}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <p className="text-overline text-muted-foreground">Built-in</p>
        <div className="grid grid-cols-2 gap-2">
          {BUILTIN_TONES.map((t) => (
            <Row key={t.key} tone={`builtin:${t.key}`} label={t.label} selected={value === `builtin:${t.key}`} />
          ))}
        </div>
      </div>

      {saved.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-overline text-muted-foreground">Your tones</p>
          <div className="grid grid-cols-2 gap-2">
            {saved.map((t) => (
              <Row key={t.id} tone={`track:${t.id}`} label={t.title} selected={value === `track:${t.id}`} />
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        {!genOpen ? (
          <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => { setGenOpen(true); void runGenerate(false) }}>
            <Sparkles className="size-4" /> Generate a custom tone
          </Button>
        ) : (
          <div className="space-y-2 rounded-control border border-border/60 p-3">
            <div className="flex items-center justify-between">
              <p className="text-overline text-muted-foreground">Generated</p>
              <Button type="button" variant="ghost" size="sm" disabled={genLoading} onClick={() => void runGenerate(true)}>
                {genLoading ? <Spinner size="sm" /> : <RefreshCw className="size-3.5" />} Regenerate
              </Button>
            </div>
            <TrackVariantGrid<ToneVariant>
              variants={variants}
              loading={genLoading}
              pickingKey={saving}
              onSelect={(v) => void pickVariant(v)}
              columns={2}
              sublabel={(v) => `${v.styleId} · ${v.bpm} BPM`}
            />
            <p className="text-center text-[11px] text-muted-foreground">Tap a tone to save it and use it.</p>
          </div>
        )}
      </div>
    </div>
  )
}
