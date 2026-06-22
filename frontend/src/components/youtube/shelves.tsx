import { useRef, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, ChevronLeft, ListVideo } from 'lucide-react'
import { cn } from '@/lib/cn'
import { fmtCount } from '@/lib/youtube/format'
import { ytImageProxy } from '@/lib/youtube/api'
import type { VideoItem } from '@/lib/youtube/types'
import { VideoCard } from '@/components/youtube/VideoCard'
import { ChannelAvatar } from '@/components/youtube/media'

/** Horizontal scroll strip with hover chevrons. */
export function HScroll({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const by = (dir: number) => ref.current?.scrollBy({ left: dir * (ref.current.clientWidth * 0.8), behavior: 'smooth' })
  return (
    <div className="group/scroll relative">
      <div ref={ref} className={cn('flex gap-4 overflow-x-auto overscroll-x-contain scroll-smooth pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)}>
        {children}
      </div>
      <button onClick={() => by(-1)} aria-label="Scroll left"
        className="absolute -left-3 top-1/2 hidden -translate-y-1/2 rounded-full border border-border/60 bg-background/90 p-1.5 shadow-lg backdrop-blur transition group-hover/scroll:flex hover:bg-background">
        <ChevronLeft className="size-5" />
      </button>
      <button onClick={() => by(1)} aria-label="Scroll right"
        className="absolute -right-3 top-1/2 hidden -translate-y-1/2 rounded-full border border-border/60 bg-background/90 p-1.5 shadow-lg backdrop-blur transition group-hover/scroll:flex hover:bg-background">
        <ChevronRight className="size-5" />
      </button>
    </div>
  )
}

/** Section heading with optional "View all" link. */
export function ShelfHead({ title, to }: { title: string; to?: string }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <h2 className="text-lg font-bold tracking-tight">{title}</h2>
      {to && <Link to={to} className="shrink-0 text-sm font-medium text-[var(--yt-accent-fg)] hover:text-[var(--yt-accent-fg)]">View all</Link>}
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
      <ShelfHead title={title} to={to} />
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
    <section aria-hidden className="animate-pulse">
      <div className="mb-3 h-7 w-44 rounded-md bg-muted" />
      <div className="flex gap-4 overflow-hidden pb-1">
        {Array.from({ length: count }).map((_, n) => (
          <div key={n} className={cn('shrink-0', aspect === 'short' ? 'w-44' : 'w-72')}>
            <div className="flex flex-col gap-2.5">
              <div className={cn('rounded-xl bg-muted', aspect === 'short' ? 'aspect-[9/16]' : 'aspect-video')} />
              <div className="flex gap-2.5">
                <div className="mt-0.5 size-8 shrink-0 rounded-full bg-muted" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="h-3.5 w-full rounded bg-muted" />
                  <div className="h-3.5 w-3/4 rounded bg-muted" />
                  <div className="mt-1 h-3 w-1/2 rounded bg-muted" />
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
      <ShelfHead title={title} to={to} />
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

/** Minimal shape a playlist card needs — satisfied by both search and channel-tab rows. */
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
      <div className="relative aspect-video overflow-hidden rounded-xl bg-muted">
        {p.thumbnailUrl
          ? <img src={ytImageProxy(p.thumbnailUrl)} alt="" referrerPolicy="no-referrer" className="size-full object-cover transition group-hover:scale-105" />
          : <div className="flex size-full items-center justify-center"><ListVideo className="size-8 text-muted-foreground/40" /></div>}
        <div className="absolute bottom-0 right-0 flex items-center gap-1 rounded-tl-lg bg-black/80 px-2 py-1 text-[11px] font-semibold text-white">
          <ListVideo className="size-3" /> {p.videoCount != null ? `${p.videoCount}` : 'Playlist'}
        </div>
      </div>
      <p className="mt-1.5 line-clamp-2 text-sm font-semibold leading-snug">{p.title}</p>
      {p.author && <p className="truncate text-xs text-muted-foreground">{p.author}</p>}
    </Link>
  )
}

export { fmtCount }
