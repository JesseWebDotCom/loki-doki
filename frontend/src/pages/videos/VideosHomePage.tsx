import { useMemo, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { Film, Users } from 'lucide-react'
import { cn } from '@/lib/cn'
import { cardVariants } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { BlendedHeroBackdrop } from '@/components/shared/BlendedHeroBackdrop'
import { PageContainer } from '@/components/shared/PageContainer'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { SkeletonCards } from '@/components/shared/SkeletonBlocks'
import { ViewToggle } from '@/components/shared/ViewToggle'
import { useViewPreference } from '@/hooks/useViewPreference'
import { ShelfSkeleton } from '@/components/youtube/shelves'
import { YT_GRID, YT_SHORTS_GRID } from '@/components/youtube/VideoCollection'
import { HubCard, HubRow, hubHistoryToItem, ytItemToHub } from '@/components/videos/HubCard'
import { HubMediaShelf } from '@/components/videos/HubMediaShelf'
import { MineCard, MineRow } from '@/components/videos/MineCard'
import { InfiniteLoadMore } from '@/components/videos/InfiniteLoadMore'
import { MixedDiscovery, useCategoryFeed } from '@/components/videos/SourceDiscovery'
import { SourceChip, MineChip } from '@/components/videos/SourceChip'
import { VideoBillboard } from '@/components/videos/VideoBillboard'
import { MINE_META } from '@/lib/videos/sources'
import { VIDEO_CATEGORIES, getVideoCategory, type VideoCategory } from '@/lib/videos/categories'
import { getHistory } from '@/lib/youtube/api'
import { historyToItem } from '@/lib/youtube/types'
import { getBlend, getHubHistory, getHubHome, getSuggested, getVideoSources, type HubVideoItem, type SourceInfo, type VideoSource } from '@/lib/videos/api'
import { useSuggestionDismiss } from '@/hooks/useSuggestionDismiss'
import { useSourceFilter } from '@/lib/videos/useSourceFilter'
import { PlaySomethingButton } from '@/components/videos/PlaySomethingButton'
import { useYoutubeModeOptional } from '@/components/videos/VideosLayout'
import { listStudioBin, isMineBinItem } from '@/lib/videos/studioApi'

// The Videos hub landing: source pills filter a mixed feed interleaved across every
// enabled provider. (Search lives on /videos/search, the multi-source VideosSearchPage;
// the old ?q= YouTube-only fallback here is gone.)
export function VideosHomePage() {
  return <HubLanding />
}

function HubLanding() {
  const [params] = useSearchParams()
  const { selected, toggle } = useSourceFilter()
  // Mine (Studio bin content) isn't a real VideoSource — no provider, no server pagination —
  // so it's a separate exclusive toggle rather than folded into the persisted multi-select
  // `selected` above.
  const [mineOnly, setMineOnly] = useState(false)
  // Unified category chips (Comedy, Sports, ...): selecting one swaps the default body for a
  // single cross-source mixed feed, same interaction as YoutubeHomePage's own TOPICS chips.
  // Seeded from `?category=` so the Home widget's entry chips can deep-link straight into one.
  const [category, setCategory] = useState<string | null>(() => {
    const c = params.get('category')
    return c && getVideoCategory(c) ? c : null
  })
  const [view, setView] = useViewPreference('videos.home_view', 'grid')
  const { data: mineBin } = useQuery({ queryKey: ['studio-bin'], queryFn: listStudioBin, enabled: mineOnly })
  const mineItems = useMemo(() => (mineBin?.items ?? []).filter(isMineBinItem), [mineBin])

  const { data: sourcesData } = useQuery({ queryKey: ['videos-sources'], queryFn: getVideoSources, staleTime: 5 * 60_000 })
  const sources = (sourcesData?.sources ?? []).filter((s) => s.enabled)
  // Approved-only mode (kids): no discovery affordances. The feed below is already
  // server-filtered to approved creators; hiding chips/suggestions removes dead ends.
  // noSuggestions is the softer per-user limit that hides just the discovery rails.
  const allowlistOnly = sourcesData?.allowlistOnly === true
  const hideDiscovery = allowlistOnly || sourcesData?.viewFlags?.noSuggestions === true
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

  const { data: history = [], isLoading: ytHistoryLoading } = useQuery({ queryKey: ['yt-history'], queryFn: getHistory })
  const { data: hubHistoryData, isLoading: hubHistoryLoading } = useQuery({ queryKey: ['videos-history'], queryFn: getHubHistory })

  // Family Blend: what more than one of you follows, minus what you've watched.
  const { data: blendData } = useQuery({ queryKey: ['videos-blend'], queryFn: getBlend, staleTime: 5 * 60_000 })
  const blend = blendData?.items ?? []

  // Live Watch Together rooms: anyone in the household can hop in from here.
  const { data: wtData } = useQuery({
    queryKey: ['watch-together-sessions'],
    queryFn: () => fetch('/api/watch-together/sessions', { credentials: 'include' })
      .then((r) => r.json()) as Promise<{ sessions: Array<{
        id: string; hostName: string; memberCount: number
        media: { source: string; videoId: string; title: string }
      }> }>,
    refetchInterval: 30_000,
  })
  const wtSessions = (wtData?.sessions ?? []).filter((s) => s.memberCount > 0)
  // "Suggested for you" from the interest engine. While the first pool build runs the
  // response is empty + building:true; poll until suggestions land (shelf hidden till then,
  // the page already has Popular/Trending, so no fallback rail).
  const { data: suggestedData } = useQuery({
    queryKey: ['videos-suggested'],
    queryFn: getSuggested,
    refetchInterval: (query) => (query.state.data?.building ? 20_000 : false),
  })
  const { hidden: dismissedRefs, dismiss } = useSuggestionDismiss('videos')
  const suggested = useMemo(
    () => (suggestedData?.items ?? []).filter((i) => !dismissedRefs.has(`${i.source}:${i.id}`)),
    [suggestedData, dismissedRefs],
  )
  const historyLoading = ytHistoryLoading || hubHistoryLoading
  // Merged across every source (not just YouTube) so the shelf matches "Across your sources"
  // below it — each card keeps its own source badge via HubCard.
  const continueWatching = useMemo(() => {
    const yt = history
      .filter((h) => !h.completed && h.positionSec > 5 && h.title.trim())
      .map((h) => ({ item: ytItemToHub(historyToItem(h)), updatedAt: h.updatedAt }))
    const hub = (hubHistoryData?.history ?? [])
      .filter((h) => !h.completed && h.positionSec > 5 && h.title.trim())
      .map((h) => ({ item: hubHistoryToItem(h), updatedAt: h.updatedAt }))
    return [...yt, ...hub].sort((a, b) => b.updatedAt - a.updatedAt).map((x) => x.item)
  }, [history, hubHistoryData])

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

  const activeCategory = category ? getVideoCategory(category) : null

  // The billboard's editorial picks: the head of the mixed feed as an auto-rotating
  // carousel, its starting order shifted daily (same day-index trick as Music's "Station
  // of the day") so the first slide isn't always the same video. Falls back to the
  // freshest resume item when discovery hasn't landed; filtered contexts (Mine, category)
  // are task-mode and suppress it entirely.
  const featured = useMemo(() => {
    const pool = feedItems.slice(0, 6)
    if (pool.length === 0) return []
    const day = Math.floor(Date.now() / 86_400_000)
    const start = day % pool.length
    return [...pool.slice(start), ...pool.slice(0, start)]
  }, [feedItems])
  const resumeFallback = featured.length === 0 ? continueWatching[0] ?? null : null
  // Don't show the same video twice on one screen when the billboard IS the resume item.
  const railContinue = resumeFallback
    ? continueWatching.filter((i) => !(i.source === resumeFallback.source && i.id === resumeFallback.id))
    : continueWatching

  return (
    <PageContainer width="wide" className="py-6">
      {!mineOnly && !activeCategory && (
        featured.length > 0 ? <VideoBillboard items={featured} eyebrow="Featured today" />
          : resumeFallback ? <VideoBillboard items={[resumeFallback]} eyebrow="Continue watching" resume /> : null
      )}

      {wtSessions.length > 0 && (
        <div className="mb-4 space-y-2">
          {wtSessions.map((s) => (
            <Link key={s.id}
              to={`/videos/${s.media.source}/watch/${encodeURIComponent(s.media.videoId)}?wt=${s.id}`}
              className={cn(cardVariants({ variant: 'interactive' }), 'flex items-center gap-3 px-4 py-3')}>
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand/15 text-brand">
                <Users className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">
                  {s.hostName} is watching {s.media.title}
                </span>
                <span className="block text-xs text-muted-foreground">
                  Watching together · {s.memberCount} {s.memberCount === 1 ? 'person' : 'people'} in the room
                </span>
              </span>
              <span className="shrink-0 text-sm font-semibold text-brand">Join</span>
            </Link>
          ))}
        </div>
      )}

      {/* One scrolling chip line (mobile contract): identity filters first, then categories. */}
      <div className="mb-6 flex items-center gap-3">
        <ChipRow className="mb-0 min-w-0 flex-1">
          <MineChip active={mineOnly} onClick={() => { setCategory(null); setMineOnly((v) => !v) }} />
          {sources.map((s) => (
            <SourceChip
              key={s.source}
              source={s.source}
              active={!mineOnly && active.includes(s.source)}
              onClick={() => { setMineOnly(false); toggle(s.source, allIds) }}
            />
          ))}
          {!allowlistOnly && (
            <>
              <div aria-hidden className="mx-1 h-4 w-px shrink-0 self-center bg-border" />
              <Chip label="All" active={category === null && !mineOnly} onClick={() => { setMineOnly(false); setCategory(null) }} />
              {VIDEO_CATEGORIES.map((c) => (
                <Chip
                  key={c.id}
                  label={c.label}
                  active={category === c.id}
                  onClick={() => { setMineOnly(false); setCategory(category === c.id ? null : c.id) }}
                />
              ))}
            </>
          )}
        </ChipRow>
        <PlaySomethingButton className="hidden shrink-0 sm:inline-flex" />
        <ViewToggle value={view} onChange={setView} className="shrink-0" />
      </div>

      {mineOnly ? (
        <section>
          <SectionHeader title="Mine" className="mb-4" />
          {mineItems.length > 0 ? (
            <div className={view === 'list' ? 'space-y-1' : view === 'big' ? YT_SHORTS_GRID : YT_GRID}>
              {mineItems.map((item) => view === 'list'
                ? <MineRow key={item.assetId} item={item} />
                : <MineCard key={item.assetId} item={item} shape={view === 'big' ? 'tall' : 'wide'} />)}
            </div>
          ) : (
            <EmptyMine />
          )}
        </section>
      ) : activeCategory ? (
        <CategoryBody category={activeCategory} activeSources={sources.filter((s) => active.includes(s.source))} view={view} />
      ) : (
        <div className="space-y-10">
          {railContinue.length > 0 ? (
            <HubMediaShelf title="Continue watching" items={railContinue} view={view} />
          ) : historyLoading ? <ShelfSkeleton /> : null}

          {/* Family Blend: fresh videos from creators more than one of you follows,
              computed from the plain overlap (no profiling). Shown even in approved-only
              mode: it is your household's own shared taste, not algorithmic discovery. */}
          {blend.length > 0 && (
            <HubMediaShelf
              title="Your family also watches"
              items={blend}
              view={view}
              showSource
            />
          )}

          {!hideDiscovery && (
            <HubMediaShelf
              title="Suggested for you"
              items={suggested}
              view={view}
              showSource
              onDismiss={(i) => dismiss({ ref: `${i.source}:${i.id}`, creatorId: i.creator?.id, creatorName: i.creator?.name, title: i.title })}
            />
          )}

          {/* One mixed Popular + one mixed Trending, interleaved across every active source. */}
          {!hideDiscovery && <MixedDiscovery sources={sources.filter((s) => active.includes(s.source))} view={view} />}

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
      )}
    </PageContainer>
  )
}

/** Replaces the default body when a unified category chip is selected: one cross-source
 *  grid for that category, restricted to whichever sources are still active. */
function CategoryBody({ category, activeSources, view }: {
  category: VideoCategory
  activeSources: SourceInfo[]
  view: 'big' | 'grid' | 'list'
}) {
  const { items, isLoading, isSettling, hasSources } = useCategoryFeed(category, activeSources)
  return (
    <section>
      <div className="mb-4 flex items-center gap-2">
        <SectionHeader title={category.label} className="mb-0" />
        {/* A source (usually a cold TikTok category) is still fetching — the grid above
         *  already shows whatever's landed so far and will grow/reorder as it arrives. */}
        {isSettling && <Spinner className="size-3.5 text-muted-foreground/50" />}
      </div>
      {isLoading || (items.length === 0 && isSettling) ? (
        <SkeletonCards count={12} className="xl:grid-cols-4" />
      ) : items.length > 0 ? (
        <div className={view === 'list' ? 'space-y-1' : view === 'big' ? YT_SHORTS_GRID : YT_GRID}>
          {items.map((it) => <FeedCard key={`${it.source}:${it.id}`} item={it} view={view} />)}
        </div>
      ) : (
        <p className="py-20 text-center text-sm text-muted-foreground">
          {hasSources ? `Nothing found for "${category.label}" right now.` : `No active sources support "${category.label}" yet.`}
        </p>
      )}
    </section>
  )
}

function EmptyMine() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
      <MINE_META.icon className="mb-3 size-10 opacity-30" />
      <p className="text-sm font-medium">Nothing here yet</p>
      <p className="mt-1 text-xs">Upload, record, or generate a clip in Mine to see it here.</p>
    </div>
  )
}

