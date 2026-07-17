import { Play } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'

/**
 * Full-surface tap-to-toggle: click anywhere on the video to play/pause, with a play badge
 * shown only while paused (matches YouTube's own player). Has no z-index of its own, so
 * PlayerControlBar's explicit z-10 always wins where the two overlap on hover.
 *
 * `gestureHandlers` are the pointer handlers from useVideoGestures (double-tap seek,
 * hold-to-2x) - the same surface serves both, and `suppressClick` lets a fired gesture
 * swallow the click that would otherwise toggle playback on release.
 */
export function PlayerClickToggle({ playing, onToggle, gestureHandlers, suppressClick, children }: {
  playing: boolean
  onToggle: () => void
  gestureHandlers?: Pick<ComponentProps<'button'>, 'onPointerDown' | 'onPointerUp' | 'onPointerCancel' | 'onPointerLeave'>
  suppressClick?: () => boolean
  /** Transient gesture feedback rendered over the surface. */
  children?: ReactNode
}) {
  return (
    <button onClick={() => { if (suppressClick?.()) return; onToggle() }}
      aria-label={playing ? 'Pause' : 'Play'} {...gestureHandlers}
      className="absolute inset-0 flex items-center justify-center">
      {!playing && (
        // design-ok(backdrop-blur-outside-chrome): play badge floats over the video surface
        <span className="flex size-16 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur">
          <Play className="size-7 fill-current" />
        </span>
      )}
      {children}
    </button>
  )
}
