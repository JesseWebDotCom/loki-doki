import { useLocation, useNavigate } from 'react-router-dom'
import { Play, Pause, SkipBack, SkipForward, ChevronUp, X } from 'lucide-react'
import { usePodcastPlayback } from '@/context/PodcastPlaybackContext'
import { ShowCover } from '@/components/podcast/ShowCover'
import { fmtTime } from '@/lib/podcast/format'

/**
 * Persistent slim player bar shown app-wide whenever a track is loaded, so
 * playback continues across navigation. Hidden inside /podcasts, where the full
 * Now Playing panel takes over.
 */
export function PodcastPlayerBar() {
  const { track, playing, positionSec, duration, pause, resume, next, prev, seek, close } = usePodcastPlayback()
  const navigate = useNavigate()
  const location = useLocation()

  if (!track || location.pathname.startsWith('/podcasts')) return null
  const total = track.durationSec || duration || 0
  const pct = total > 0 ? (positionSec / total) * 100 : 0

  return (
    <div className="relative z-40 shrink-0 border-t border-border/60 bg-background/95 backdrop-blur-md shadow-[0_-2px_12px_rgba(0,0,0,0.08)]">
      {/* Scrubber */}
      <div
        className="group absolute -top-1 left-0 h-2 w-full cursor-pointer"
        onClick={e => {
          const rect = e.currentTarget.getBoundingClientRect()
          if (total > 0) seek(((e.clientX - rect.left) / rect.width) * total)
        }}
      >
        <div className="absolute top-1 h-0.5 w-full bg-muted" />
        <div className="absolute top-1 h-0.5 bg-brand" style={{ width: `${pct}%` }} />
      </div>

      <div className="flex items-center gap-3 px-4 py-2">
        <button onClick={() => navigate('/podcasts')} className="flex items-center gap-3 min-w-0 flex-1 text-left">
          <ShowCover showId={track.showId ?? ''} title={track.showName} size={40} rounded="rounded-lg" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{track.title}</p>
            <p className="truncate text-xs text-muted-foreground">{track.showName}</p>
          </div>
        </button>

        <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">
          {fmtTime(positionSec)} / {fmtTime(total)}
        </span>

        <div className="flex items-center gap-1">
          <button onClick={prev} className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"><SkipBack className="size-4" /></button>
          <button onClick={playing ? pause : resume} className="flex size-9 items-center justify-center rounded-full bg-foreground text-background hover:opacity-90">
            {playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current ml-0.5" />}
          </button>
          <button onClick={next} className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"><SkipForward className="size-4" /></button>
          <button onClick={() => navigate('/podcasts')} className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground" aria-label="Open player"><ChevronUp className="size-4" /></button>
          <button onClick={close} className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground" aria-label="Close"><X className="size-3.5" /></button>
        </div>
      </div>
    </div>
  )
}
