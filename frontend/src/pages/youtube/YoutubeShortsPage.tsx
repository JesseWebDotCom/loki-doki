import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronUp, ChevronDown, Heart, Clock, Maximize2, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { VideoPlayer, type VideoPlayerHandle } from '@/components/youtube/VideoPlayer'
import { CreatorAvatar } from '@/components/videos/CreatorAvatar'
import { useYtFeed } from '@/lib/youtube/useData'
import { getVideoMeta } from '@/lib/youtube/api'
import { isShort } from '@/lib/youtube/types'
import { toggleCollection, useCollection } from '@/lib/youtube/collections'

const AUTOPLAY_KEY = 'yt.shorts.autoplay'

/** Vertical, swipe-through Shorts feed: scroll / arrows / swipe to move between shorts. */
export function YoutubeShortsPage() {
  const { videoId = '' } = useParams()
  const navigate = useNavigate()
  const navState = (useLocation().state ?? {}) as { title?: string | null; author?: string | null; channelThumb?: string | null; dir?: 1 | -1 }
  const playerRef = useRef<VideoPlayerHandle>(null)

  // Autoplay: advance to the next short when one ends, otherwise loop the current one.
  // Persisted (not ephemeral) because each advance/swipe remounts this page. Defaults on.
  const [autoplay, setAutoplay] = useState(() => localStorage.getItem(AUTOPLAY_KEY) !== '0')
  const toggleAutoplay = () => setAutoplay(a => { const n = !a; try { localStorage.setItem(AUTOPLAY_KEY, n ? '1' : '0') } catch { /* quota */ } return n })

  // The queue is every short in the subscription feed; the current one is the route param.
  const { items } = useYtFeed()
  const queue = useMemo(() => items.filter(isShort), [items])
  const index = queue.findIndex(s => s.videoId === videoId)
  const feedItem = index >= 0 ? queue[index] : undefined

  const { data: meta } = useQuery({ queryKey: ['yt-video', videoId], queryFn: () => getVideoMeta(videoId), enabled: !!videoId })
  const title = meta?.title || feedItem?.title || navState.title || 'Short'
  const author = meta?.author ?? feedItem?.author ?? navState.author ?? null
  const channelThumb = meta?.channelThumb ?? feedItem?.channelThumb ?? navState.channelThumb ?? null
  const channelId = meta?.channelId ?? feedItem?.channelId ?? null

  // Circular: advancing past the last short wraps to the first (and vice-versa), so the feed
  // keeps cycling through every short instead of getting stuck looping the newest/last one.
  const go = useCallback((dir: 1 | -1) => {
    if (!queue.length) return
    const base = index === -1 ? (dir === 1 ? 0 : queue.length - 1) : index + dir
    const target = queue[(base + queue.length) % queue.length]
    if (!target) return
    if (target.videoId === videoId) { playerRef.current?.seek(0); return }   // single-short feed → just replay
    navigate(`/videos/youtube/shorts/${target.videoId}`,
      { state: { title: target.title, author: target.author, channelThumb: target.channelThumb, dir } })
  }, [index, queue, navigate, videoId])

  // Keyboard: ↑ / ↓ move between shorts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); go(1) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); go(-1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go])

  // Wheel + touch swipe. Native non-passive listener so we can stop the pane from
  // scrolling and convert the gesture into a next/prev instead.
  const rootRef = useRef<HTMLDivElement>(null)
  const cooling = useRef(false)
  useEffect(() => {
    const el = rootRef.current; if (!el) return
    const cool = () => { cooling.current = true; setTimeout(() => { cooling.current = false }, 550) }
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < 8) return
      e.preventDefault()
      if (cooling.current) return
      cool(); go(e.deltaY > 0 ? 1 : -1)
    }
    let startY = 0
    const onTouchStart = (e: TouchEvent) => { startY = e.touches[0]?.clientY ?? 0 }
    const onTouchEnd = (e: TouchEvent) => {
      const dy = (e.changedTouches[0]?.clientY ?? 0) - startY
      if (Math.abs(dy) < 50 || cooling.current) return
      cool(); go(dy < 0 ? 1 : -1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchend', onTouchEnd)
    }
  }, [go])

  const snapshot = { videoId, title, author, channelId, channelThumb, durationSec: meta?.durationSec ?? feedItem?.durationSec ?? null }
  const liked = useCollection('liked').some(v => v.videoId === videoId)
  const watchLater = useCollection('watch-later').some(v => v.videoId === videoId)

  // With circular wrapping both arrows stay live whenever there's more than one short.
  const hasPrev = queue.length > 1
  const hasNext = queue.length > 1

  return (
    <div ref={rootRef} className="flex h-full select-none items-center justify-center gap-3 overflow-hidden px-4 py-4">
      {/* 9:16 player with the channel + title overlay. Keyed so each short replays the
          direction-aware slide-in animation. */}
      <div key={videoId}
        className={cn('relative aspect-[9/16] h-full max-h-[82vh] overflow-hidden rounded-card bg-black',
          navState.dir === 1 ? 'yt-short-up' : navState.dir === -1 ? 'yt-short-down' : '')}>
        <VideoPlayer ref={playerRef} key={videoId} videoId={videoId} aspect="short"
          onEnded={() => { if (autoplay && queue.length > 1) go(1); else playerRef.current?.seek(0) }}
          videoMeta={{ title, author, channelId, durationSec: meta?.durationSec ?? null }} />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent p-4 pt-14">
          {author && (channelId ? (
            <Link to={`/videos/youtube/channel/${encodeURIComponent(channelId)}`} state={{ title: author, thumbnailUrl: channelThumb }}
              className="pointer-events-auto inline-flex items-center gap-2.5">
              <CreatorAvatar title={author} src={channelThumb} className="size-9 text-xs ring-2 ring-white/70" />
              <span className="text-sm font-semibold text-white">{author}</span>
            </Link>
          ) : (
            <div className="inline-flex items-center gap-2.5">
              <CreatorAvatar title={author} src={channelThumb} className="size-9 text-xs ring-2 ring-white/70" />
              <span className="text-sm font-semibold text-white">{author}</span>
            </div>
          ))}
          <p className="mt-2 line-clamp-2 text-sm font-medium text-white/95">{title}</p>
        </div>
      </div>

      {/* Action rail. */}
      <div className="flex flex-col items-center gap-5 self-end pb-8">
        <div className="flex flex-col items-center gap-1 text-xs font-medium text-muted-foreground">
          <button onClick={toggleAutoplay} role="switch" aria-checked={autoplay} aria-label="Autoplay"
            className={cn('relative h-5 w-9 rounded-full transition-colors', autoplay ? 'bg-[var(--yt-accent)]' : 'bg-muted-foreground/30')}>
            <span className={cn('absolute top-0.5 size-4 rounded-full bg-white transition-transform', autoplay ? 'translate-x-4' : 'translate-x-0.5')} />
          </button>
          Auto
        </div>
        <RailBtn icon={Heart} label="Like" active={liked} onClick={() => toggleCollection('liked', snapshot)} />
        <RailBtn icon={Clock} label="Later" active={watchLater} onClick={() => toggleCollection('watch-later', snapshot)} />
        <Link to={`/videos/youtube/watch/${videoId}`} className="flex flex-col items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
          <span className="flex size-12 items-center justify-center rounded-full bg-muted"><Maximize2 className="size-5" /></span>
          Full
        </Link>
      </div>

      {/* Prev / next. */}
      <div className="flex flex-col gap-3 self-center">
        <NavArrow icon={ChevronUp} label="Previous short" disabled={!hasPrev} onClick={() => go(-1)} />
        <NavArrow icon={ChevronDown} label="Next short" disabled={!hasNext} onClick={() => go(1)} />
      </div>
    </div>
  )
}

function RailBtn({ icon: Icon, label, active, onClick }: { icon: LucideIcon; label: string; active?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
      <span className={cn('flex size-12 items-center justify-center rounded-full transition-colors',
        active ? 'bg-[var(--yt-accent-soft)] text-[var(--yt-accent-fg)]' : 'bg-muted')}>
        <Icon className={cn('size-5', active && 'fill-current')} />
      </span>
      {label}
    </button>
  )
}

function NavArrow({ icon: Icon, label, disabled, onClick }: { icon: LucideIcon; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <Button variant="secondary" size="icon" onClick={onClick} disabled={disabled} aria-label={label}
      className="size-10 bg-muted text-foreground hover:bg-muted/70 disabled:opacity-30">
      <Icon className="size-5" />
    </Button>
  )
}
