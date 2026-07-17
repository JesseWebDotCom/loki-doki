import { useMemo } from 'react'
import { cn } from '@/lib/cn'
import { useRadio } from '@/context/RadioContext'
import { useActiveLyricIndex } from './nowPlayingParts'
import type { LyricLine, TranslatedLyricLine } from '@/lib/music/catalogApi'

// Big-screen karaoke lyric renderer. The active line fills left-to-right (the classic
// karaoke "wipe") over its own duration; the next line previews below so singers read
// ahead; instrumental gaps > 5s show countdown pips that extinguish into the next entry.
// When the line carries per-word timings (Studio's forced alignment), the wipe paces
// itself to each word's own start/end instead of interpolating across the whole line —
// that per-word data is what makes the sweep track the actual singing rather than
// crawling too slowly on long lines or racing ahead on short ones. Lines without word
// timings (raw LRCLIB) fall back to the old whole-line interpolation.

interface Props {
  lines: LyricLine[] | null
  position: number      // engine position (sec)
  offsetSec?: number    // LRCLIB→audio alignment shift
  accent: string        // wipe/highlight colour (album palette vibrant)
  className?: string
  /** Optional per-line translation/romanization, index-aligned with `lines`. */
  secondary?: TranslatedLyricLine[] | null
  /** Show the romanized pronunciation line (non-Latin sources). */
  showRoman?: boolean
}

const GAP_FOR_PIPS = 5   // seconds of instrumental before the count-in dots appear
const PIP_COUNT = 4
const UNSUNG = 'rgba(255,255,255,0.34)'

// How early the ACTIVE line swaps in, ahead of its first sung word. Two clocks on purpose:
// the line must arrive early enough to read (highlighting exactly on the onset reads as
// late — CTC onsets also land a hair after the perceived attack), but the wipe must fill on
// the true word times or it runs ahead of the singing. Floor, not replacement: a larger
// user-set lyric lead (Music → Settings) still wins.
const LINE_LEAD_SEC = 0.55

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

// Fraction (0-1) of the line "sung" so far, weighted by character count per word so the
// wipe's pace tracks real word durations instead of a flat sweep. Holds steady during the
// small gap between two words (rather than creeping forward) so it never reads as ahead of
// the singer. Falls back to whole-line interpolation when this line has no word timings.
function wordWipeFill(cur: LyricLine, next: LyricLine | null, t: number): number {
  const words = cur.words
  if (!words?.length) {
    const start = cur.sec
    const end = next?.sec ?? start + 4
    return clamp01((t - start) / Math.max(0.5, end - start))
  }
  let charPos = 0
  const spans = words.map((w) => {
    const charStart = charPos
    charPos += w.text.length + 1   // +1 for the space before the next word
    return { sec: w.sec, end: w.end, charStart, charEnd: charPos - 1 }
  })
  const totalChars = Math.max(1, charPos - 1)
  let sungChars = 0
  for (const s of spans) {
    if (t >= s.end) { sungChars = s.charEnd; continue }
    if (t > s.sec) sungChars = s.charStart + (s.charEnd - s.charStart) * clamp01((t - s.sec) / Math.max(0.05, s.end - s.sec))
    break
  }
  return clamp01(sungChars / totalChars)
}

