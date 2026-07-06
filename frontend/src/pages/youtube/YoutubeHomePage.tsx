import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Rss } from 'lucide-react'
import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SOURCE_META } from '@/lib/videos/sources'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { SkeletonCards } from '@/components/shared/SkeletonBlocks'
import { ChannelAvatar } from '@/components/youtube/media'
import { getHistory, getRecommended, search as ytSearch, ytPopularQueryOptions, ytTrendingQueryOptions } from '@/lib/youtube/api'
import { useYtFeed, useYtSubs, useYtDownloads, buildChannels } from '@/lib/youtube/useData'
import { isShort, savedToItem, historyToItem, itToItem, searchToItem, channelKey, type VideoItem } from '@/lib/youtube/types'
import { qualityBadge } from '@/lib/youtube/format'
import { MediaShelf, ChannelRail, ShelfSkeleton, type ChannelEntry } from '@/components/youtube/shelves'

import { VideoCollection } from '@/components/youtube/VideoCollection'
import { SearchResults } from '@/components/youtube/SearchResults'
import { ViewToggle, type CardListView } from '@/components/shared/ViewToggle'
import { useViewPreference } from '@/hooks/useViewPreference'
import { useYoutubeMode } from '@/components/videos/VideosLayout'

type Filter = 'all' | 'videos' | 'shorts' | 'channels'
const FILTERS: [Filter, string][] = [['all', 'All'], ['videos', 'Videos'], ['shorts', 'Shorts'], ['channels', 'Channels']]
// Topic chips (real-YouTube style): selecting one swaps the feed for a live search on that
// topic. They need a live query, so they only appear in online mode.
const TOPICS = ['Podcasts', 'Music', 'News', 'Gaming', 'Trailers', 'Live', 'Comedy', 'Cooking', 'Sports', 'Technology', 'Science', 'Documentary']

// Round-robin a recency-sorted list across its channels so a single frequent uploader
// doesn't bury everyone else; "Latest" then leads with each channel's newest in turn.
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
  // A selected topic overrides the type filter and shows a live topic feed instead.
  const [topic, setTopic] = useState<string | null>(null)
  // Card vs list view for Home's video grids, persisted per-user (independent of other sections).
  const [view, setView] = useViewPreference('youtube.home_view', 'grid')

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

  // Offline mirrors online exactly: same layout, sourced from the saved library.
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
  // Balanced "Latest": newest from each channel in turn, not one uploader's backlog.
  const latest = useMemo(() => interleaveByChannel(regular).slice(0, 16), [regular])
  const popularItems = useMemo(() => popular.map(itToItem), [popular])
  const trendingItems = useMemo(() => trending.map(itToItem), [trending])
  const channels = useMemo(() => (online ? buildChannels(subs, videos) : channelsFromItems(offlineItems)), [online, subs, videos, offlineItems])

  if (online && loading) return <Loading />

  return (
    <PageContainer width="wide" className="pt-1 pb-6">
      <PageHeader
        title={SOURCE_META.youtube.label}
        icon={SOURCE_META.youtube.icon}
        gradient={SOURCE_META.youtube.gradient}
        eyebrow="Videos"
        subtitle={online ? 'Your subscriptions, recommendations & trending.' : 'Your saved YouTube library.'}
        className="pt-4 pb-4"
      />
      <div className="mb-6 flex items-center gap-3">
        <ChipRow className="mb-0 min-w-0 flex-1">
          {FILTERS.map(([k, label]) => <Chip key={k} label={label} active={!topic && filter === k} onClick={() => { setTopic(null); setFilter(k) }} />)}
          {online && (
            <>
              <span className="mx-1 shrink-0 self-center h-5 w-px bg-border/70" aria-hidden />
              {TOPICS.map(t => <Chip key={t} label={t} active={topic === t} onClick={() => setTopic(topic === t ? null : t)} />)}
            </>
          )}
        </ChipRow>
        {filter !== 'channels' && <ViewToggle value={view} onChange={setView} className="shrink-0" />}
      </div>

      {topic ? (
        <TopicFeed topic={topic} view={view} />
      ) : filter === 'channels' ? (
        <ChannelGrid channels={channels} />
      ) : filter === 'videos' ? (
        <VideoGrid items={regular} view={view} />
      ) : filter === 'shorts' ? (
        <ShortsGrid items={shorts} view={view} />
      ) : (
        <div className="space-y-10">
          {online && (popularItems.length > 0 ? <MediaShelf title="🔥 Popular" items={popularItems} view={view} /> : popularLoading ? <ShelfSkeleton /> : null)}
          {online && (trendingItems.length > 0 ? <MediaShelf title="📈 Trending" items={trendingItems} view={view} /> : trendingLoading ? <ShelfSkeleton /> : null)}
          {continueWatching.length > 0 ? <MediaShelf title="Continue watching" items={continueWatching} view={view} /> : (online && historyLoading) ? <ShelfSkeleton /> : null}
          {channels.length > 0 && <ChannelRail channels={channels} />}
          {recommendedItems.length > 0 ? <MediaShelf title="Recommended for you" items={recommendedItems} view={view} /> : (online && recommendedLoading) ? <ShelfSkeleton /> : null}
          {shorts.length > 0 && <MediaShelf title="Shorts" items={shorts.slice(0, 12)} aspect="short" view={view} />}
          {regular.length > 0 ? (
            <section>
              <SectionHeader title="Latest from your subscriptions" className="mb-4" />
              <VideoCollection items={latest} view={view} />
            </section>
          ) : (recommendedItems.length === 0 && popularItems.length === 0 && trendingItems.length === 0) ? <EmptyState online={online} /> : null}
        </div>
      )}
    </PageContainer>
  )
}

