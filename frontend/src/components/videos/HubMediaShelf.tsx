import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { DismissableCard } from '@/components/shared/DismissableCard'
import { HScroll } from '@/components/youtube/shelves'
import type { CardListView } from '@/components/shared/ViewToggle'
import type { HubVideoItem } from '@/lib/videos/api'
import { HubCard, HubRow } from '@/components/videos/HubCard'
import { EAGER_RAIL_CARDS, hubItemImageUrls } from '@/lib/prefetch/cardImageUrls'
import { useScrollAheadImages } from '@/lib/prefetch/useScrollAheadImages'

/** A titled shelf of hub items: the source-agnostic counterpart to youtube's MediaShelf.
 *  Horizontal card rail by default; renders as a vertical list when `view === 'list'` so a
 *  page-level card/list toggle flips every shelf, matching YouTube's home page behavior.
 *  `onDismiss` (suggestion rails) adds a "Not interested" X to each card. */
export function HubMediaShelf({ title, to, items, view = 'grid', showSource, onDismiss }: {
  title: string
  to?: string
  items: HubVideoItem[]
  view?: CardListView
  showSource?: boolean
  onDismiss?: (item: HubVideoItem) => void
}) {
  // Before the empty guard: hooks cannot run conditionally, and an empty list is a no-op here.
  useScrollAheadImages(hubItemImageUrls(items))
  if (!items.length) return null
  // Match the page toggle so a shelf's cards are the same shape as the grid below it.
  const tall = view === 'big'
  const shape: 'wide' | 'tall' = tall ? 'tall' : 'wide'
  const wrap = (i: HubVideoItem, node: ReactNode) =>
    onDismiss ? <DismissableCard onDismiss={() => onDismiss(i)}>{node}</DismissableCard> : node
  return (
    <section>
      <SectionHeader title={title} to={to} className="mb-4" />
      {view === 'list' ? (
        <div className="space-y-1">
          {items.map((i, idx) => (
            <div key={`${i.source}:${i.id}`}>
              {wrap(i, <HubRow item={i} showSource={showSource} eager={idx < EAGER_RAIL_CARDS} />)}
            </div>
          ))}
        </div>
      ) : (
        <HScroll>
          {items.map((i, idx) => (
            <div key={`${i.source}:${i.id}`} className={cn('shrink-0', tall ? 'w-44' : 'w-72')}>
              {wrap(i, <HubCard item={i} showSource={showSource} shape={shape} eager={idx < EAGER_RAIL_CARDS} />)}
            </div>
          ))}
        </HScroll>
      )}
    </section>
  )
}
