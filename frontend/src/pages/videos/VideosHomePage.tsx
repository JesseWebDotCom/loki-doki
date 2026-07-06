import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { Play, Film, Plug } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { SkeletonCards } from '@/components/shared/SkeletonBlocks'
import { MediaShelf, ShelfSkeleton } from '@/components/youtube/shelves'
import { VideoCard } from '@/components/youtube/VideoCard'
import { SearchResults } from '@/components/youtube/SearchResults'
import { HubVideoCard } from '@/components/videos/HubVideoCard'
import { getHistory } from '@/lib/youtube/api'
import { historyToItem, type VideoItem } from '@/lib/youtube/types'
import { getHubHome, getVideoSources, listFollows, type HubVideoItem, type SourceInfo, type VideoSource } from '@/lib/videos/api'
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

  const feedItems = useMemo(() => homeData?.items ?? [], [homeData])

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
      </div>

      <SourceNudges sources={sources} />

      <div className="space-y-10">
        {continueWatching.length > 0 ? (
          <MediaShelf title="Continue watching" items={continueWatching} view="grid" />
        ) : historyLoading ? <ShelfSkeleton /> : null}

        <section>
          <SectionHeader title="Across your sources" className="mb-4" />
          {isLoading ? (
            <SkeletonCards count={12} className="xl:grid-cols-4" />
          ) : feedItems.length > 0 ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 xl:grid-cols-4">
              {feedItems.map((it) => it.source === 'youtube' ? (
                <div key={`yt:${it.id}`} className="relative">
                  {/* design-ok(raw-palette-semantic): YouTube brand identity chip on mixed-feed cards */}
                  <span className="pointer-events-none absolute left-1.5 top-1.5 z-10 rounded-full bg-red-600/90 px-2 py-0.5 text-[10px] font-semibold text-white">YouTube</span>
                  <VideoCard item={hubToYtItem(it)} />
                </div>
              ) : (
                <HubVideoCard key={`${it.source}:${it.id}`} item={it} />
              ))}
            </div>
          ) : (
            <EmptyFeed />
          )}
        </section>
      </div>
    </PageContainer>
  )
}

/** Why a source is quiet: connect nudges for key-gated sources, a follow nudge for
 *  TikTok. Dismiss = connect (the chip disappears once /sources reports configured). */
function SourceNudges({ sources }: { sources: SourceInfo[] }) {
  const { data: followsData } = useQuery({ queryKey: ['videos-follows'], queryFn: listFollows })
  const nudges: Array<{ key: string; to: string; text: string }> = []
  for (const s of sources) {
    if (!s.status.configured) {
      nudges.push({ key: s.source, to: `/videos/${s.source}`, text: `Connect ${s.label} to see its videos here` })
    } else if (s.source === 'tiktok' && !(followsData?.follows ?? []).some((f) => f.source === 'tiktok')) {
      nudges.push({ key: 'tiktok', to: '/videos/tiktok', text: 'Follow TikTok creators to mix them in here' })
    }
  }
  if (nudges.length === 0) return null
  return (
    <div className="mb-6 flex flex-wrap gap-2">
      {nudges.map((n) => (
        <Link key={n.key} to={n.to}
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card/60 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground">
          <Plug className="size-3.5" /> {n.text}
        </Link>
      ))}
    </div>
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
