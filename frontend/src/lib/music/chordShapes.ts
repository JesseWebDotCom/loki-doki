// Maps an Essentia chord label ("G", "Em", "A#:min", "N") to a playable guitar fingering, so
// the chord chart can show a fretboard diagram instead of just a text chip. Curated open-
// position shapes for the common chords guitarists actually expect open, falling back to a
// movable E-shape barre chord (built from the chromatic distance from E) for everything else -
// covers every major/minor triad without needing 24 hand-authored diagrams.

export interface ChordShape {
  /** One fret number per string, low E to high e; -1 = don't play (muted). */
  frets: number[]
  /** Fret the diagram starts at (1 = nut). >1 shows a "Nfr" marker instead of drawing the nut. */
  baseFret: number
}

const NOTES_FROM_E = ['E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B', 'C', 'C#', 'D', 'D#']
const FLAT_TO_SHARP: Record<string, string> = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' }

const OPEN_SHAPES: Record<string, ChordShape> = {
  'E:maj': { frets: [0, 2, 2, 1, 0, 0], baseFret: 1 },
  'E:min': { frets: [0, 2, 2, 0, 0, 0], baseFret: 1 },
  'A:maj': { frets: [-1, 0, 2, 2, 2, 0], baseFret: 1 },
  'A:min': { frets: [-1, 0, 2, 2, 1, 0], baseFret: 1 },
  'D:maj': { frets: [-1, -1, 0, 2, 3, 2], baseFret: 1 },
  'D:min': { frets: [-1, -1, 0, 2, 3, 1], baseFret: 1 },
  'G:maj': { frets: [3, 2, 0, 0, 0, 3], baseFret: 1 },
  'C:maj': { frets: [-1, 3, 2, 0, 1, 0], baseFret: 1 },
}

// Movable E-shape barre pattern (relative to the barre fret): all six strings ring, root on
// the low E string. Works for any root by sliding it to that root's fret distance from open E.
const BARRE_MAJ = [0, 2, 2, 1, 0, 0]
const BARRE_MIN = [0, 2, 2, 0, 0, 0]

/** Essentia emits both "G:maj"/"A#:min" and pre-abbreviated "G"/"Em" across versions of the
 *  analysis script - handle either. Returns null for "N" (no chord) or anything unparseable. */
export function parseChordLabel(raw: string): { root: string; quality: 'maj' | 'min' } | null {
  if (!raw || raw === 'N') return null
  let label = raw
  let quality: 'maj' | 'min' = 'maj'
  if (label.includes(':')) {
    const [root, q] = label.split(':')
    label = root ?? ''
    quality = q === 'min' ? 'min' : 'maj'
  } else if (/^[A-G][#b]?m$/.test(label)) {
    quality = 'min'
    label = label.slice(0, -1)
  }
  const root = FLAT_TO_SHARP[label] ?? label
  if (!NOTES_FROM_E.includes(root)) return null
  return { root, quality }
}

export function chordShapeFor(raw: string): ChordShape | null {
  const parsed = parseChordLabel(raw)
  if (!parsed) return null
  const { root, quality } = parsed
  const key = `${root}:${quality}`
  if (OPEN_SHAPES[key]) return OPEN_SHAPES[key]

  const barreFret = NOTES_FROM_E.indexOf(root)   // 0 for E itself (already an open shape above)
  const pattern = quality === 'min' ? BARRE_MIN : BARRE_MAJ
  if (barreFret <= 0) return { frets: pattern, baseFret: 1 }
  return { frets: pattern.map((f) => f + barreFret), baseFret: barreFret }
}