function Loading() {
  return (
    <PageContainer width="wide" className="space-y-10 py-6">
      <ShelfSkeleton />
      <ShelfSkeleton />
    </PageContainer>
  )
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

function VideoGrid({ items, view }: { items: VideoItem[]; view: CardListView }) {
  if (!items.length) return <p className="py-20 text-center text-sm text-muted-foreground">Nothing here yet.</p>
  return <VideoCollection items={items} view={view} />
}

// Live topic feed: a video search on the picked topic, rendered as the standard card grid.
function TopicFeed({ topic, view }: { topic: string; view: CardListView }) {
  const { data, isLoading } = useQuery({
    queryKey: ['yt-topic', topic],
    queryFn: () => ytSearch(topic, null, 'videos'),
  })
  const items = useMemo(() => (data?.results ?? []).map(searchToItem), [data])
  if (isLoading) return <SkeletonCards count={12} className="xl:grid-cols-4" />
  if (!items.length) return <p className="py-20 text-center text-sm text-muted-foreground">Nothing found for “{topic}”.</p>
  return <VideoCollection items={items} view={view} />
}

function ShortsGrid({ items, view }: { items: VideoItem[]; view: CardListView }) {
  if (!items.length) return <p className="py-20 text-center text-sm text-muted-foreground">No Shorts yet.</p>
  return <VideoCollection items={items} view={view} aspect="short" />
}

function ChannelGrid({ channels }: { channels: ChannelEntry[] }) {
  if (!channels.length) return <p className="py-20 text-center text-sm text-muted-foreground">No channels yet.</p>
  return (
    <div className="grid grid-cols-3 gap-6 sm:grid-cols-4 xl:grid-cols-6">
      {channels.map(c => (
        <Link key={c.id} to={`/videos/youtube/channel/${encodeURIComponent(c.id)}`} className="group flex flex-col items-center gap-2 text-center">
          <ChannelAvatar title={c.title} src={c.thumbnailUrl} className="size-24 text-3xl ring-1 ring-border/40 transition group-hover:ring-2 group-hover:ring-[var(--yt-accent)]" />
          <p className="line-clamp-2 text-sm font-semibold">{c.title}</p>
        </Link>
      ))}
    </div>
  )
}
