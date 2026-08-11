import { Fragment } from 'react'
import { cn } from '@/lib/cn'
import type { CardListView } from '@/components/shared/ViewToggle'
import type { HubVideoItem } from '@/lib/videos/api'
import { HubCard, HubRow } from '@/components/videos/HubCard'
import { EAGER_CARDS, hubItemImageUrls } from '@/lib/prefetch/cardImageUrls'
import { useScrollAheadImages } from '@/lib/prefetch/useScrollAheadImages'

// Same grid metrics as YT_GRID/YT_SHORTS_GRID (components/youtube/VideoCollection.tsx)
// so every source page's grid measures identically to YouTube's.
const GRID = 'grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-4'
const VERTICAL_GRID = 'grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-6'

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
  // The toggle forces one uniform shape on every source (ignoring each item's native
  // orientation): tall = 9:16 for all, wide = 16:9 for all.
  const tall = view === 'big'
  const gridClass = isList ? 'space-y-1' : tall ? VERTICAL_GRID : GRID
  const shape: 'wide' | 'tall' = tall ? 'tall' : 'wide'
  // Every page that renders a hub grid gets scroll-ahead warming from here, so no page has
  // to remember to ask for it (and appended infinite-scroll pages are warmed as they land).
  useScrollAheadImages(hubItemImageUrls(items))
  return (
    <div className={cn(gridClass, className)}>
      {items.map((i, idx) => (
        <Fragment key={keyOf(i)}>
          {isList
            ? <HubRow item={i} showSource={showSource} eager={idx < EAGER_CARDS} />
            : <HubCard item={i} showSource={showSource} shape={shape} eager={idx < EAGER_CARDS} />}
        </Fragment>
      ))}
    </div>
  )
}
