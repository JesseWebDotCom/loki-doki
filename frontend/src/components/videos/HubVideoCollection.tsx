import { Fragment } from 'react'
import { cn } from '@/lib/cn'
import type { CardListView } from '@/components/shared/ViewToggle'
import type { HubVideoItem } from '@/lib/videos/api'
import { HubVideoCard } from '@/components/videos/HubVideoCard'
import { HubVideoListRow } from '@/components/videos/HubVideoListRow'

// Same grid metrics as YT_GRID/YT_SHORTS_GRID (components/youtube/VideoCollection.tsx)
// so every source page's grid measures identically to YouTube's.
const GRID = 'grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-4'
const VERTICAL_GRID = 'grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-6'
// Large view (matches YT_BIG_GRID): fewer columns → bigger cards.
const BIG_GRID = 'grid grid-cols-1 gap-x-5 gap-y-8 sm:grid-cols-2 xl:grid-cols-3'

const keyOf = (i: HubVideoItem) => `${i.source}:${i.id}`

/** Card/list switch for hub items: the source-agnostic counterpart to youtube's
 *  VideoCollection, so every source page's grid/list toggle behaves identically. */
export function HubVideoCollection({ items, view, showSource, className }: {
  items: HubVideoItem[]
  view: CardListView
  showSource?: boolean
  className?: string
}) {
  const isList = view === 'list'
  const isBig = view === 'big'
  const anyVertical = items.some((i) => i.vertical)
  const gridClass = isList ? 'space-y-1' : isBig ? BIG_GRID : anyVertical ? VERTICAL_GRID : GRID
  return (
    <div className={cn(gridClass, className)}>
      {items.map((i) => (
        <Fragment key={keyOf(i)}>
          {isList ? <HubVideoListRow item={i} showSource={showSource} /> : <HubVideoCard item={i} showSource={showSource} big={isBig} />}
        </Fragment>
      ))}
    </div>
  )
}
