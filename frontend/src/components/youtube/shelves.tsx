import { useRef, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, ChevronLeft, ListVideo } from 'lucide-react'
import { cn } from '@/lib/cn'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { Skeleton } from '@/components/ui/skeleton'
import { fmtCount } from '@/lib/youtube/format'
import { ytImageProxy } from '@/lib/youtube/api'
import type { VideoItem } from '@/lib/youtube/types'
import { VideoCard } from '@/components/youtube/VideoCard'
import { ChannelAvatar } from '@/components/youtube/media'

// design-ok(backdrop-blur-outside-chrome): floating scroll chevrons hover over card artwork
const CHEVRON_CLS = 'absolute top-1/2 hidden -translate-y-1/2 rounded-full border border-border/60 bg-background/90 p-1.5 shadow-lg backdrop-blur transition group-hover/scroll:flex hover:bg-background'

/** Horizontal scroll strip with hover chevrons. */
export function HScroll({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const by = (dir: number) => ref.current?.scrollBy({ left: dir * (ref.current.clientWidth * 0.8), behavior: 'smooth' })
  return (
    <div className="group/scroll relative">
      <div ref={ref} className={cn('flex gap-4 overflow-x-auto overscroll-x-contain scroll-smooth pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)}>
        {children}
      </div>
      <button onClick={() => by(-1)} aria-label="Scroll left" className={cn(CHEVRON_CLS, '-left-3')}>
        <ChevronLeft className="size-5" />
      </button>
      <button onClick={() => by(1)} aria-label="Scroll right" className={cn(CHEVRON_CLS, '-right-3')}>
        <ChevronRight className="size-5" />
      </button>
    </div>
  )
}

/** A titled horizontal shelf of video cards. */
export function MediaShelf({ title, to, items, aspect = 'video' }: {
  title: string
  to?: string
  items: VideoItem[]
  aspect?: 'video' | 'short'
}) {
  if (!items.length) return null
  return (
    <section>
      <SectionHeader title={title} to={to} className="mb-4" />
      <HScroll>
        {items.map(i => (
          <div key={i.videoId + (i.localKind ?? '')} className={cn('shrink-0', aspect === 'short' ? 'w-44' : 'w-72')}>
            <VideoCard item={i} aspect={aspect} />
          </div>
        ))}
      </HScroll>
    </section>
  )
}

/**
 * Placeholder that reserves a shelf's vertical space while its data is still loading,
 * so the real shelf swaps in without shoving the rest of the page down. Mirrors
 * MediaShelf's DOM (heading + a row of cards) so the heights line up.
 */
export function ShelfSkeleton({ aspect = 'video', count = 6 }: { aspect?: 'video' | 'short'; count?: number }) {
  return (
    <section aria-hidden>
      <Skeleton className="mb-4 h-7 w-44" />
      <div className="flex gap-4 overflow-hidden pb-1">
        {Array.from({ length: count }).map((_, n) => (
          <div key={n} className={cn('shrink-0', aspect === 'short' ? 'w-44' : 'w-72')}>
            <div className="flex flex-col gap-2.5">
              <Skeleton className={cn('rounded-card', aspect === 'short' ? 'aspect-[9/16]' : 'aspect-video')} />
              <div className="flex gap-2.5">
                <Skeleton className="mt-0.5 size-8 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-full" />
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="mt-1 h-3 w-1/2" />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

export interface ChannelEntry {
  id: string
  title: string
  thumbnailUrl: string | null
  subtitle?: string
}

/** "Top channels" circular-avatar scroller. */
export function ChannelRail({ title = 'Top channels', to, channels }: { title?: string; to?: string; channels: ChannelEntry[] }) {
  if (!channels.length) return null
  return (
    <section>
      <SectionHeader title={title} to={to} className="mb-4" />
      <HScroll>
        {channels.map(c => (
          <Link key={c.id} to={`/youtube/channel/${encodeURIComponent(c.id)}`}
            state={{ title: c.title, thumbnailUrl: c.thumbnailUrl }}
            className="group flex w-28 shrink-0 flex-col items-center gap-2 text-center">
            <ChannelAvatar title={c.title} src={c.thumbnailUrl} className="size-20 text-2xl ring-1 ring-border/40 transition group-hover:ring-2 group-hover:ring-[var(--yt-accent)]" />
            <p className="line-clamp-1 w-full text-sm font-semibold">{c.title}</p>
            {c.subtitle && <p className="line-clamp-1 w-full text-xs text-muted-foreground">{c.subtitle}</p>}
          </Link>
        ))}
      </HScroll>
    </section>
  )
}

/** Minimal shape a playlist card needs; satisfied by both search and channel-tab rows. */
export interface PlaylistCardData {
  playlistId: string
  title: string
  videoCount: number | null
  thumbnailUrl: string | null
  author: string | null
}

/** A single playlist card (search results, the channel Playlists tab, playlist rails). */
export function PlaylistCard({ p }: { p: PlaylistCardData }) {
  return (
    <Link to={`/youtube/playlist/${encodeURIComponent(p.playlistId)}`} state={{ title: p.title }} className="group">
      <div className="relative aspect-video overflow-hidden rounded-card bg-muted">
        {p.thumbnailUrl
          ? <img src={ytImageProxy(p.thumbnailUrl)} alt="" referrerPolicy="no-referrer" className="size-full object-cover transition group-hover:scale-105" />
          : <div className="flex size-full items-center justify-center"><ListVideo className="size-8 text-muted-foreground/40" /></div>}
        <div className="absolute bottom-0 right-0 flex items-center gap-1 rounded-tl-control bg-black/80 px-2 py-1 text-[11px] font-semibold text-white">
          <ListVideo className="size-3" /> {p.videoCount != null ? `${p.videoCount}` : 'Playlist'}
        </div>
      </div>
      <p className="mt-1.5 line-clamp-2 text-sm font-semibold leading-snug">{p.title}</p>
      {p.author && <p className="truncate text-xs text-muted-foreground">{p.author}</p>}
    </Link>
  )
}

/** Full-width horizontal playlist row (list view), matching PlaylistCard's target/badges. */
export function PlaylistListRow({ p }: { p: PlaylistCardData }) {
  return (
    <Link to={`/youtube/playlist/${encodeURIComponent(p.playlistId)}`} state={{ title: p.title }}
      className="group flex gap-3 rounded-card p-1.5 transition-colors hover:bg-accent/50 sm:gap-4">
      <div className="relative aspect-video w-40 shrink-0 overflow-hidden rounded-card bg-muted sm:w-56">
        {p.thumbnailUrl
          ? <img src={ytImageProxy(p.thumbnailUrl)} alt="" referrerPolicy="no-referrer" className="size-full object-cover transition group-hover:scale-105" />
          : <div className="flex size-full items-center justify-center"><ListVideo className="size-8 text-muted-foreground/40" /></div>}
        <div className="absolute bottom-0 right-0 flex items-center gap-1 rounded-tl-control bg-black/80 px-2 py-1 text-[11px] font-semibold text-white">
          <ListVideo className="size-3" /> {p.videoCount != null ? `${p.videoCount}` : 'Playlist'}
        </div>
      </div>
      <div className="min-w-0 flex-1 py-0.5">
        <p className="line-clamp-2 text-sm font-semibold leading-snug sm:text-[15px]">{p.title}</p>
        {p.author && <p className="mt-1 truncate text-xs text-muted-foreground">{p.author}</p>}
        {p.videoCount != null && <p className="mt-0.5 truncate text-xs text-muted-foreground">{p.videoCount} {p.videoCount === 1 ? 'video' : 'videos'}</p>}
      </div>
    </Link>
  )
}

export { fmtCount }
