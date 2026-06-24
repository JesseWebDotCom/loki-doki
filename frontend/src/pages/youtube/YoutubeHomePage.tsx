import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Rss, Loader2 } from 'lucide-react'
import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { ChannelAvatar } from '@/components/youtube/media'
import { getHistory, getRecommended, ytPopularQueryOptions, ytTrendingQueryOptions } from '@/lib/youtube/api'
import { useYtFeed, useYtSubs, useYtDownloads, buildChannels } from '@/lib/youtube/useData'
import { isShort, savedToItem, historyToItem, itToItem, channelKey, type VideoItem } from '@/lib/youtube/types'
import { qualityBadge } from '@/lib/youtube/format'
import { MediaShelf, ChannelRail, ShelfSkeleton, type ChannelEntry } from '@/components/youtube/shelves'
import { VideoCard } from '@/components/youtube/VideoCard'
import { SearchResults } from '@/components/youtube/SearchResults'
import { useYoutubeMode } from '@/components/youtube/YoutubeLayout'

type Filter = 'all' | 'videos' | 'shorts' | 'channels'
const GRID = 'grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-4'
const SHORTS_GRID = 'grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-4 xl:grid-cols-6'
const FILTERS: [Filter, string][] = [['all', 'All'], ['videos', 'Videos'], ['shorts', 'Shorts'], ['channels', 'Channels']]

// Round-robin a recency-sorted list across its channels so a single frequent uploader
// doesn't bury everyone else — "Latest" then leads with each channel's newest in turn.
function interleaveByChannel(items: VideoItem[]): VideoItem[] {
  const groups = new Map<string, VideoItem[]>()
  for (const i of items) {
    const k = i.channelId ?? channelKey(i.author)
    ;(groups.get(k) ?? groups.set(k, []).get(k)!).push(i)
  }
  const lists = [...groups.values()]
  const out: VideoItem[] = []
  for (let round = 0; out.length < items.length; round++) {
    let any = false
    for (const list of lists) if (round < list.length) { out.push(list[round]!); any = true }
    if (!any) break
  }
  return out
}

function channelsFromItems(items: VideoItem[]): ChannelEntry[] {
  const m = new Map<string, ChannelEntry>()
  for (const i of items) {
    const k = channelKey(i.author)
    if (!m.has(k)) m.set(k, { id: i.channelId ?? k, title: i.author || k, thumbnailUrl: i.channelThumb ?? null })
  }
  return [...m.values()].sort((a, b) => a.title.localeCompare(b.title))
}

// The YouTube app's landing. Doubles as the search-results view when there's a `?q=`
// (Discover was merged into Home), and otherwise shows your feed blended with discovery
// shelves (Recommended + Popular) so there's always something new to watch.
export function YoutubeHomePage() {
  const [params] = useSearchParams()
  const q = (params.get('q') ?? '').trim()
  if (q) return <SearchResults q={q} />
  return <HomeLanding />
}

