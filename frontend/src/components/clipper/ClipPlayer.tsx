import { useRef, useState } from 'react'
import { Expand, Maximize, Minimize, Zap } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { useZoomToFillFullscreen } from '@/hooks/use-zoom-to-fill-fullscreen'
import { useAudioBoost } from '@/hooks/use-audio-boost'

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
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null)
  const [boostOpen, setBoostOpen] = useState(false)
  const { boost, setBoost } = useAudioBoost(mediaRef)
  const { isFullscreen, fillMode, toggleFullscreen, toggleFillMode } = useZoomToFillFullscreen(mediaRef, containerRef)

  const boostControl = (
    <div className="relative">
      <button type="button" onClick={() => setBoostOpen(o => !o)} aria-label="Boost volume" title="Boost volume"
        className={cn('flex items-center gap-1.5', boost > 1 && 'text-[var(--yt-accent-fg)]')}>
        {boost > 1 && <span className="text-xs font-bold tabular-nums">{boost.toFixed(1)}×</span>}
        <Zap className="size-4" />
      </button>
      {boostOpen && (
        // design-ok(raw-palette-semantic) design-ok(backdrop-blur-outside-chrome): theme-invariant dark popover floating over the media surface
        <div className="absolute bottom-full right-0 mb-2 w-40 rounded-card border border-white/10 bg-zinc-900/95 p-3 text-white shadow-xl backdrop-blur">
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="font-semibold">Boost</span>
            <span className="tabular-nums text-white/60">{boost.toFixed(1)}×</span>
          </div>
          <input type="range" min={1} max={4} step={0.1} value={boost}
            onChange={e => setBoost(Number(e.target.value))} className="w-full accent-[var(--yt-accent)]" />
        </div>
      )}
    </div>
  )

  if (kind === 'audio') {
    return (
      <div className={cn('rounded-card border border-border bg-card p-3', className)}>
        <div className="mb-2 flex justify-end">{boostControl}</div>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- clip source has no caption track */}
        <audio key={src} ref={mediaRef} src={src} controls autoPlay={autoPlay} className="w-full" title={title} />
      </div>
    )
  }

  return (
    <div ref={containerRef} className={cn('group relative overflow-hidden rounded-card bg-black', className)}>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- clip source has no caption track */}
      <video
        key={src}
        ref={mediaRef}
        src={src}
        poster={poster ?? undefined}
        controls
        autoPlay={autoPlay}
        className="aspect-video w-full"
        title={title}
      />
      <div className="absolute right-2 top-2 flex items-center gap-1 text-white opacity-0 transition-opacity group-hover:opacity-100">
        {boostControl}
        {isFullscreen && (
          <Button type="button" variant="ghost" size="icon-sm" onClick={toggleFillMode}
            className="bg-black/50 text-white hover:bg-black/70 hover:text-white"
            aria-label={fillMode === 'cover' ? 'Fit to screen' : 'Zoom to fill'}>
            <Expand className={cn('size-4', fillMode === 'cover' && 'text-[var(--yt-accent-fg)]')} />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={toggleFullscreen}
          className="bg-black/50 text-white hover:bg-black/70 hover:text-white"
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        >
          {isFullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
        </Button>
      </div>
    </div>
  )
}
