import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { browseSource, type HubVideoItem, type SourceInfo, type VideoSource } from '@/lib/videos/api'
import { HubMediaShelf } from '@/components/videos/HubMediaShelf'
import { ytItemToHub } from '@/components/videos/HubCard'
import { ShelfSkeleton } from '@/components/youtube/shelves'
import type { CardListView } from '@/components/shared/ViewToggle'
import type { VideoCategory } from '@/lib/videos/categories'
import { search as ytSearch } from '@/lib/youtube/api'
import { searchToItem } from '@/lib/youtube/types'

// Same emoji + plain labels as YoutubeHomePage's own Popular/Trending shelves — no "on
// {source}" suffix, since this renders on that source's own page (redundant there, the
// way YouTube's Home doesn't say "Popular on YouTube" either).
const FEED_LABEL: Record<'popular' | 'trending', string> = { popular: '🔥 Popular', trending: '📈 Trending' }

// A discovery shelf is a preview row, not the whole feed — it shows the first slice and the
// "More to explore" grid below (SourceExploreGrid) continues past this offset, so the two
// never repeat the same cards. Both sides share this constant.
export const SHELF_PREVIEW_COUNT = 16

/** Round-robin interleave: a[0], b[0], c[0], a[1], b[1]… so every source is represented
 *  evenly near the top even when one has far more items than another. */
function interleave(lists: HubVideoItem[][]): HubVideoItem[] {
  const out: HubVideoItem[] = []
  const seen = new Set<string>()
  const max = lists.reduce((m, l) => Math.max(m, l.length), 0)
  for (let i = 0; i < max; i++) {
    for (const list of lists) {
      const it = list[i]
      if (it && !seen.has(`${it.source}:${it.id}`)) { seen.add(`${it.source}:${it.id}`); out.push(it) }
    }
  }
  return out
}

function DiscoveryShelf({ source, feed, view }: { source: VideoSource; feed: 'popular' | 'trending'; view: CardListView }) {
  const { data, isLoading } = useQuery({
    queryKey: ['videos-discover', source, feed],
    queryFn: () => browseSource(source, { feed }),
    staleTime: 10 * 60_000,
  })
  const items = data?.items ?? []
  if (!items.length) return isLoading ? <ShelfSkeleton /> : null
  return (
    <HubMediaShelf
      title={FEED_LABEL[feed]}
      items={items.slice(0, SHELF_PREVIEW_COUNT)}
      view={view}
      showSource={false}
    />
  )
}

/** Popular + Trending shelves for one source — whichever rankings the provider actually
 *  serves (see each provider's `discovery`). Used on a single source's own page. */
export function SourceDiscovery({ source, discovery, view = 'grid' }: {
  source: VideoSource
  discovery: Array<'popular' | 'trending'>
  view?: CardListView
}) {
  if (!discovery.length) return null
  return <>{discovery.map((feed) => <DiscoveryShelf key={feed} source={source} feed={feed} view={view} />)}</>
}

interface Target { source: VideoSource; feed: 'popular' | 'trending' }

/** One mixed shelf: each source fetched with its assigned feed, then interleaved round-robin
 *  so it reads as one unified surface (the uniform card size makes this clean). */
function MixedShelf({ targets, title, view }: { targets: Target[]; title: string; view: CardListView }) {
  const results = useQueries({
    queries: targets.map((t) => ({
      queryKey: ['videos-discover', t.source, t.feed],
      queryFn: () => browseSource(t.source, { feed: t.feed }),
      staleTime: 10 * 60_000,
    })),
  })
  // Depend on the settled data, not the (new-each-render) results array.
  const dataKey = results.map((r) => (r.data ? r.data.items.length : -1)).join(',')
  const items = useMemo(
    () => interleave(results.map((r) => r.data?.items ?? [])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataKey],
  )
  if (!items.length) return null
  return <HubMediaShelf title={title} items={items} view={view} showSource />
}

