import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { SkipForward, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { plexStreamUrl, getPlexSegments, getPlexTrickplay, type MediaSegment, type TrickplayInfo } from '@/lib/plex/api'
import { useMediaProgress } from '@/hooks/useMediaProgress'
import { fmtClock } from '@/lib/youtube/format'

// Full-screen in-app player for a Plex item we can direct-play (h264/aac mp4). Streams the
// original file bytes through the range-aware /api/plex/stream proxy; no token in the client.

const SKIP_LABEL: Partial<Record<MediaSegment['type'], string>> = {
  intro: 'Skip intro',
  recap: 'Skip recap',
  credits: 'Skip credits',
  preview: 'Skip preview',
}

/** The segment covering `sec`, if it's one we offer to skip. */
function activeSegment(segments: MediaSegment[], sec: number): MediaSegment | null {
  return segments.find((s) => SKIP_LABEL[s.type] && sec >= s.startSec && sec < s.endSec - 1) ?? null
}

export function PlexPlayer({ ratingKey, title, onClose }: { ratingKey: string; title: string; onClose: () => void }) {
  // Cross-device resume: heartbeat this user's position to media_progress and pick up where
  // any device left off. The <video> mounts only once the saved position is known (a fast
  // local fetch), so playback never visibly starts at 0 and then jumps.
  const { resumeAt, ready, report, flush } = useMediaProgress('plex', ratingKey)
  const completedSent = useRef(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [hoverRatio, setHoverRatio] = useState<number | null>(null)

  // Skip intro/credits: detected from the file's own chapters server-side (no Plex Pass
  // needed). A file without named chapters yields [], which simply shows no button.
  const { data: segments = [] } = useQuery({
    queryKey: ['plex-segments', ratingKey],
    queryFn: () => getPlexSegments(ratingKey),
    staleTime: 60 * 60_000,
  })
  // Scrubber previews, generated on first open by one ffmpeg keyframe pass.
  const { data: trickplay } = useQuery({
    queryKey: ['plex-trickplay', ratingKey],
    queryFn: () => getPlexTrickplay(ratingKey),
    staleTime: 60 * 60_000,
  })

  const skip = activeSegment(segments, position)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const seekTo = (sec: number) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = sec
    setPosition(sec)
  }

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
          <div className="relative flex max-h-full max-w-full flex-col">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              ref={videoRef}
              src={plexStreamUrl(ratingKey)}
              controls
              autoPlay
              onLoadedMetadata={(e) => {
                const v = e.currentTarget
                setDuration(v.duration || 0)
                if (resumeAt != null && resumeAt < (v.duration || Infinity) * 0.95) v.currentTime = resumeAt
              }}
              onTimeUpdate={(e) => {
                const v = e.currentTarget
                setPosition(v.currentTime)
                const done = v.duration > 0 && v.currentTime / v.duration > 0.95
                // `completed` forces an immediate flush in the hook, so send it once, not per tick.
                if (done && !completedSent.current) { completedSent.current = true; report(v.currentTime, v.duration, true) }
                else if (!done) report(v.currentTime, v.duration || null)
              }}
              onPause={() => flush()}
              className="max-h-full max-w-full rounded-card"
            />

            {/* Skip intro/credits: the most-loved affordance in streaming UI, sitting just
                above the native controls while its segment plays. */}
            {skip && (
              // design-ok(raw-palette-semantic) design-ok(backdrop-blur-outside-chrome) design-ok(hand-styled-button): skip chip over the video surface
              <button onClick={() => seekTo(skip.endSec)}
                className="absolute bottom-20 right-4 flex items-center gap-1.5 rounded-card border border-white/20 bg-black/70 px-3.5 py-2 text-sm font-semibold text-white backdrop-blur transition hover:bg-black/90">
                <SkipForward className="size-4" /> {SKIP_LABEL[skip.type]}
              </button>
            )}

            {/* Trickplay strip: hover previews the frame at that moment, click seeks there.
                A thin band under the native controls rather than a replacement for them
                (Plex direct-play keeps the browser's own chrome). */}
            {trickplay && duration > 0 && (
              <div
                role="slider" tabIndex={0}
                aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(position)}
                onMouseMove={(e) => {
                  const r = e.currentTarget.getBoundingClientRect()
                  setHoverRatio(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)))
                }}
                onMouseLeave={() => setHoverRatio(null)}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect()
                  seekTo(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * duration)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight') seekTo(Math.min(duration, position + 10))
                  else if (e.key === 'ArrowLeft') seekTo(Math.max(0, position - 10))
                }}
                className="relative mt-2 h-1.5 shrink-0 cursor-pointer rounded-full bg-white/20">
                <div className="h-full rounded-full bg-white/70" style={{ width: `${(position / duration) * 100}%` }} />
                {hoverRatio != null && (
                  <TrickplayPreview info={trickplay} sec={hoverRatio * duration} ratio={hoverRatio} />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** One frame out of our generated sprite sheet, positioned over the strip. */
function TrickplayPreview({ info, sec, ratio }: { info: TrickplayInfo; sec: number; ratio: number }) {
  const idx = Math.min(info.totalCount - 1, Math.max(0, Math.floor(sec / info.intervalSec)))
  const col = idx % info.cols
  const row = Math.floor(idx / info.cols)
  const scale = 1.4
  const w = info.tileWidth * scale
  const h = info.tileHeight * scale
  return (
    // design-ok(raw-palette-semantic): trickplay preview floats over the video surface
    <div className="pointer-events-none absolute bottom-full mb-2 overflow-hidden rounded-control border border-white/10 shadow-xl"
      style={{
        width: w, height: h,
        left: `clamp(${w / 2}px, ${ratio * 100}%, calc(100% - ${w / 2}px))`,
        transform: 'translateX(-50%)',
        backgroundImage: `url(${info.url})`,
        backgroundPosition: `-${col * w}px -${row * h}px`,
        backgroundSize: `${info.cols * w}px ${info.rows * h}px`,
      }}>
      <span className="absolute bottom-1 right-1.5 rounded bg-black/80 px-1 py-0.5 text-[10px] font-semibold tabular-nums text-white">{fmtClock(sec)}</span>
    </div>
  )
}
