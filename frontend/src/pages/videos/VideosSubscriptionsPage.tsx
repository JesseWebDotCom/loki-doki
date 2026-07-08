import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Settings2, GalleryHorizontal, Table2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { SkeletonCards } from '@/components/shared/SkeletonBlocks'
import { ViewToggle } from '@/components/shared/ViewToggle'
import { useViewPreference } from '@/hooks/useViewPreference'
import { HScroll } from '@/components/youtube/shelves'
import { YT_GRID, YT_SHORTS_GRID } from '@/components/youtube/VideoCollection'
import { HubCard, HubRow, ytItemToHub } from '@/components/videos/HubCard'
import { CreatorAvatar } from '@/components/videos/CreatorAvatar'
import { HUB_PATHS } from '@/components/videos/HubVideoCard'
import { useYtSubs, useYtFeed } from '@/lib/youtube/useData'
import { getChannelAbout } from '@/lib/youtube/api'
import { listFollows, getFollowingFeed, getSourceCreator, type HubVideoItem, type VideoSource } from '@/lib/videos/api'
import { SOURCE_META } from '@/lib/videos/sources'

interface UnifiedChannel {
  id: string
  source: VideoSource
  externalId: string
  title: string
  handle: string | null
  thumbnailUrl: string | null
  description: string | null
}

type ChannelsView = 'row' | 'table'

/** The unified Subscriptions page: a merged, recency-sorted feed from every followed
 *  source (YouTube + Reddit/TikTok/Vimeo), plus a Channels directory with a row⇄table
 *  toggle. Unlike YoutubeSubscriptionsPage (YouTube-only), this is what the rail's
 *  "Subscriptions" section and "Show all" link actually point at. */
