import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { browseSource, type HubVideoItem, type SourceInfo, type VideoSource } from '@/lib/videos/api'
import { HubMediaShelf } from '@/components/videos/HubMediaShelf'
import { SOURCE_META } from '@/lib/videos/sources'
import type { CardListView } from '@/components/shared/ViewToggle'

const FEED_LABEL: Record<'popular' | 'trending', string> = { popular: 'Popular', trending: 'Trending' }

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
  const { data } = useQuery({
    queryKey: ['videos-discover', source, feed],
    queryFn: () => browseSource(source, { feed }),
    staleTime: 10 * 60_000,
  })
  const items = data?.items ?? []
  if (!items.length) return null
  return (
    <HubMediaShelf
      title={`${FEED_LABEL[feed]} on ${SOURCE_META[source].label}`}
      to={`/videos/${source}`}
      items={items}
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

/** One ranking (Popular or Trending) mixed across sources into a single shelf, round-robin
 *  ordered so it reads as one unified surface (the uniform card size makes this clean). */
function MixedShelf({ sources, feed, view }: { sources: VideoSource[]; feed: 'popular' | 'trending'; view: CardListView }) {
  const results = useQueries({
    queries: sources.map((s) => ({
      queryKey: ['videos-discover', s, feed],
      queryFn: () => browseSource(s, { feed }),
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
  return <HubMediaShelf title={FEED_LABEL[feed]} items={items} view={view} showSource />
}

/** The hub home's two mixed discovery sections: Popular (every source that has one) and
 *  Trending (only sources that expose a trending ranking — YouTube, Reddit). */
export function MixedDiscovery({ sources, view = 'grid' }: { sources: SourceInfo[]; view?: CardListView }) {
  const popular = sources.filter((s) => s.discovery.includes('popular')).map((s) => s.source)
  const trending = sources.filter((s) => s.discovery.includes('trending')).map((s) => s.source)
  return (
    <>
      {popular.length > 0 && <MixedShelf sources={popular} feed="popular" view={view} />}
      {trending.length > 0 && <MixedShelf sources={trending} feed="trending" view={view} />}
    </>
  )
}
