// Scrolling chord row synced to playback position (Chordify/Moises style). Highlights the
// chord under the playhead and keeps it scrolled into view.
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import type { StudioChord } from '@/lib/music/studioApi'

interface Props { chords: StudioChord[]; position: number; onSeek?: (t: number) => void }

// Essentia emits chord labels like "G", "Em", "A#:min", "N" (no chord). Prettify for display.
function pretty(label: string): string {
  if (!label || label === 'N') return '-'
  return label.replace(':maj', '').replace(':min', 'm').replace(':', '')
}

export function ChordRow({ chords, position, onSeek }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeIdx = chords.findIndex((c) => position >= c.startTime && position < c.endTime)

  useEffect(() => {
    const el = scrollRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    el?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [activeIdx])

  if (chords.length === 0) return null

  return (
    <div ref={scrollRef} className="flex gap-2 overflow-x-auto pb-1">
      {chords.map((c, i) => {
        const active = i === activeIdx
        return (
          <Button
            key={`${c.startTime}-${i}`}
            variant={active ? 'default' : 'secondary'}
            size="sm"
            data-active={active}
            onClick={() => onSeek?.(c.startTime)}
            className={cn('min-w-12 shrink-0 font-semibold tabular-nums', !active && 'text-muted-foreground')}
          >{pretty(c.label)}</Button>
        )
      })}
    </div>
  )
}
