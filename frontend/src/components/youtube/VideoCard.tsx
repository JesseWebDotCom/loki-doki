import { Link } from 'react-router-dom'
import { CheckCircle2, CloudOff, Download } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { fmtAge, fmtDur } from '@/lib/youtube/format'
import { watchProgress, type VideoItem } from '@/lib/youtube/types'
import { VideoThumb, ChannelAvatar } from '@/components/youtube/media'
import { useYoutubeModeOptional, useYoutubeUIOptional } from '@/components/youtube/YoutubeLayout'
import { useDeArrow } from '@/lib/youtube/dearrow'

/** Where a card navigates — the full-page watch route, preserving offline kind. */
export function watchHref(i: Pick<VideoItem, 'videoId' | 'localKind'>) {
  return i.localKind ? `/youtube/watch/${i.videoId}?k=${i.localKind}` : `/youtube/watch/${i.videoId}`
}

/** Offline mode + no local copy ⇒ the card is "ghosted": shown for continuity
 *  (history, related rows) but greyed out and non-navigating, since it can't play.
 *  Tapping it offers to queue a download instead (saved when back online). */
function useGhost(item: Pick<VideoItem, 'videoId' | 'title' | 'localKind'>) {
  const ghosted = useYoutubeModeOptional() === 'offline' && !item.localKind
  const ui = useYoutubeUIOptional()
  const onClick = () => ui ? ui.openSave(item.videoId, item.title) : toast.info('Not available offline')
  return { ghosted, onClick }
}

function Thumb({ i, aspect, ghosted, overrideSrc }: { i: VideoItem; aspect: 'video' | 'short'; ghosted?: boolean; overrideSrc?: string | null }) {
  const dur = fmtDur(i.durationSec)
  const progress = watchProgress(i)
  return (
    <div className={cn('relative overflow-hidden rounded-xl bg-muted', aspect === 'short' ? 'aspect-[9/16]' : 'aspect-video')}>
      <VideoThumb videoId={i.videoId} title={i.title} overrideSrc={overrideSrc} className={cn('size-full transition-transform duration-500', ghosted ? 'grayscale' : 'group-hover:scale-[1.03]')} />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
      {i.watch?.completed && (
        <div className="pointer-events-none absolute inset-0 bg-black/40" />
      )}
      {ghosted ? (
        <>
          <span className="absolute left-2 top-2 flex items-center gap-1 rounded-md bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm">
            <CloudOff className="size-3" /> Online only
          </span>
          {/* The card itself is the button; this is just the visible "you can save it" cue. */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
            <span className="flex items-center gap-1.5 rounded-full bg-[var(--yt-accent)] px-3 py-1.5 text-xs font-semibold text-white shadow-lg">
              <Download className="size-3.5" /> Save offline
            </span>
          </div>
        </>
      ) : i.qualityBadge && (
        <span className="absolute left-2 top-2 rounded-md bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm">{i.qualityBadge}</span>
      )}
      {i.watch?.completed && (
        <span className="absolute left-2 top-2 flex items-center gap-1 rounded-md bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400 backdrop-blur-sm">
          <CheckCircle2 className="size-3" /> Watched
        </span>
      )}
      {dur && (
        <span className="absolute bottom-1.5 right-1.5 rounded-md bg-black/80 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">{dur}</span>
      )}
      {(progress > 0 || i.watch?.completed) && (
        <div className="absolute inset-x-0 bottom-0 h-1 bg-black/40">
          <div className={cn('h-full', i.watch?.completed ? 'w-full bg-white/50' : 'bg-[var(--yt-accent)]')} style={i.watch?.completed ? undefined : { width: `${Math.min(100, progress * 100)}%` }} />
        </div>
      )}
    </div>
  )
}

/** Vertical video card — thumbnail, title, channel · age. Click → watch (or Shorts) page. */
export function VideoCard({ item, aspect = 'video' }: { item: VideoItem; aspect?: 'video' | 'short' }) {
  const age = item.ageLabel ?? fmtAge(item.publishedAt)
  const { ghosted, onClick } = useGhost(item)
  // DeArrow swaps clickbait titles/thumbnails for community-voted ones (no-op when off).
  const da = useDeArrow(item.videoId)
  const title = da?.title || item.title
  // Online shorts open in the vertical Shorts feed; everything else (and offline
  // shorts, which need local playback) goes to the standard watch page.
  const to = aspect === 'short' && !item.localKind ? `/youtube/shorts/${item.videoId}` : watchHref(item)
  const body = (
    <>
      <Thumb i={item} aspect={aspect} ghosted={ghosted} overrideSrc={da?.thumbnailUrl} />
      <div className="flex gap-2.5">
        {item.author && (
          <ChannelAvatar title={item.author} src={item.channelThumb} className={cn('mt-0.5 size-8 text-[11px] ring-1 ring-border/40', ghosted && 'grayscale')} />
        )}
        <div className="min-w-0 flex-1">
          <p className={cn('line-clamp-2 text-sm font-semibold leading-snug', ghosted ? 'text-muted-foreground' : 'text-foreground')}>{title}</p>
          {(item.author || age) && (
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {item.author}{item.author && age ? ' · ' : ''}{age}
            </p>
          )}
        </div>
      </div>
    </>
  )
  if (ghosted) {
    return (
      <button type="button" onClick={onClick} className="group flex flex-col gap-2.5 text-left">
        {body}
      </button>
    )
  }
  return (
    <Link to={to} state={{ title, author: item.author, channelThumb: item.channelThumb }} className="group flex flex-col gap-2.5">
      {body}
    </Link>
  )
}

/** Compact horizontal row — used in the watch page "Up next" column. */
export function UpNextRow({ item, active }: { item: VideoItem; active?: boolean }) {
  const age = item.ageLabel ?? fmtAge(item.publishedAt)
  const { ghosted, onClick } = useGhost(item)
  const da = useDeArrow(item.videoId)
  const title = da?.title || item.title
  const body = (
    <>
      <div className="relative w-[150px] shrink-0">
        <Thumb i={item} aspect="video" ghosted={ghosted} overrideSrc={da?.thumbnailUrl} />
      </div>
      <div className="min-w-0 flex-1 py-0.5">
        <p className={cn('line-clamp-2 text-[13px] font-semibold leading-snug', ghosted && 'text-muted-foreground')}>{title}</p>
        {item.author && <p className="mt-1 truncate text-xs text-muted-foreground">{item.author}</p>}
        {age && <p className="truncate text-xs text-muted-foreground">{age}</p>}
      </div>
    </>
  )
  if (ghosted) {
    return (
      <button type="button" onClick={onClick} className="group flex w-full gap-2.5 rounded-xl p-1.5 text-left transition-colors hover:bg-accent/50">
        {body}
      </button>
    )
  }
  return (
    <Link to={watchHref(item)} state={{ title, author: item.author, channelThumb: item.channelThumb }}
      className={cn('group flex gap-2.5 rounded-xl p-1.5 transition-colors', active ? 'bg-accent' : 'hover:bg-accent/50')}>
      {body}
    </Link>
  )
}
