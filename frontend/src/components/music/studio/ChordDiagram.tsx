import { chordShapeFor } from '@/lib/music/chordShapes'

const STRING_X = [6, 16, 26, 36, 46, 56]
const ROW_H = 11
const TOP_Y = 12
const ROWS = 3

/** Small guitar fretboard diagram for a chord label ("G", "Em", "A#:min"). Renders nothing for
 *  labels chordShapeFor can't resolve (e.g. "N"/no-chord) - callers should fall back to text. */
export function ChordDiagram({ label, className }: { label: string; className?: string }) {
  const shape = chordShapeFor(label)
  if (!shape) return null
  const { frets, baseFret } = shape

  return (
    <svg viewBox="0 0 62 58" className={className} aria-hidden>
      {/* fret lines */}
      {Array.from({ length: ROWS + 1 }, (_, i) => (
        <line key={i} x1={STRING_X[0]} x2={STRING_X[5]} y1={TOP_Y + i * ROW_H} y2={TOP_Y + i * ROW_H}
          stroke="currentColor" strokeWidth={i === 0 && baseFret === 1 ? 2.5 : 1} opacity={i === 0 ? 1 : 0.5} />
      ))}
      {/* string lines */}
      {STRING_X.map((x, i) => (
        <line key={i} x1={x} x2={x} y1={TOP_Y} y2={TOP_Y + ROWS * ROW_H} stroke="currentColor" strokeWidth={1} opacity={0.5} />
      ))}
      {/* base-fret marker for barre shapes */}
      {baseFret > 1 && (
        <text x={STRING_X[0] - 4} y={TOP_Y + ROW_H - 1} fontSize={8} textAnchor="end" fill="currentColor">{baseFret}</text>
      )}
      {/* per-string markers */}
      {frets.map((f, i) => {
        const x = STRING_X[i]!
        if (f < 0) return <text key={i} x={x} y={TOP_Y - 3} fontSize={7} textAnchor="middle" fill="currentColor">×</text>
        if (f === 0) return <circle key={i} cx={x} cy={TOP_Y - 5} r={2.5} fill="none" stroke="currentColor" strokeWidth={1} />
        const row = f - baseFret + 1
        if (row < 1 || row > ROWS) return null
        return <circle key={i} cx={x} cy={TOP_Y + (row - 0.5) * ROW_H} r={3.4} fill="currentColor" />
      })}
    </svg>
  )
}
