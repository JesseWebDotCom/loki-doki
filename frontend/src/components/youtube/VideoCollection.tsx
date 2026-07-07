import { Fragment, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import type { CardListView } from '@/components/shared/ViewToggle'
import type { VideoItem } from '@/lib/youtube/types'
import { VideoCard, VideoListRow } from '@/components/youtube/VideoCard'

// The card-grid layouts shared by every YouTube video section. Kept here so pages render the
// same grid whether or not they use the toggle.
export const YT_GRID = 'grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-4'
export const YT_SHORTS_GRID = 'grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-6'
// Large view: fewer columns → bigger cards, with more room for info.
export const YT_BIG_GRID = 'grid grid-cols-1 gap-x-5 gap-y-8 sm:grid-cols-2 xl:grid-cols-3'

const keyOf = (i: VideoItem) => i.videoId + (i.localKind ?? '')

/** Render a set of videos as either the card grid or the full-width list, per `view` — the one
 *  place the grid⇄list switch lives so every section behaves identically. Pass `wrap` to decorate
 *  each item (selection checkbox, remove/add overlay); it receives the item and the rendered
 *  card/row and must return the wrapped node (keying is handled here). */
export function VideoCollection({ items, view, aspect = 'video', className, wrap }: {
  items: VideoItem[]
  view: CardListView
  aspect?: 'video' | 'short'
  className?: string
  wrap?: (item: VideoItem, node: ReactNode) => ReactNode
}) {
  const isList = view === 'list'
  const isBig = view === 'big'
  const gridClass = isList ? 'space-y-1' : isBig ? YT_BIG_GRID : aspect === 'short' ? YT_SHORTS_GRID : YT_GRID
  return (
    <div className={cn(gridClass, className)}>
      {items.map(i => {
        const node = isList ? <VideoListRow item={i} aspect={aspect} /> : <VideoCard item={i} aspect={aspect} big={isBig} />
        return <Fragment key={keyOf(i)}>{wrap ? wrap(i, node) : node}</Fragment>
      })}
    </div>
  )
}
