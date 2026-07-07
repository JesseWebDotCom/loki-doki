import { useMemo } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { Play, Film } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { ChipRow } from '@/components/shared/ChipRow'
import { SkeletonCards } from '@/components/shared/SkeletonBlocks'
import { ViewToggle } from '@/components/shared/ViewToggle'
import { useViewPreference } from '@/hooks/useViewPreference'
import { MediaShelf, ShelfSkeleton } from '@/components/youtube/shelves'
import { YT_GRID, YT_SHORTS_GRID } from '@/components/youtube/VideoCollection'
import { SearchResults } from '@/components/youtube/SearchResults'
import { HubCard, HubRow } from '@/components/videos/HubCard'
import { InfiniteLoadMore } from '@/components/videos/InfiniteLoadMore'
import { MixedDiscovery } from '@/components/videos/SourceDiscovery'
import { SourceChip } from '@/components/videos/SourceChip'
import { getHistory } from '@/lib/youtube/api'
import { historyToItem, type VideoItem } from '@/lib/youtube/types'
import { getHubHome, getVideoSources, type HubVideoItem, type VideoSource } from '@/lib/videos/api'
import { useSourceFilter } from '@/lib/videos/useSourceFilter'

// The Videos hub landing: source pills filter a mixed feed interleaved across every
// enabled provider. Doubles as search results when a `?q=` is present (search box
// submits to the YouTube results view until multi-source search lands).
export function VideosHomePage() {
  const [params] = useSearchParams()
  const q = (params.get('q') ?? '').trim()
  if (q) return <SearchResults q={q} />
  return <HubLanding />
}

function HubLanding() {
  const { selected, toggle } = useSourceFilter()
  const [view, setView] = useViewPreference('videos.home_view', 'grid')

  const { data: sourcesData } = useQuery({ queryKey: ['videos-sources'], queryFn: getVideoSources, staleTime: 5 * 60_000 })
  const sources = (sourcesData?.sources ?? []).filter((s) => s.enabled)
  const allIds = useMemo(() => sources.map((s) => s.source), [sources])
  const active: VideoSource[] = selected.length === 0 ? allIds : selected

  const homeQuery = useInfiniteQuery({
    queryKey: ['videos-home', [...active].sort().join(',')],
    queryFn: ({ pageParam }) => getHubHome(selected.length === 0 ? undefined : selected, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.cursor,
    enabled: sources.length > 0,
  })
  const isLoading = homeQuery.isLoading

  const { data: history = [], isLoading: historyLoading } = useQuery({ queryKey: ['yt-history'], queryFn: getHistory })
  const continueWatching = useMemo(
    () => history.filter((h) => !h.completed && h.positionSec > 5).map(historyToItem),
    [history],
  )

  // Flatten pages, dedup by source:id (a provider can occasionally repeat across pages).
  const feedItems = useMemo(() => {
    const seen = new Set<string>()
    const out: HubVideoItem[] = []
    for (const page of homeQuery.data?.pages ?? []) for (const it of page.items) {
      const k = `${it.source}:${it.id}`
      if (!seen.has(k)) { seen.add(k); out.push(it) }
    }
    return out
  }, [homeQuery.data])

  return (
    <PageContainer width="wide" className="py-6">
      <div className="mb-6 flex items-center gap-3">
        <ChipRow className="mb-0 min-w-0 flex-1">
          {sources.map((s) => (
            <SourceChip
              key={s.source}
              source={s.source}
              active={active.includes(s.source)}
              onClick={() => toggle(s.source, allIds)}
            />
          ))}
        </ChipRow>
        <ViewToggle value={view} onChange={setView} className="shrink-0" />
      </div>

      <div className="space-y-10">
        {continueWatching.length > 0 ? (
          <MediaShelf title="Continue watching" items={continueWatching} view={view} />
        ) : historyLoading ? <ShelfSkeleton /> : null}

        {/* One mixed Popular + one mixed Trending, interleaved across every active source. */}
        <MixedDiscovery sources={sources.filter((s) => active.includes(s.source))} view={view} />

        <section>
          <SectionHeader title="Across your sources" className="mb-4" />
          {isLoading ? (
            <SkeletonCards count={12} className="xl:grid-cols-4" />
          ) : feedItems.length > 0 ? (
            <>
              <div className={view === 'list' ? 'space-y-1' : view === 'big' ? YT_SHORTS_GRID : YT_GRID}>
                {feedItems.map((it) => (
                  <FeedCard key={`${it.source}:${it.id}`} item={it} view={view} />
                ))}
              </div>
              <InfiniteLoadMore
                hasNextPage={!!homeQuery.hasNextPage}
                isFetchingNextPage={homeQuery.isFetchingNextPage}
                fetchNextPage={() => void homeQuery.fetchNextPage()}
              />
            </>
          ) : (
            <EmptyFeed />
          )}
        </section>
      </div>
    </PageContainer>
  )
}

/** One mixed-feed card: HubCard renders YouTube items as the richer VideoCard (hover
 *  preview, save, progress) and every other source as HubVideoCard, all one size via `view`. */
function FeedCard({ item, view }: { item: HubVideoItem; view: 'big' | 'grid' | 'list' }) {
  if (view === 'list') return <HubRow item={item} />
  return <HubCard item={item} shape={view === 'big' ? 'tall' : 'wide'} />
}

function EmptyFeed() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
      <Film className="mb-3 size-10 opacity-30" />
      <p className="text-sm font-medium">Nothing here yet</p>
      <p className="mt-1 inline-flex items-center gap-1 text-xs">
        Browse a source from the rail <Play className="size-3" /> or paste a link into Clip a Link.
      </p>
    </div>
  )
}
