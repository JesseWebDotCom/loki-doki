import { useRef, useState } from 'react'
import { cn } from '@/lib/cn'

/**
 * Shared scrub/seek track for the docked mini-players (YouTube + AI Radio).
 *
 * Renders the progress track + draggable thumb and reports an absolute seek position in
 * seconds via `onSeek`. While the user drags, it shows a local preview fraction (so it
 * doesn't fight the parent's position polling) and streams `onSeek` continuously. Pointer
 * capture makes the drag survive leaving the 3px-tall hit area.
 */
export interface SeekBarProps {
  /** Current playback position, seconds. */
  pos: number
  /** Total length, seconds. 0/unknown disables scrubbing. */
  total: number
  /** Called with an absolute seconds target as the user scrubs. */
  onSeek: (sec: number) => void
  /** CSS colour for the fill + thumb. Defaults to YouTube red. */
  accent?: string
  /** Greys out + blocks interaction (e.g. live stream, or DJ talking on radio). */
  disabled?: boolean
  /** Fires true on grab / false on release; lets the parent pause position polling mid-drag. */
  onScrubStateChange?: (scrubbing: boolean) => void
  /** Optional marker positions in seconds (e.g. podcast chapter starts): subtle ticks on the track. */
  ticks?: number[]
  /** Optional highlighted time ranges (e.g. detected podcast ads): translucent amber spans. */
  ranges?: { startSec: number; endSec: number }[]
  className?: string
}

// design-ok(hex-in-tsx): per-player accent default (YouTube red), passed into inline styles
export function SeekBar({ pos, total, onSeek, accent = '#dc2626', disabled, onScrubStateChange, ticks, ranges, className }: SeekBarProps) {
  const barRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null) // local fraction 0..1 while scrubbing

  const pct = drag != null ? drag * 100 : (total > 0 ? Math.max(0, Math.min(100, (pos / total) * 100)) : 0)

  const fracFrom = (clientX: number) => {
    const el = barRef.current; if (!el) return 0
    const r = el.getBoundingClientRect()
    return Math.max(0, Math.min((clientX - r.left) / r.width, 1))
  }
  const onDown = (e: React.PointerEvent) => {
    if (disabled || total <= 0) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    onScrubStateChange?.(true)
    const f = fracFrom(e.clientX); setDrag(f); onSeek(f * total)
  }
  const onMove = (e: React.PointerEvent) => {
    if (drag == null) return
    const f = fracFrom(e.clientX); setDrag(f); onSeek(f * total)
  }
  const onUp = (e: React.PointerEvent) => {
    if (drag == null) return
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* not captured */ }
    setDrag(null); onScrubStateChange?.(false)
  }

  return (
    <div ref={barRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
      className={cn('group relative flex h-3 touch-none items-center', disabled ? 'cursor-default opacity-40' : 'cursor-pointer', className)}>
      <div className="relative h-1 w-full overflow-hidden rounded-full bg-foreground/20">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: accent }} />
        {/* Highlighted ranges (detected ads): amber reads over both track halves and is
            deliberately not the accent color. */}
        {total > 0 && ranges?.filter(r => r.endSec > r.startSec && r.startSec < total).map((r, i) => (
          // design-ok(raw-palette-semantic): semantic "ad range" amber, distinct from the per-player accent
          <span key={i} aria-hidden className="absolute top-0 h-full rounded-full bg-amber-400/60"
            style={{
              left: `${(r.startSec / total) * 100}%`,
              width: `${((Math.min(r.endSec, total) - r.startSec) / total) * 100}%`,
            }} />
        ))}
        {/* Chapter ticks: subtle marks that read over both the played and unplayed track. */}
        {total > 0 && ticks?.filter(t => t > 0 && t < total).map((t, i) => (
          <span key={i} aria-hidden className="absolute top-0 h-full w-px bg-background/70"
            style={{ left: `${(t / total) * 100}%` }} />
        ))}
      </div>
      {!disabled && (
        <span className="absolute size-3 -translate-x-1/2 rounded-full shadow transition-transform group-hover:scale-110"
          style={{ left: `${pct}%`, background: accent }} />
      )}
    </div>
  )
}