/** The hub home's two mixed discovery sections. Popular mixes every source's popular feed.
 *  Trending mixes only sources that expose a REAL, distinct trending ranking (YouTube,
 *  Reddit) — TikTok/Vimeo have a single feed each, so folding them in just duplicated their
 *  Popular; the Trending shelf simply doesn't include them rather than repeating content. */
export function MixedDiscovery({ sources, view = 'grid' }: { sources: SourceInfo[]; view?: CardListView }) {
  const popular: Target[] = sources
    .filter((s) => s.discovery.includes('popular'))
    .map((s) => ({ source: s.source, feed: 'popular' }))
  const trending: Target[] = sources
    .filter((s) => s.discovery.includes('trending'))
    .map((s) => ({ source: s.source, feed: 'trending' }))
  return (
    <>
      {popular.length > 0 && <MixedShelf targets={popular} title={FEED_LABEL.popular} view={view} />}
      {trending.length > 0 && <MixedShelf targets={trending} title={FEED_LABEL.trending} view={view} />}
    </>
  )
}

// A source's leg of a unified category: the three hub providers browse a mapped feed id;
// YouTube has no real category/genre browse surface, so it fakes one via live search —
// the same approach YoutubeHomePage's own TopicFeed already uses successfully.
type CategoryTarget = { source: Exclude<VideoSource, 'youtube' | 'link'>; feed: string } | { source: 'youtube'; searchQuery: string }

async function fetchCategoryItems(t: CategoryTarget): Promise<HubVideoItem[]> {
  if (t.source === 'youtube') {
    const r = await ytSearch(t.searchQuery, null, 'videos')
    return r.results.map(searchToItem).map(ytItemToHub)
  }
  const r = await browseSource(t.source, { feed: t.feed })
  return r.items
}

/** Cross-source data for one unified category, restricted to whichever sources are
 *  currently active AND actually configured (e.g. Reddit with no client id never gets
 *  queried here — same "don't even ask" contract as its own ConnectRedditCard gate).
 *  Each source contributes at most one leg (its mapped feed, or a YouTube search on the
 *  category label), interleaved round-robin like every other mixed surface here. */
export function useCategoryFeed(category: VideoCategory, activeSources: SourceInfo[]) {
  const configured = new Set(activeSources.filter((s) => s.status.configured).map((s) => s.source))
  const targets: CategoryTarget[] = []
  for (const [source, feed] of Object.entries(category.feeds) as Array<[Exclude<VideoSource, 'youtube' | 'link'>, string]>) {
    if (configured.has(source)) targets.push({ source, feed })
  }
  if (configured.has('youtube')) targets.push({ source: 'youtube', searchQuery: category.label })

  const results = useQueries({
    queries: targets.map((t) => ({
      queryKey: t.source === 'youtube' ? ['videos-category-yt', t.searchQuery] : ['videos-discover', t.source, t.feed],
      queryFn: () => fetchCategoryItems(t),
      staleTime: 10 * 60_000,
    })),
  })
  // Depend on the settled data, not the (new-each-render) results array.
  const dataKey = results.map((r) => (r.data ? r.data.length : -1)).join(',')
  const items = useMemo(
    () => interleave(results.map((r) => r.data ?? [])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataKey],
  )
  return {
    items,
    hasSources: targets.length > 0,
    // Blocks only the initial skeleton — as soon as the fastest leg resolves, show what
    // it has. Waiting for EVERY leg (a cold TikTok category can take ~10s of yt-dlp
    // extraction) would make the whole grid hang instead of just growing/reordering
    // in place as slower sources land.
    isLoading: targets.length > 0 && results.every((r) => r.isLoading),
    // True while some (but not all) legs are still in flight — lets the caller show a
    // small "still loading more sources" cue instead of pretending the grid is final.
    isSettling: targets.length > 1 && results.some((r) => r.isLoading) && results.some((r) => !r.isLoading),
  }
}
