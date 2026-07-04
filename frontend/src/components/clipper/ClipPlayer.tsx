import { useEffect, useRef, useState } from 'react'
import { Maximize, Minimize } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'

// NOTE: shared zoom-to-fill-fullscreen + audio-boost hooks (frontend/src/hooks/
// use-zoom-to-fill-fullscreen.ts, use-audio-boost.ts) are planned for the YouTube player in a
// parallel task. Neither exists yet, so this stays a plain, correct HTML5 media element with
// standard Fullscreen API handling. Wire those hooks in here once they land.

export type ClipPlayerKind = 'audio' | 'video'

interface ClipPlayerProps {
  kind: ClipPlayerKind
  src: string
  poster?: string | null
  title?: string
  autoPlay?: boolean
  className?: string
}

/** Thin, isolated player for a single clip (direct-play stream or a saved file URL). */
export function ClipPlayer({ kind, src, poster, title, autoPlay, className }: ClipPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await containerRef.current?.requestFullscreen()
    } catch {
      // Fullscreen can be denied (no user gesture, unsupported); controls stay usable either way.
    }
  }

  if (kind === 'audio') {
    return (
      <div className={cn('rounded-card border border-border bg-card p-3', className)}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- clip source has no caption track */}
        <audio key={src} src={src} controls autoPlay={autoPlay} className="w-full" title={title} />
      </div>
    )
  }

  return (
    <div ref={containerRef} className={cn('group relative overflow-hidden rounded-card bg-black', className)}>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- clip source has no caption track */}
      <video
        key={src}
        ref={videoRef}
        src={src}
        poster={poster ?? undefined}
        controls
        autoPlay={autoPlay}
        className="aspect-video w-full"
        title={title}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => void toggleFullscreen()}
        className="absolute right-2 top-2 bg-black/50 text-white opacity-0 transition-opacity hover:bg-black/70 hover:text-white group-hover:opacity-100"
        aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
      >
        {isFullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
      </Button>
    </div>
  )
}