/** One mixed-feed card: HubCard renders YouTube items as the richer VideoCard (hover
 *  preview, save, progress) and every other source as HubVideoCard, all one size via `view`. */
function FeedCard({ item, view }: { item: HubVideoItem; view: 'big' | 'grid' | 'list' }) {
  if (view === 'list') return <HubRow item={item} />
  return <HubCard item={item} shape={view === 'big' ? 'tall' : 'wide'} />
}

function EmptyFeed() {
  const mode = useYoutubeModeOptional()
  // design-ok(hex-in-tsx): mode identity accents mirrored from VideosLayout's ACCENT map
  const [color, colorDark] = mode === 'offline' ? ['#059669', '#022c22'] : ['#0891b2', '#164e63']
  return (
    <div className="relative overflow-hidden rounded-sheet shadow-xl">
      <BlendedHeroBackdrop art={null} color={color} colorDark={colorDark} />
      <div className="relative flex flex-col items-start gap-2 p-6 py-14 sm:p-9 sm:py-16">
        <Film className="mb-1 size-8 text-white/50" />
        <p className="text-xl font-extrabold tracking-tight text-white sm:text-2xl">Nothing here yet</p>
        <p className="max-w-md text-sm text-white/70">
          Browse a source to start your feed, or paste any video link and watch it here.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button asChild className="rounded-full"><Link to="/videos/youtube">Browse YouTube</Link></Button>
          <Button asChild variant="secondary" className="rounded-full"><Link to="/videos/clip">Clip a link</Link></Button>
        </div>
      </div>
    </div>
  )
}
