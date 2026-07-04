import { Play, X } from 'lucide-react'
import { VideoThumb } from '@/components/youtube/media'
import type { VideoItem } from '@/lib/youtube/types'

/** Overlay shown on top of the player once a video ends, before autoplay jumps to the
 *  next one — gives the viewer a beat to cancel instead of being yanked into the next
 *  video immediately (Netflix/Plex's "Playing next in Ns" pattern). */
export function AutoplayCountdown({ nextItem, secondsLeft, total, onCancel, onPlayNow }: {
  nextItem: VideoItem
  secondsLeft: number
  total: number
  onCancel: () => void
  onPlayNow: () => void
}) {
  const pct = total > 0 ? Math.min(100, Math.max(0, ((total - secondsLeft) / total) * 100)) : 100
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-sm rounded-card border border-white/10 bg-zinc-900/95 p-4 text-white shadow-xl">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-white/60">Up next in {secondsLeft}s</p>
        <button onClick={onPlayNow} className="group mb-3 flex w-full gap-3 text-left">
          <div className="relative w-32 shrink-0 overflow-hidden rounded-control">
            <VideoThumb videoId={nextItem.videoId} title={nextItem.title} className="aspect-video size-full" />
            <span className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition-opacity group-hover:opacity-100">
              <Play className="size-6 fill-current" />
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-sm font-semibold leading-snug">{nextItem.title}</p>
            {nextItem.author && <p className="mt-1 truncate text-xs text-white/60">{nextItem.author}</p>}
          </div>
        </button>
        <div className="mb-3 h-1 overflow-hidden rounded-full bg-white/15">
          <div className="h-full rounded-full bg-[var(--yt-accent)] transition-[width]" style={{ width: `${pct}%` }} />
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onPlayNow} className="flex-1 rounded-control bg-[var(--yt-accent)] px-3 py-2 text-sm font-semibold text-[var(--yt-accent-fg)] transition hover:opacity-90">
            Play now
          </button>
          <button onClick={onCancel} aria-label="Cancel" title="Cancel"
            className="flex items-center gap-1.5 rounded-control border border-white/15 px-3 py-2 text-sm font-medium text-white/80 transition hover:bg-white/10">
            <X className="size-4" /> Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
