import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { plexStreamUrl } from '@/lib/plex/api'
import { useMediaProgress } from '@/hooks/useMediaProgress'

// Full-screen in-app player for a Plex item we can direct-play (h264/aac mp4). Streams the
// original file bytes through the range-aware /api/plex/stream proxy; no token in the client.
export function PlexPlayer({ ratingKey, title, onClose }: { ratingKey: string; title: string; onClose: () => void }) {
  // Cross-device resume: heartbeat this user's position to media_progress and pick up where
  // any device left off. The <video> mounts only once the saved position is known (a fast
  // local fetch), so playback never visibly starts at 0 and then jumps.
  const { resumeAt, ready, report, flush } = useMediaProgress('plex', ratingKey)
  const completedSent = useRef(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-black/95">
      <div className="flex items-center justify-between px-4 py-3">
        <p className="line-clamp-1 text-sm font-medium text-white/90">{title}</p>
        {/* design-ok(glass-on-plain-bg): over full-screen video surface */}
        <Button variant="ghost" size="icon" onClick={onClose} className="text-white/70 hover:bg-white/10 hover:text-white" aria-label="Close player">
          <X className="size-5" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 pb-4">
        {ready && (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            src={plexStreamUrl(ratingKey)}
            controls
            autoPlay
            onLoadedMetadata={(e) => {
              const v = e.currentTarget
              if (resumeAt != null && resumeAt < (v.duration || Infinity) * 0.95) v.currentTime = resumeAt
            }}
            onTimeUpdate={(e) => {
              const v = e.currentTarget
              const done = v.duration > 0 && v.currentTime / v.duration > 0.95
              // `completed` forces an immediate flush in the hook, so send it once, not per tick.
              if (done && !completedSent.current) { completedSent.current = true; report(v.currentTime, v.duration, true) }
              else if (!done) report(v.currentTime, v.duration || null)
            }}
            onPause={() => flush()}
            className="max-h-full max-w-full rounded-card"
          />
        )}
      </div>
    </div>
  )
}
