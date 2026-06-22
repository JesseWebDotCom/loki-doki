import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronUp, ChevronDown, Heart, Clock, Maximize2, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { VideoPlayer, type VideoPlayerHandle } from '@/components/youtube/VideoPlayer'
import { ChannelAvatar } from '@/components/youtube/media'
import { useYtFeed } from '@/lib/youtube/useData'
import { getVideoMeta } from '@/lib/youtube/api'
import { isShort } from '@/lib/youtube/types'
import { toggleCollection, useCollection } from '@/lib/youtube/collections'

/** Vertical, swipe-through Shorts feed — scroll / arrows / swipe to move between shorts. */
export function YoutubeShortsPage() {
  const { videoId = '' } = useParams()
  const navigate = useNavigate()
  const navState = (useLocation().state ?? {}) as { title?: string | null; author?: string | null; channelThumb?: string | null; dir?: 1 | -1 }
  const playerRef = useRef<VideoPlayerHandle>(null)

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

  const go = useCallback((dir: 1 | -1) => {
    const target = index === -1 ? (dir === 1 ? queue[0] : undefined) : queue[index + dir]
    if (target) navigate(`/youtube/shorts/${target.videoId}`,
      { state: { title: target.title, author: target.author, channelThumb: target.channelThumb, dir } })
  }, [index, queue, navigate])

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

  const snapshot = { videoId, title, author, channelId, durationSec: meta?.durationSec ?? feedItem?.durationSec ?? null }
  const liked = useCollection('liked').some(v => v.videoId === videoId)
  const watchLater = useCollection('watch-later').some(v => v.videoId === videoId)

  const hasPrev = index > 0
  const hasNext = index === -1 ? queue.length > 0 : index < queue.length - 1

  return (
    <div ref={rootRef} className="flex h-full select-none items-center justify-center gap-3 overflow-hidden px-4 py-4">
      {/* 9:16 player with the channel + title overlay. Keyed so each short replays the
          direction-aware slide-in animation. */}
      <div key={videoId}
        className={cn('relative aspect-[9/16] h-full max-h-[82vh] overflow-hidden rounded-2xl bg-black',
          navState.dir === 1 ? 'yt-short-up' : navState.dir === -1 ? 'yt-short-down' : '')}>
        <VideoPlayer ref={playerRef} key={videoId} videoId={videoId} aspect="short"
          onEnded={() => playerRef.current?.seek(0)}
          videoMeta={{ title, author, channelId, durationSec: meta?.durationSec ?? null }} />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent p-4 pt-14">
          {author && (channelId ? (
            <Link to={`/youtube/channel/${encodeURIComponent(channelId)}`} state={{ title: author, thumbnailUrl: channelThumb }}
              className="pointer-events-auto inline-flex items-center gap-2.5">
              <ChannelAvatar title={author} src={channelThumb} className="size-9 text-xs ring-2 ring-white/70" />
              <span className="text-sm font-semibold text-white">{author}</span>
            </Link>
          ) : (
            <div className="inline-flex items-center gap-2.5">
              <ChannelAvatar title={author} src={channelThumb} className="size-9 text-xs ring-2 ring-white/70" />
              <span className="text-sm font-semibold text-white">{author}</span>
            </div>
          ))}
          <p className="mt-2 line-clamp-2 text-sm font-medium text-white/95">{title}</p>
        </div>
      </div>

      {/* Action rail. */}
      <div className="flex flex-col items-center gap-5 self-end pb-8">
        <RailBtn icon={Heart} label="Like" active={liked} onClick={() => toggleCollection('liked', snapshot)} />
        <RailBtn icon={Clock} label="Later" active={watchLater} onClick={() => toggleCollection('watch-later', snapshot)} />
        <Link to={`/youtube/watch/${videoId}`} className="flex flex-col items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
          <span className="flex size-12 items-center justify-center rounded-full bg-muted"><Maximize2 className="size-5" /></span>
          Full
        </Link>
      </div>

      {/* Prev / next. */}
      <div className="flex flex-col gap-3 self-center">
        <NavArrow icon={ChevronUp} disabled={!hasPrev} onClick={() => go(-1)} />
        <NavArrow icon={ChevronDown} disabled={!hasNext} onClick={() => go(1)} />
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

function NavArrow({ icon: Icon, disabled, onClick }: { icon: LucideIcon; disabled?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="flex size-10 items-center justify-center rounded-full bg-muted text-foreground transition hover:bg-muted/70 disabled:cursor-default disabled:opacity-30">
      <Icon className="size-5" />
    </button>
  )
}
