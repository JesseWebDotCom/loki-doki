import { useRef, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, ChevronLeft } from 'lucide-react'
import { cn } from '@/lib/cn'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { DismissableCard } from '@/components/shared/DismissableCard'
import { Skeleton } from '@/components/ui/skeleton'
import { fmtCount } from '@/lib/youtube/format'
import { ytImageProxy } from '@/lib/youtube/api'
import type { VideoItem } from '@/lib/youtube/types'
import { VideoCard, VideoListRow } from '@/components/youtube/VideoCard'
import { CreatorAvatar } from '@/components/videos/CreatorAvatar'
import { AVATAR_W_LARGE } from '@/lib/img'
import { EAGER_RAIL_CARDS, ytItemImageUrls } from '@/lib/prefetch/cardImageUrls'
import { useScrollAheadImages } from '@/lib/prefetch/useScrollAheadImages'
import { PlaylistCard as GenericPlaylistCard, PlaylistListRow as GenericPlaylistListRow, type PlaylistCardData } from '@/components/videos/PlaylistCard'
import type { CardListView } from '@/components/shared/ViewToggle'

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

/** A titled shelf of videos. Defaults to a horizontal card rail; when `view === 'list'` the
 *  same items render as a vertical list of rows (so a page-level card/list toggle flips every
 *  shelf, not just full-width grids). `onDismiss` (suggestion rails) adds a "Not interested"
 *  X to each card via the shared DismissableCard wrapper. */
export function MediaShelf({ title, to, items, aspect = 'video', view = 'grid', onDismiss }: {
  title: string
  to?: string
  items: VideoItem[]
  aspect?: 'video' | 'short'
  view?: CardListView
  onDismiss?: (item: VideoItem) => void
}) {
  // Before the empty guard: hooks cannot run conditionally, and an empty list is a no-op here.
  useScrollAheadImages(ytItemImageUrls(items))
  if (!items.length) return null
  // The toggle drives the rail's card shape too, so a shelf matches the grid below it: a
  // dedicated Shorts shelf stays tall; otherwise Tall = 9:16 cells, Wide = 16:9 cells.
  const shorts = aspect === 'short'
  const tall = shorts || view === 'big'
  const shape: 'wide' | 'tall' | undefined = shorts ? undefined : view === 'big' ? 'tall' : 'wide'
  const wrap = (i: VideoItem, node: ReactNode) =>
    onDismiss ? <DismissableCard onDismiss={() => onDismiss(i)}>{node}</DismissableCard> : node
  return (
    <section>
      <SectionHeader title={title} to={to} className="mb-4" />
      {view === 'list' ? (
        <div className="space-y-1">
          {items.map((i, idx) => (
            <div key={i.videoId + (i.localKind ?? '')}>
              {wrap(i, <VideoListRow item={i} aspect={aspect} eager={idx < EAGER_RAIL_CARDS} />)}
            </div>
          ))}
        </div>
      ) : (
        <HScroll>
          {items.map((i, idx) => (
            <div key={i.videoId + (i.localKind ?? '')} className={cn('shrink-0', tall ? 'w-44' : 'w-72')}>
              {wrap(i, <VideoCard item={i} aspect={aspect} shape={shape} eager={idx < EAGER_RAIL_CARDS} />)}
            </div>
          ))}
        </HScroll>
      )}
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
          <Link key={c.id} to={`/videos/youtube/channel/${encodeURIComponent(c.id)}`}
            state={{ title: c.title, thumbnailUrl: c.thumbnailUrl }}
            className="group flex w-28 shrink-0 flex-col items-center gap-2 text-center">
            <CreatorAvatar title={c.title} src={c.thumbnailUrl} width={AVATAR_W_LARGE} className="size-20 text-2xl ring-1 ring-border/40 transition group-hover:ring-2 group-hover:ring-[var(--yt-accent)]" />
            <p className="line-clamp-1 w-full text-sm font-semibold">{c.title}</p>
            {c.subtitle && <p className="line-clamp-1 w-full text-xs text-muted-foreground">{c.subtitle}</p>}
          </Link>
        ))}
      </HScroll>
    </section>
  )
}

export type { PlaylistCardData }

/** A single playlist card (search results, the channel Playlists tab, playlist rails).
 *  Thin YouTube-flavored wrapper over the source-agnostic components/videos/PlaylistCard,
 *  routed through YouTube's own image cache instead of the generic proxy. */
export function PlaylistCard({ p }: { p: PlaylistCardData }) {
  return <GenericPlaylistCard p={p} source="youtube" proxy={ytImageProxy} />
}

/** Full-width horizontal playlist row (list view), matching PlaylistCard's target/badges. */
export function PlaylistListRow({ p }: { p: PlaylistCardData }) {
  return <GenericPlaylistListRow p={p} source="youtube" proxy={ytImageProxy} />
}

export { fmtCount }
