import { ChordDiagram } from '@/components/music/studio/ChordDiagram'
import { pretty } from '@/components/music/studio/ChordTimeline'
import type { StudioChord } from '@/lib/music/studioApi'

/** A single, large fingering diagram for whichever chord is under the playhead right now -
 *  the ChordTimeline strip is great for seeing what's coming, but too small at speed to read a
 *  fretboard off; this sits beside it so practicing along means glancing at one big shape. */
export function ActiveChordDiagram({ chords, position }: { chords: StudioChord[]; position: number }) {
  const active = chords.find((c) => position >= c.startTime && position < c.endTime)
  if (!active) return null
  return (
    <div className="flex shrink-0 flex-col items-center gap-0.5 rounded-card bg-card/50 px-2 py-1.5">
      <ChordDiagram label={active.label} className="h-10 w-10 text-foreground" />
      <span className="text-[11px] font-semibold tabular-nums text-muted-foreground">{pretty(active.label)}</span>
    </div>
  )
}
