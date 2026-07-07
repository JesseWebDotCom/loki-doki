import { useQuery } from '@tanstack/react-query'
import { browseSource, type VideoSource } from '@/lib/videos/api'
import { HubMediaShelf } from '@/components/videos/HubMediaShelf'
import { SOURCE_META } from '@/lib/videos/sources'
import type { CardListView } from '@/components/shared/ViewToggle'

const FEED_LABEL: Record<'popular' | 'trending', string> = { popular: 'Popular', trending: 'Trending' }

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
 *  serves (see each provider's `discovery`). Used on the hub home and each source page. */
export function SourceDiscovery({ source, discovery, view = 'grid' }: {
  source: VideoSource
  discovery: Array<'popular' | 'trending'>
  view?: CardListView
}) {
  if (!discovery.length) return null
  return <>{discovery.map((feed) => <DiscoveryShelf key={feed} source={source} feed={feed} view={view} />)}</>
}
