import { Play } from 'lucide-react'

/**
 * Full-surface tap-to-toggle: click anywhere on the video to play/pause, with a play badge
 * shown only while paused (matches YouTube's own player). Has no z-index of its own, so
 * PlayerControlBar's explicit z-10 always wins where the two overlap on hover.
 */
export function PlayerClickToggle({ playing, onToggle }: { playing: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} aria-label={playing ? 'Pause' : 'Play'} className="absolute inset-0 flex items-center justify-center">
      {!playing && (
        // design-ok(backdrop-blur-outside-chrome): play badge floats over the video surface
        <span className="flex size-16 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur">
          <Play className="size-7 fill-current" />
        </span>
      )}
    </button>
  )
}
