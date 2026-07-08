import { useMemo } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { SkeletonCards } from '@/components/shared/SkeletonBlocks'
import { HubVideoCollection } from '@/components/videos/HubVideoCollection'
import { InfiniteLoadMore } from '@/components/videos/InfiniteLoadMore'
import { SHELF_PREVIEW_COUNT } from '@/components/videos/SourceDiscovery'
import { browseSource, type HubVideoItem, type VideoSource } from '@/lib/videos/api'
import type { CardListView } from '@/components/shared/ViewToggle'

const keyOf = (it: HubVideoItem) => `${it.source}:${it.id}`

/** The dashboard's "More to explore" section: a big, paginated grid of a source's discovery
 *  feed, below the Popular/Trending shelves. Sources whose `browse` returns a cursor (Vimeo)
 *  scroll forever; sources with a single fixed pool (TikTok) render one large page and the
 *  load-more sentinel simply hides. The Popular shelf above previews this same feed's first
 *  SHELF_PREVIEW_COUNT cards, so the grid drops those and continues from there — no repeats. */
export function SourceExploreGrid({ source, feed = 'popular', view }: {
  source: VideoSource
  /** Discovery feed to page through; defaults to the source's popular ranking. */
  feed?: string
  view: CardListView
}) {
  const query = useInfiniteQuery({
    queryKey: ['videos-explore', source, feed],
    queryFn: ({ pageParam }) => browseSource(source, { feed, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.cursor,
    staleTime: 10 * 60_000,
  })

  const items = useMemo(() => {
    const seen = new Set<string>()
    const out: HubVideoItem[] = []
    for (const page of query.data?.pages ?? []) {
      for (const it of page.items) {
        const k = keyOf(it)
        if (seen.has(k)) continue   // a provider can repeat a card across pages
        seen.add(k)
        out.push(it)
      }
    }
    // Skip the first slice the Popular shelf already showed (page one is the same feed).
    return out.slice(SHELF_PREVIEW_COUNT)
  }, [query.data])

  if (query.isLoading) return <SkeletonCards count={12} className="xl:grid-cols-4" />
  if (!items.length && !query.hasNextPage) return null

  return (
    <section>
      <SectionHeader title="More to explore" className="mb-4" />
      <HubVideoCollection items={items} view={view} showSource={false} />
      <InfiniteLoadMore
        hasNextPage={!!query.hasNextPage}
        isFetchingNextPage={query.isFetchingNextPage}
        fetchNextPage={() => void query.fetchNextPage()}
      />
    </section>
  )
}
