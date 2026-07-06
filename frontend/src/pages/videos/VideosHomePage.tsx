import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { Play, Film } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { SkeletonCards } from '@/components/shared/SkeletonBlocks'
import { MediaShelf, ShelfSkeleton } from '@/components/youtube/shelves'
import { VideoCollection } from '@/components/youtube/VideoCollection'
import { SearchResults } from '@/components/youtube/SearchResults'
import { ViewToggle } from '@/components/shared/ViewToggle'
import { useViewPreference } from '@/hooks/useViewPreference'
import { getHistory } from '@/lib/youtube/api'
import { historyToItem, type VideoItem } from '@/lib/youtube/types'
import { getHubHome, getVideoSources, type HubVideoItem, type VideoSource } from '@/lib/videos/api'
import { useSourceFilter } from '@/lib/videos/useSourceFilter'

/** Hub items from the YouTube source render through the existing card system. Items
 *  from other sources get their own cards when those providers land (Phase 3+). */
function hubToYtItem(it: HubVideoItem): VideoItem {
  return {
    videoId: it.id,
    title: it.title,
    author: it.creator?.name ?? null,
    channelId: it.creator?.id ?? null,
    channelThumb: it.creator?.avatarUrl ?? null,
    durationSec: it.durationSec ?? null,
    ageLabel: it.publishedText ?? undefined,
    views: it.viewsText ?? null,
  }
}

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
  const [view, setView] = useViewPreference('videos.home_view', 'grid')
  const { selected, toggle } = useSourceFilter()

  const { data: sourcesData } = useQuery({ queryKey: ['videos-sources'], queryFn: getVideoSources, staleTime: 5 * 60_000 })
  const sources = sourcesData?.sources ?? []
  const allIds = useMemo(() => sources.map((s) => s.source), [sources])
  const active: VideoSource[] = selected.length === 0 ? allIds : selected

  const { data: homeData, isLoading } = useQuery({
    queryKey: ['videos-home', [...active].sort().join(',')],
    queryFn: () => getHubHome(selected.length === 0 ? undefined : selected),
    enabled: sources.length > 0,
  })

  const { data: history = [], isLoading: historyLoading } = useQuery({ queryKey: ['yt-history'], queryFn: getHistory })
  const continueWatching = useMemo(
    () => history.filter((h) => !h.completed && h.positionSec > 5).map(historyToItem),
    [history],
  )

  // Until non-YouTube providers land, every hub item is a YouTube item.
  const feedItems = useMemo(
    () => (homeData?.items ?? []).filter((it) => it.source === 'youtube').map(hubToYtItem),
    [homeData],
  )

  return (
    <PageContainer width="wide" className="py-6">
      <div className="mb-6 flex items-center gap-3">
        <ChipRow className="mb-0 min-w-0 flex-1">
          {sources.map((s) => (
            <Chip
              key={s.source}
              label={s.label}
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

        <section>
          <SectionHeader title="Across your sources" className="mb-4" />
          {isLoading ? (
            <SkeletonCards count={12} className="xl:grid-cols-4" />
          ) : feedItems.length > 0 ? (
            <VideoCollection items={feedItems} view={view} />
          ) : (
            <EmptyFeed />
          )}
        </section>
      </div>
    </PageContainer>
  )
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
