import { useMemo } from 'react'
import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { SkeletonCards } from '@/components/shared/SkeletonBlocks'
import { useYtFeed, useYtSubs, useYtDownloads } from '@/lib/youtube/useData'
import { isShort, savedToItem, channelKey, type VideoItem } from '@/lib/youtube/types'
import { qualityBadge } from '@/lib/youtube/format'
import { MediaShelf, ChannelRail, type ChannelEntry } from '@/components/youtube/shelves'
import { VideoCard } from '@/components/youtube/VideoCard'
import { useYoutubeMode, useYoutubeUI } from '@/components/youtube/YoutubeLayout'

const GRID = 'grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-4'

// Round-robin a recency-sorted list across its channels so one frequent uploader
// doesn't bury everyone else; "Latest" leads with each channel's newest in turn.
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

/** The subscription feed: latest uploads from every channel you follow, YouTube-style. */
export function YoutubeSubscriptionsPage() {
  const online = useYoutubeMode() === 'online'
  const { openManage } = useYoutubeUI()
  const { items: feedItems, loading } = useYtFeed()
  const { data: subs = [] } = useYtSubs()
  const { data: downloads = [] } = useYtDownloads()

  // Offline mirrors online: same feed shape, sourced from the saved library.
  const offlineItems = useMemo(
    () => downloads.filter(r => r.status === 'ready').map(r => savedToItem(r, qualityBadge(r.kind, r.maxHeight))),
    [downloads],
  )
  const base = online ? feedItems : offlineItems
  const regular = useMemo(() => base.filter(i => !isShort(i)), [base])
  const shorts = useMemo(() => base.filter(isShort), [base])
  const latest = useMemo(() => interleaveByChannel(regular), [regular])
  const channels: ChannelEntry[] = useMemo(
    () => subs.map(s => ({ id: s.externalId, title: s.title, thumbnailUrl: s.thumbnailUrl })),
    [subs],
  )

  return (
    <PageContainer width="wide" className="pb-6">
      <PageHeader title="Subscriptions"
        subtitle={`${subs.length} ${subs.length === 1 ? 'channel' : 'channels'} you follow`}
        className="pt-6 pb-5"
        actions={
          <Button variant="outline" onClick={openManage} className="shrink-0 gap-2 text-muted-foreground hover:text-foreground">
            <Settings2 className="size-4" /> Manage
          </Button>
        } />

      {channels.length > 0 && <div className="mb-8"><ChannelRail title="Channels" channels={channels} /></div>}

      {online && loading ? (
        <SkeletonCards count={8} className="xl:grid-cols-4" />
      ) : latest.length === 0 && shorts.length === 0 ? (
        <Card variant="dashed" className="p-10 text-center text-sm text-muted-foreground">
          {subs.length === 0 ? (
            <>You haven't added any channels yet.{' '}
              <button onClick={openManage} className="font-semibold text-[var(--yt-accent-fg)] hover:underline">Add some</button>
              {' '}to build your feed.</>
          ) : 'No recent uploads from your subscriptions.'}
        </Card>
      ) : (
        <div className="space-y-10">
          {shorts.length > 0 && <MediaShelf title="Shorts" items={shorts} aspect="short" />}
          <section>
            <SectionHeader title="Latest" className="mb-4" />
            <div className={GRID}>
              {latest.map(i => <VideoCard key={i.videoId + (i.localKind ?? '')} item={i} />)}
            </div>
          </section>
        </div>
      )}
    </PageContainer>
  )
}
