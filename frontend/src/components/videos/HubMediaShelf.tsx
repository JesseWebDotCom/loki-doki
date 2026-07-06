import { cn } from '@/lib/cn'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { HScroll } from '@/components/youtube/shelves'
import type { CardListView } from '@/components/shared/ViewToggle'
import type { HubVideoItem } from '@/lib/videos/api'
import { HubVideoCard } from '@/components/videos/HubVideoCard'
import { HubVideoListRow } from '@/components/videos/HubVideoListRow'

/** A titled shelf of hub items: the source-agnostic counterpart to youtube's MediaShelf.
 *  Horizontal card rail by default; renders as a vertical list when `view === 'list'` so a
 *  page-level card/list toggle flips every shelf, matching YouTube's home page behavior. */
export function HubMediaShelf({ title, items, view = 'grid', showSource }: {
  title: string
  items: HubVideoItem[]
  view?: CardListView
  showSource?: boolean
}) {
  if (!items.length) return null
  return (
    <section>
      <SectionHeader title={title} className="mb-4" />
      {view === 'list' ? (
        <div className="space-y-1">
          {items.map((i) => <HubVideoListRow key={`${i.source}:${i.id}`} item={i} showSource={showSource} />)}
        </div>
      ) : (
        <HScroll>
          {items.map((i) => (
            <div key={`${i.source}:${i.id}`} className={cn('shrink-0', i.vertical ? 'w-44' : 'w-72')}>
              <HubVideoCard item={i} showSource={showSource} />
            </div>
          ))}
        </HScroll>
      )}
    </section>
  )
}
