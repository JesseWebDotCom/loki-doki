import { useRef, useState } from 'react'
import { Loader2, Check, Play, Pause } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface VariantItem {
  key: string | number
  label: string
  previewUrl: string
}

/**
 * Variant picker grid with a shared audio player — the generated/remixed sibling of
 * the cover-art grid. Extracted from StingerPicker so the podcast intro/outro picker
 * and the Music app's Generate/Remix tabs render takes identically.
 */
export function TrackVariantGrid<T extends VariantItem>({
  variants, loading = false, error = null, selectedKey = null, pickingKey = null,
  onSelect, columns = 2, sublabel,
}: {
  variants: T[]
  loading?: boolean
  error?: string | null
  selectedKey?: string | number | null
  pickingKey?: string | number | null
  onSelect: (v: T) => void
  columns?: number
  /** Optional secondary line under a variant's label. */
  sublabel?: (v: T) => string | null | undefined
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState<string | number | null>(null)
  const grid = columns === 3 ? 'grid-cols-3' : columns === 1 ? 'grid-cols-1' : 'grid-cols-2'

  function togglePlay(v: T) {
    const el = audioRef.current
    if (!el) return
    if (playing === v.key) { el.pause(); setPlaying(null); return }
    el.src = v.previewUrl
    el.play().then(() => setPlaying(v.key)).catch(() => setPlaying(null))
  }

  if (loading) {
    return (
      <div className={cn('grid gap-2', grid)}>
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-14 animate-pulse rounded-xl bg-muted/60" />)}
      </div>
    )
  }
  if (error) {
    return <p className="rounded-lg border border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">{error}</p>
  }

  return (
    <>
      <audio ref={audioRef} onEnded={() => setPlaying(null)} className="hidden" />
      <div className={cn('grid gap-2', grid)}>
        {variants.map((v) => {
          const isSel = selectedKey === v.key
          const isPicking = pickingKey === v.key
          const isPlaying = playing === v.key
          const sub = sublabel?.(v)
          return (
            <div key={v.key}
              className={cn('relative flex items-center gap-2 rounded-xl border px-2.5 py-2 transition-all',
                isSel ? 'border-brand bg-brand/5' : 'border-border hover:border-border/80')}>
              <button type="button" onClick={() => togglePlay(v)}
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-foreground hover:bg-muted/70"
                aria-label={isPlaying ? 'Pause' : 'Play'}>
                {isPlaying ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
              </button>
              <button type="button" onClick={() => onSelect(v)} className="min-w-0 flex-1 text-left">
                <div className="truncate text-sm font-medium">{v.label}</div>
                {sub ? <div className="truncate text-xs text-muted-foreground">{sub}</div> : null}
              </button>
              {isPicking
                ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                : isSel && <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand text-brand-foreground"><Check className="size-3" strokeWidth={3} /></span>}
            </div>
          )
        })}
      </div>
    </>
  )
}
