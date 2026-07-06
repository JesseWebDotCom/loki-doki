import { Fragment, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import type { CardListView } from '@/components/shared/ViewToggle'
import type { VideoItem } from '@/lib/youtube/types'
import { VideoCard, VideoListRow } from '@/components/youtube/VideoCard'

// The card-grid layouts shared by every YouTube video section. Kept here so pages render the
// same grid whether or not they use the toggle.
export const YT_GRID = 'grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-4'
export const YT_SHORTS_GRID = 'grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-6'

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
  return (
    <div className={cn(isList ? 'space-y-1' : aspect === 'short' ? YT_SHORTS_GRID : YT_GRID, className)}>
      {items.map(i => {
        const node = isList ? <VideoListRow item={i} aspect={aspect} /> : <VideoCard item={i} aspect={aspect} />
        return <Fragment key={keyOf(i)}>{wrap ? wrap(i, node) : node}</Fragment>
      })}
    </div>
  )
}