function HomeLanding() {
  const mode = useYoutubeMode()
  const online = mode === 'online'
  const [filter, setFilter] = useState<Filter>('all')

  const { videos, items: feedItems, loading } = useYtFeed()
  const { data: subs = [] } = useYtSubs()
  const { data: downloads = [] } = useYtDownloads()
  // Personalized rows (online only): real cross-video history + recommendations.
  const { data: history = [], isLoading: historyLoading } = useQuery({ queryKey: ['yt-history'], queryFn: getHistory, enabled: online })
  const { data: recommended = [], isLoading: recommendedLoading } = useQuery({ queryKey: ['yt-recommended'], queryFn: getRecommended, enabled: online })
  // Discovery beyond your subscriptions. Popular = most-watched (reliable); Trending =
  // YouTube's trending tab (thinner, may be empty → shelf hides). Both privacy-front-end backed.
  const { data: popular = [], isLoading: popularLoading } = useQuery({ ...ytPopularQueryOptions(), enabled: online })
  const { data: trending = [], isLoading: trendingLoading } = useQuery({ ...ytTrendingQueryOptions(), enabled: online })

  // Offline mirrors online exactly — same layout, sourced from the saved library.
  const offlineItems: VideoItem[] = useMemo(
    () => downloads.filter(r => r.status === 'ready').map(r => savedToItem(r, qualityBadge(r.kind, r.maxHeight))),
    [downloads],
  )

  const baseItems = online ? feedItems : offlineItems
  const regular = useMemo(() => baseItems.filter(i => !isShort(i)), [baseItems])
  const shorts = useMemo(() => baseItems.filter(isShort), [baseItems])
  const continueWatching = useMemo(() => (
    online
      ? history.filter(h => !h.completed && h.positionSec > 5).map(historyToItem)
      : offlineItems.filter(i => i.watch && !i.watch.completed && i.watch.positionSec > 5)
  ), [online, history, offlineItems])
  const recommendedItems = useMemo(() => (online ? recommended.map(itToItem) : regular.slice(0, 12)), [online, recommended, regular])
  // Balanced "Latest" — newest from each channel in turn, not one uploader's backlog.
  const latest = useMemo(() => interleaveByChannel(regular).slice(0, 16), [regular])
  const popularItems = useMemo(() => popular.map(itToItem), [popular])
  const trendingItems = useMemo(() => trending.map(itToItem), [trending])
  const channels = useMemo(() => (online ? buildChannels(subs, videos) : channelsFromItems(offlineItems)), [online, subs, videos, offlineItems])

  if (online && loading) return <Loading />

  return (
    <div className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6">
      <ChipRow className="mb-6">
        {FILTERS.map(([k, label]) => <Chip key={k} label={label} active={filter === k} onClick={() => setFilter(k)} />)}
      </ChipRow>

      {filter === 'channels' ? (
        <ChannelGrid channels={channels} />
      ) : filter === 'videos' ? (
        <VideoGrid items={regular} />
      ) : filter === 'shorts' ? (
        <ShortsGrid items={shorts} />
      ) : (
        <div className="space-y-10">
          {online && (popularItems.length > 0 ? <MediaShelf title="🔥 Popular" items={popularItems} /> : popularLoading ? <ShelfSkeleton /> : null)}
          {online && (trendingItems.length > 0 ? <MediaShelf title="📈 Trending" items={trendingItems} /> : trendingLoading ? <ShelfSkeleton /> : null)}
          {continueWatching.length > 0 ? <MediaShelf title="Continue watching" items={continueWatching} /> : (online && historyLoading) ? <ShelfSkeleton /> : null}
          {channels.length > 0 && <ChannelRail channels={channels} />}
          {recommendedItems.length > 0 ? <MediaShelf title="Recommended for you" items={recommendedItems} /> : (online && recommendedLoading) ? <ShelfSkeleton /> : null}
          {shorts.length > 0 && <MediaShelf title="Shorts" items={shorts.slice(0, 12)} aspect="short" />}
          {regular.length > 0 ? (
            <section>
              <h2 className="mb-3 text-lg font-bold tracking-tight">Latest from your subscriptions</h2>
              <div className={GRID}>{latest.map(i => <VideoCard key={i.videoId + (i.localKind ?? '')} item={i} />)}</div>
            </section>
          ) : (recommendedItems.length === 0 && popularItems.length === 0 && trendingItems.length === 0) ? <EmptyState online={online} /> : null}
        </div>
      )}
    </div>
  )
}

function Loading() {
  return <div className="flex h-[60vh] items-center justify-center"><Loader2 className="size-7 animate-spin text-muted-foreground" /></div>
}

function EmptyState({ online }: { online: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
      <Rss className="mb-3 size-10 opacity-30" />
      <p className="text-sm font-medium">Nothing here yet</p>
      <p className="mt-1 text-xs">{online ? 'Add subscriptions with “Manage channels”, or search above.' : 'Save a video for offline and it’ll appear here.'}</p>
    </div>
  )
}

function VideoGrid({ items }: { items: VideoItem[] }) {
  if (!items.length) return <p className="py-20 text-center text-sm text-muted-foreground">Nothing here yet.</p>
  return <div className={GRID}>{items.map(i => <VideoCard key={i.videoId + (i.localKind ?? '')} item={i} />)}</div>
}

function ShortsGrid({ items }: { items: VideoItem[] }) {
  if (!items.length) return <p className="py-20 text-center text-sm text-muted-foreground">No Shorts yet.</p>
  return <div className={SHORTS_GRID}>{items.map(i => <VideoCard key={i.videoId + (i.localKind ?? '')} item={i} aspect="short" />)}</div>
}

function ChannelGrid({ channels }: { channels: ChannelEntry[] }) {
  if (!channels.length) return <p className="py-20 text-center text-sm text-muted-foreground">No channels yet.</p>
  return (
    <div className="grid grid-cols-3 gap-6 sm:grid-cols-4 xl:grid-cols-6">
      {channels.map(c => (
        <Link key={c.id} to={`/youtube/channel/${encodeURIComponent(c.id)}`} className="group flex flex-col items-center gap-2 text-center">
          <ChannelAvatar title={c.title} src={c.thumbnailUrl} className="size-24 text-3xl ring-1 ring-border/40 transition group-hover:ring-2 group-hover:ring-[var(--yt-accent)]" />
          <p className="line-clamp-2 text-sm font-semibold">{c.title}</p>
        </Link>
      ))}
    </div>
  )
}