export function VideosSubscriptionsPage() {
  const [view, setView] = useViewPreference('videos.subscriptions_view', 'grid')
  const { data: subs = [], isLoading: subsLoading } = useYtSubs()
  const { items: ytItems, loading: ytLoading } = useYtFeed()
  const { data: followsData, isLoading: followsLoading } = useQuery({ queryKey: ['videos-follows'], queryFn: listFollows, staleTime: 5 * 60_000 })
  const follows = followsData?.follows ?? []
  const { data: genFeedData, isLoading: genFeedLoading } = useQuery({ queryKey: ['videos-following-feed'], queryFn: () => getFollowingFeed(), staleTime: 60_000 })
  const genItems = genFeedData?.items ?? []

  const feedItems = useMemo<HubVideoItem[]>(() => {
    const items = [...ytItems.map(ytItemToHub), ...genItems]
    return items.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
  }, [ytItems, genItems])

  const channels = useMemo<UnifiedChannel[]>(() => {
    const yt: UnifiedChannel[] = subs.map((s) => ({
      id: `youtube:${s.id}`, source: 'youtube', externalId: s.externalId, title: s.title,
      handle: s.handle, thumbnailUrl: s.thumbnailUrl, description: s.description,
    }))
    const gen: UnifiedChannel[] = follows.map((f) => ({
      id: `${f.source}:${f.id}`, source: f.source, externalId: f.externalId, title: f.title,
      handle: f.handle ?? null, thumbnailUrl: f.thumbnailUrl ?? null, description: f.description ?? null,
    }))
    return [...yt, ...gen].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
  }, [subs, follows])

  const [channelsView, setChannelsView] = useState<ChannelsView>(
    () => (typeof localStorage !== 'undefined' && localStorage.getItem('videos.channelsView') === 'table' ? 'table' : 'row'))
  const changeChannelsView = (v: ChannelsView) => {
    setChannelsView(v)
    try { localStorage.setItem('videos.channelsView', v) } catch { /* private mode */ }
  }

  const loading = subsLoading || ytLoading || followsLoading || genFeedLoading
  const sourceCount = new Set(channels.map((c) => c.source)).size

  return (
    <PageContainer width="wide" className="pb-6">
      <PageHeader title="Subscriptions"
        subtitle={channels.length > 0 ? `${channels.length} ${channels.length === 1 ? 'channel' : 'channels'} across ${sourceCount} ${sourceCount === 1 ? 'source' : 'sources'}` : undefined}
        className="pt-6 pb-5"
        actions={
          <Button asChild variant="outline" className="shrink-0 gap-2 text-muted-foreground hover:text-foreground">
            <Link to="/videos/settings/channels"><Settings2 className="size-4" /> Manage</Link>
          </Button>
        } />

      {channels.length > 0 && (
        <section className="mb-8">
          <div className="mb-4 flex items-center justify-between gap-3">
            <SectionHeader title="Channels" className="mb-0" />
            <div className="flex gap-0.5 rounded-full border border-border p-0.5">
              <Button variant="ghost" size="icon-sm" onClick={() => changeChannelsView('row')} aria-pressed={channelsView === 'row'} aria-label="Row view"
                className={cn(channelsView === 'row' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                <GalleryHorizontal className="size-4" />
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={() => changeChannelsView('table')} aria-pressed={channelsView === 'table'} aria-label="Table view"
                className={cn(channelsView === 'table' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                <Table2 className="size-4" />
              </Button>
            </div>
          </div>
          {channelsView === 'row' ? <ChannelsRow channels={channels} /> : <ChannelsTable channels={channels} />}
        </section>
      )}

      {loading ? (
        <SkeletonCards count={8} className="xl:grid-cols-4" />
      ) : feedItems.length === 0 ? (
        <Card variant="dashed" className="p-10 text-center text-sm text-muted-foreground">
          {channels.length === 0 ? (
            <>You haven't subscribed to any channels yet.{' '}
              <Link to="/videos/settings/channels" className="font-semibold text-[var(--yt-accent-fg)] hover:underline">Add some</Link>
              {' '}to build your feed.</>
          ) : 'No recent uploads from your subscriptions.'}
        </Card>
      ) : (
        <section>
          <div className="mb-4 flex items-center justify-between gap-3">
            <SectionHeader title="Latest" className="mb-0" />
            <ViewToggle value={view} onChange={setView} className="shrink-0" />
          </div>
          <div className={view === 'list' ? 'space-y-1' : view === 'big' ? YT_SHORTS_GRID : YT_GRID}>
            {feedItems.map((it) => (
              view === 'list'
                ? <HubRow key={`${it.source}:${it.id}`} item={it} />
                : <HubCard key={`${it.source}:${it.id}`} item={it} shape={view === 'big' ? 'tall' : 'wide'} />
            ))}
          </div>
        </section>
      )}
    </PageContainer>
  )
}

function ChannelsRow({ channels }: { channels: UnifiedChannel[] }) {
  return (
    <HScroll>
      {channels.map((c) => (
        <Link key={c.id} to={HUB_PATHS[c.source].creator(c.externalId)}
          className="group flex w-28 shrink-0 flex-col items-center gap-2 text-center">
          <span className="relative">
            <CreatorAvatar title={c.title} src={c.thumbnailUrl}
              className="size-20 text-2xl ring-1 ring-border/40 transition group-hover:ring-2 group-hover:ring-[var(--yt-accent)]" />
            <span className={cn('absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full ring-2 ring-background', SOURCE_META[c.source].dotClass)} />
          </span>
          <p className="line-clamp-1 w-full text-sm font-semibold">{c.title}</p>
        </Link>
      ))}
    </HScroll>
  )
}

function ChannelsTable({ channels }: { channels: UnifiedChannel[] }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border/50">
            <th className="py-2.5 pl-4 pr-3 font-medium">Channel</th>
            <th className="py-2.5 pr-3 font-medium">Platform</th>
            <th className="py-2.5 pr-3 font-medium">Description</th>
            <th className="py-2.5 pr-4 text-right font-medium">Videos</th>
          </tr>
        </thead>
        <tbody>
          {channels.map((c) => <ChannelRow key={c.id} channel={c} />)}
        </tbody>
      </table>
    </Card>
  )
}

/** One table row. The follow/subscription row (`channel`) only carries a name+bio snapshot
 *  taken once, at follow time: for TikTok especially that first fetch is best-effort and
 *  commonly falls back to a bare `@handle` with no bio, and it's never backfilled after (see
 *  lib/videos/feed.ts's pollFollow, which only backfills a missing avatar). So name/description/
 *  count here all prefer the same live per-channel fetch each channel's own page already makes
 *  (YouTube's About panel / the generic creator page) over that stale snapshot, falling back to
 *  it only while the live fetch is loading or if it errors. Only mounted in table mode, so
 *  switching views is what triggers the fetch; the query is cache-shared with those pages. */
function ChannelRow({ channel: c }: { channel: UnifiedChannel }) {
  const badge = SOURCE_META[c.source]
  const yt = useQuery({
    queryKey: ['yt-channel-about', c.externalId],
    queryFn: () => getChannelAbout(c.externalId),
    enabled: c.source === 'youtube',
    staleTime: 5 * 60_000,
  })
  const generic = useQuery({
    queryKey: ['source-creator', c.source, c.externalId],
    queryFn: () => getSourceCreator(c.source, c.externalId),
    enabled: c.source !== 'youtube',
    staleTime: 5 * 60_000,
  })
  const loading = c.source === 'youtube' ? yt.isLoading : generic.isLoading
  const liveCreator = generic.data?.creator
  const title = liveCreator?.name || c.title
  const handle = liveCreator?.handle ?? c.handle
  const description = (c.source === 'youtube' ? yt.data?.description : liveCreator?.description) ?? c.description
  const videoCount = c.source === 'youtube' ? yt.data?.videoCount : liveCreator?.videoCount

  return (
    <tr className="border-b border-border/30 last:border-0 hover:bg-accent/30">
      <td className="py-2.5 pl-4 pr-3">
        <Link to={HUB_PATHS[c.source].creator(c.externalId)} className="flex min-w-0 items-center gap-2.5">
          <CreatorAvatar title={title} src={c.thumbnailUrl} className="size-8 shrink-0 text-xs ring-1 ring-border/40" />
          <span className="min-w-0">
            <span className="block truncate font-semibold text-foreground">{title}</span>
            {handle && <span className="block truncate text-xs text-muted-foreground">{handle}</span>}
          </span>
        </Link>
      </td>
      <td className="py-2.5 pr-3">
        <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold', badge.badgeClass)}>
          <badge.icon className="size-2.5" aria-hidden /> {badge.label}
        </span>
      </td>
      <td className="max-w-80 truncate py-2.5 pr-3 text-muted-foreground">{description || '-'}</td>
      <td className="py-2.5 pr-4 text-right tabular-nums text-muted-foreground">
        {loading ? <span className="opacity-50">...</span> : (videoCount ?? '-')}
      </td>
    </tr>
  )
}
