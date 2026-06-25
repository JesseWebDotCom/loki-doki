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
  /** Fires true on grab / false on release — lets the parent pause position polling mid-drag. */
  onScrubStateChange?: (scrubbing: boolean) => void
  className?: string
}

export function SeekBar({ pos, total, onSeek, accent = '#dc2626', disabled, onScrubStateChange, className }: SeekBarProps) {
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
      <div className="h-1 w-full overflow-hidden rounded-full bg-foreground/20">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: accent }} />
      </div>
      {!disabled && (
        <span className="absolute size-3 -translate-x-1/2 rounded-full shadow transition-transform group-hover:scale-110"
          style={{ left: `${pct}%`, background: accent }} />
      )}
    </div>
  )
}
