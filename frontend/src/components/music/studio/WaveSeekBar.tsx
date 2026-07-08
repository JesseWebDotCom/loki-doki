// The main transport position bar, backgrounded with the full-song waveform (all stems mixed)
// so you can see the song's shape and click/drag anywhere to hop to that section. Reuses
// StemWaveform for the peaks render; adds a playhead line + pointer seek.
import { useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { StemWaveform } from './StemWaveform'

export function WaveSeekBar({ peaks, position, total, onSeek, onScrubStateChange, className }: {
  peaks: number[]
  position: number
  total: number
  onSeek: (sec: number) => void
  onScrubStateChange?: (scrubbing: boolean) => void
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)   // fraction 0..1 while scrubbing
  const frac = drag != null ? drag : (total > 0 ? Math.max(0, Math.min(1, position / total)) : 0)

  const fracFrom = (clientX: number) => {
    const el = ref.current; if (!el) return 0
    const r = el.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width))
  }
  const down = (e: React.PointerEvent) => {
    if (total <= 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag(fracFrom(e.clientX)); onScrubStateChange?.(true)
  }
  const move = (e: React.PointerEvent) => { if (drag != null) setDrag(fracFrom(e.clientX)) }
  const up = (e: React.PointerEvent) => {
    if (drag == null) return
    const f = fracFrom(e.clientX)
    setDrag(null); onScrubStateChange?.(false); onSeek(f * total)
  }

  return (
    <div
      ref={ref} onPointerDown={down} onPointerMove={move} onPointerUp={up}
      className={cn('relative h-16 cursor-pointer touch-none overflow-hidden rounded-card bg-card/50', total <= 0 && 'pointer-events-none', className)}
    >
      <StemWaveform peaks={peaks} progress={frac} active className="absolute inset-0 size-full" />
      <div className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-brand" style={{ left: `${frac * 100}%` }} />
    </div>
  )
}