export function KaraokeLyrics({ lines, position, offsetSec = 0, accent, className, secondary, showRoman = true }: Props) {
  // Read-ahead so lines arrive a touch before they're sung (user-tunable in Music settings).
  const { lyricLeadSec } = useRadio()
  const t = position - offsetSec + lyricLeadSec
  const synced = lines && lines.length > 0 ? lines : null
  // Locked active-line index: once advanced it only moves back on a real seek, so timing
  // jitter right at a line boundary can't flip the highlight back onto the previous line.
  // Activated LINE_LEAD_SEC early (see above); the wipe below stays on the unled clock.
  const active = useActiveLyricIndex(synced, position, offsetSec, Math.max(lyricLeadSec, LINE_LEAD_SEC))

  const view = useMemo(() => {
    if (!synced) return null
    const cur = active >= 0 ? synced[active]! : null
    const next = synced[active + 1] ?? null
    const prev = active > 0 ? synced[active - 1] ?? null : null
    const nextNext = synced[active + 2] ?? null

    const fill = cur ? wordWipeFill(cur, next, t) : 0

    // Count-in: when the NEXT line is > GAP_FOR_PIPS away and we're within its lead-in window,
    // show shrinking pips that land on the line's entry (also before the very first line).
    // The gap is measured from when the current line's SINGING ends (its last word), not
    // from the line's start — a line whose own window just exceeds the threshold (held
    // note, slow phrase) is not an instrumental break, and measuring from the start made
    // the pips replace it mid-song ("Born and raised in South Detroit" flashed, then dots).
    const curSungEnd = cur?.words?.length ? cur.words[cur.words.length - 1]!.end : null
    const gapStart = cur ? (curSungEnd ?? cur.sec) : 0
    const gapEnd = next?.sec ?? (active < 0 && synced[0] ? synced[0]!.sec : 0)
    const gap = gapEnd - (active < 0 ? 0 : gapStart)
    const inGap = next || active < 0
    // Without word timing we can't tell when singing ends, so demand a much larger window
    // before concluding the line is over and swapping in the countdown.
    const minGap = cur && curSungEnd == null ? GAP_FOR_PIPS * 2 : GAP_FOR_PIPS
    const remaining = gapEnd - t
    const showPips = !!inGap && gap > minGap && remaining > 0 && remaining <= PIP_COUNT + 0.5
    const pipsLit = showPips ? Math.ceil(remaining) : 0

    return { cur, next, prev, nextNext, fill, showPips, pipsLit }
  }, [synced, active, t])

  if (!synced) {
    return (
      <div className={cn('flex items-center justify-center text-center', className)}>
        <p className="text-2xl font-semibold text-white/40">No synced lyrics for this song</p>
      </div>
    )
  }

  const { cur, next, prev, nextNext, fill, showPips, pipsLit } = view!
  const note = next ? '♪' : ' '
  // Translation / pronunciation for the active + upcoming line (index-aligned arrays).
  const curSec = cur && secondary ? secondary[active] ?? null : null
  const nextSec = next && secondary ? secondary[active + 1] ?? null : null

  return (
    <div className={cn('flex flex-col items-center justify-center gap-6 px-8 text-center', className)}>
      {/* Previous line (fading up) */}
      <p className="max-w-5xl truncate text-2xl font-semibold text-white/25 md:text-3xl">{prev?.text || ' '}</p>

      {/* Active line with the wipe fill, or the count-in pips during an instrumental gap */}
      {showPips ? (
        <div className="flex items-center gap-4 py-4" aria-hidden>
          {Array.from({ length: PIP_COUNT }).map((_, i) => (
            <span key={i} className="size-5 rounded-full transition-all duration-200"
              style={{ background: i < pipsLit ? accent : 'rgba(255,255,255,0.15)', transform: i < pipsLit ? 'scale(1)' : 'scale(0.7)' }} />
          ))}
        </div>
      ) : (
        // The wipe is a hard-stop gradient clipped to the text itself (background-clip: text),
        // so it fills left→right AND wraps correctly on multi-line lines. The old approach laid a
        // single-line coloured copy over the wrapping base text, which drifted out of alignment.
        <p className="max-w-6xl text-4xl font-black leading-tight tracking-tight md:text-6xl"
          style={cur ? {
            backgroundImage: `linear-gradient(to right, ${accent} ${fill * 100}%, ${UNSUNG} ${fill * 100}%)`,
            WebkitBackgroundClip: 'text', backgroundClip: 'text',
            WebkitTextFillColor: 'transparent', color: 'transparent',
          } : { color: UNSUNG }}>
          {cur?.text || note}
        </p>
      )}

      {/* Secondary lines for the active entry: romanized pronunciation (sing this) above
          the translation (understand this). Both optional, driven by the language menu. */}
      {!showPips && curSec && (showRoman && curSec.r ? (
        <div className="flex flex-col items-center gap-1">
          <p className="max-w-5xl text-2xl font-semibold md:text-3xl" style={{ color: accent }}>{curSec.r}</p>
          {curSec.t && <p className="max-w-5xl text-xl font-medium text-white/55 md:text-2xl">{curSec.t}</p>}
        </div>
      ) : curSec.t ? (
        <p className="max-w-5xl text-xl font-medium text-white/55 md:text-2xl">{curSec.t}</p>
      ) : null)}

      {/* Upcoming lines */}
      <div className="flex flex-col items-center gap-1">
        <p className="max-w-5xl truncate text-2xl font-semibold text-white/60 md:text-3xl">{next?.text || ' '}</p>
        {nextSec && (showRoman && nextSec.r ? (
          <p className="max-w-5xl truncate text-lg font-medium text-white/35 md:text-xl">{nextSec.r}</p>
        ) : nextSec.t ? (
          <p className="max-w-5xl truncate text-lg font-medium text-white/35 md:text-xl">{nextSec.t}</p>
        ) : null)}
      </div>
      <p className="max-w-4xl truncate text-xl font-medium text-white/30 md:text-2xl">{nextNext?.text || ' '}</p>
    </div>
  )
}
