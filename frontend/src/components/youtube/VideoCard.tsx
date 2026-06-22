import { Link } from 'react-router-dom'
import { CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { fmtAge, fmtDur } from '@/lib/youtube/format'
import { watchProgress, type VideoItem } from '@/lib/youtube/types'
import { VideoThumb, ChannelAvatar } from '@/components/youtube/media'

/** Where a card navigates — the full-page watch route, preserving offline kind. */
export function watchHref(i: Pick<VideoItem, 'videoId' | 'localKind'>) {
  return i.localKind ? `/youtube/watch/${i.videoId}?k=${i.localKind}` : `/youtube/watch/${i.videoId}`
}

function Thumb({ i, aspect }: { i: VideoItem; aspect: 'video' | 'short' }) {
  const dur = fmtDur(i.durationSec)
  const progress = watchProgress(i)
  return (
    <div className={cn('relative overflow-hidden rounded-xl bg-muted', aspect === 'short' ? 'aspect-[9/16]' : 'aspect-video')}>
      <VideoThumb videoId={i.videoId} title={i.title} className="size-full transition-transform duration-500 group-hover:scale-[1.03]" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
      {i.qualityBadge && (
        <span className="absolute left-2 top-2 rounded-md bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm">{i.qualityBadge}</span>
      )}
      {i.watch?.completed && (
        <span className="absolute right-2 top-2 rounded-full bg-black/55 p-0.5"><CheckCircle2 className="size-3.5 text-emerald-400" /></span>
      )}
      {dur && (
        <span className="absolute bottom-1.5 right-1.5 rounded-md bg-black/80 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">{dur}</span>
      )}
      {progress > 0 && (
        <div className="absolute inset-x-0 bottom-0 h-1 bg-black/40">
          <div className="h-full bg-[var(--yt-accent)]" style={{ width: `${Math.min(100, progress * 100)}%` }} />
        </div>
      )}
    </div>
  )
}

/** Vertical video card — thumbnail, title, channel · age. Click → watch (or Shorts) page. */
export function VideoCard({ item, aspect = 'video' }: { item: VideoItem; aspect?: 'video' | 'short' }) {
  const age = item.ageLabel ?? fmtAge(item.publishedAt)
  // Online shorts open in the vertical Shorts feed; everything else (and offline
  // shorts, which need local playback) goes to the standard watch page.
  const to = aspect === 'short' && !item.localKind ? `/youtube/shorts/${item.videoId}` : watchHref(item)
  return (
    <Link to={to} state={{ title: item.title, author: item.author, channelThumb: item.channelThumb }} className="group flex flex-col gap-2.5">
      <Thumb i={item} aspect={aspect} />
      <div className="flex gap-2.5">
        {item.author && (
          <ChannelAvatar title={item.author} src={item.channelThumb} className="mt-0.5 size-8 text-[11px] ring-1 ring-border/40" />
        )}
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">{item.title}</p>
          {(item.author || age) && (
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {item.author}{item.author && age ? ' · ' : ''}{age}
            </p>
          )}
        </div>
      </div>
    </Link>
  )
}

/** Compact horizontal row — used in the watch page "Up next" column. */
export function UpNextRow({ item, active }: { item: VideoItem; active?: boolean }) {
  const age = item.ageLabel ?? fmtAge(item.publishedAt)
  return (
    <Link to={watchHref(item)} state={{ title: item.title, author: item.author, channelThumb: item.channelThumb }}
      className={cn('group flex gap-2.5 rounded-xl p-1.5 transition-colors', active ? 'bg-accent' : 'hover:bg-accent/50')}>
      <div className="relative w-[150px] shrink-0">
        <Thumb i={item} aspect="video" />
      </div>
      <div className="min-w-0 flex-1 py-0.5">
        <p className="line-clamp-2 text-[13px] font-semibold leading-snug">{item.title}</p>
        {item.author && <p className="mt-1 truncate text-xs text-muted-foreground">{item.author}</p>}
        {age && <p className="truncate text-xs text-muted-foreground">{age}</p>}
      </div>
    </Link>
  )
}
