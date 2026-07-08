// Chordify/Moises-style chord timeline: chords are laid out along a time axis and the whole
// strip scrolls left so the current moment sits under a fixed playhead, with upcoming chords
// flowing in from the right. The chord under the playhead is highlighted. Only the chords in
// the visible window are rendered, so a long song stays cheap even at 60fps.
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import type { StudioChord } from '@/lib/music/studioApi'

const PX_PER_SEC = 90
const PLAYHEAD_FRAC = 0.3   // playhead sits 30% from the left, so you see what's coming

// Essentia labels: "G", "Em", "A#:min", "N" (no chord). Prettify for display.
function pretty(label: string): string {
  if (!label || label === 'N') return '-'
  return label.replace(':maj', '').replace(':min', 'm').replace(':', '')
}

export function ChordTimeline({ chords, position, onSeek }: {
  chords: StudioChord[]; position: number; onSeek?: (t: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current; if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el); setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  if (chords.length === 0) return null
  const playheadX = width * PLAYHEAD_FRAC
  const posPx = position * PX_PER_SEC
  const translateX = playheadX - posPx
  const viewLeft = posPx - playheadX - 120       // px range currently on screen (+ margin)
  const viewRight = posPx + (width - playheadX) + 120

  return (
    <div ref={ref} className="relative h-16 overflow-hidden rounded-card bg-card/50">
      {/* fixed playhead */}
      <div className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-brand" style={{ left: playheadX }} />
      {/* scrolling track */}
      <div className="absolute inset-y-0 left-0 will-change-transform" style={{ transform: `translateX(${translateX}px)` }}>
        {chords.map((c, i) => {
          const left = c.startTime * PX_PER_SEC
          const w = Math.max(6, (c.endTime - c.startTime) * PX_PER_SEC)
          if (left + w < viewLeft || left > viewRight) return null   // offscreen, skip
          const active = position >= c.startTime && position < c.endTime
          return (
            <Button
              key={`${c.startTime}-${i}`}
              variant={active ? 'default' : 'secondary'} size="sm"
              onClick={() => onSeek?.(c.startTime)}
              className={cn('absolute top-1/2 -translate-y-1/2 justify-center overflow-hidden font-semibold tabular-nums', !active && 'text-muted-foreground')}
              style={{ left, width: w - 4 }}
            >{pretty(c.label)}</Button>
          )
        })}
      </div>
    </div>
  )
}
