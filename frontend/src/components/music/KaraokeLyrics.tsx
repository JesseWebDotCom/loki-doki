import { useMemo } from 'react'
import { cn } from '@/lib/cn'
import { useRadio } from '@/context/RadioContext'
import type { LyricLine } from '@/lib/music/catalogApi'

// Big-screen karaoke lyric renderer. The active line fills left-to-right (the classic
// karaoke "wipe") over its own duration; the next line previews below so singers read
// ahead; instrumental gaps > 5s show countdown pips that extinguish into the next entry.
// Line-level LRCLIB timing gives a convincing word-ish sweep because we interpolate the
// fill across the whole gap to the next line.

interface Props {
  lines: LyricLine[] | null
  position: number      // engine position (sec)
  offsetSec?: number    // LRCLIB→audio alignment shift
  accent: string        // wipe/highlight colour (album palette vibrant)
  className?: string
}

const GAP_FOR_PIPS = 5   // seconds of instrumental before the count-in dots appear
const PIP_COUNT = 4
const UNSUNG = 'rgba(255,255,255,0.34)'

export function KaraokeLyrics({ lines, position, offsetSec = 0, accent, className }: Props) {
  // Read-ahead so lines arrive a touch before they're sung (user-tunable in Music settings).
  const { lyricLeadSec } = useRadio()
  const t = position - offsetSec + lyricLeadSec
  const synced = lines && lines.length > 0 ? lines : null

  const view = useMemo(() => {
    if (!synced) return null
    // Active line = last line whose time has passed. -1 before the first line.
    let active = -1
    for (let i = 0; i < synced.length; i++) {
      if (synced[i]!.sec <= t) active = i; else break
    }
    const cur = active >= 0 ? synced[active]! : null
    const next = synced[active + 1] ?? null
    const prev = active > 0 ? synced[active - 1] ?? null : null
    const nextNext = synced[active + 2] ?? null

    // Fill fraction across the active line's on-screen duration.
    const start = cur?.sec ?? 0
    const end = next?.sec ?? (cur ? start + 4 : 0)
    const fill = cur ? Math.max(0, Math.min(1, (t - start) / Math.max(0.5, end - start))) : 0

    // Count-in: when the NEXT line is > GAP_FOR_PIPS away and we're within its lead-in window,
    // show shrinking pips that land on the line's entry (also before the very first line).
    const gapStart = cur?.sec ?? 0
    const gapEnd = next?.sec ?? (active < 0 && synced[0] ? synced[0]!.sec : 0)
    const gap = gapEnd - (active < 0 ? 0 : gapStart)
    const inGap = next || active < 0
    const remaining = gapEnd - t
    const showPips = !!inGap && gap > GAP_FOR_PIPS && remaining > 0 && remaining <= PIP_COUNT + 0.5
    const pipsLit = showPips ? Math.ceil(remaining) : 0

    return { cur, next, prev, nextNext, fill, showPips, pipsLit }
  }, [synced, t])

  if (!synced) {
    return (
      <div className={cn('flex items-center justify-center text-center', className)}>
        <p className="text-2xl font-semibold text-white/40">No synced lyrics for this song</p>
      </div>
    )
  }

  const { cur, next, prev, nextNext, fill, showPips, pipsLit } = view!
  const note = next ? '♪' : ' '

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

      {/* Upcoming lines */}
      <p className="max-w-5xl truncate text-2xl font-semibold text-white/60 md:text-3xl">{next?.text || ' '}</p>
      <p className="max-w-4xl truncate text-xl font-medium text-white/30 md:text-2xl">{nextNext?.text || ' '}</p>
    </div>
  )
}
