import { useMemo } from 'react'
import { Settings2, Loader2 } from 'lucide-react'
import { useYtFeed, useYtSubs, useYtDownloads } from '@/lib/youtube/useData'
import { isShort, savedToItem, channelKey, type VideoItem } from '@/lib/youtube/types'
import { qualityBadge } from '@/lib/youtube/format'
import { MediaShelf, ChannelRail, type ChannelEntry } from '@/components/youtube/shelves'
import { VideoCard } from '@/components/youtube/VideoCard'
import { useYoutubeMode, useYoutubeUI } from '@/components/youtube/YoutubeLayout'

const GRID = 'grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-4'

// Round-robin a recency-sorted list across its channels so one frequent uploader
// doesn't bury everyone else — "Latest" leads with each channel's newest in turn.
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

  // Offline mirrors online — same feed shape, sourced from the saved library.
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
    <div className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Subscriptions</h1>
          <p className="text-sm text-muted-foreground">
            {subs.length} {subs.length === 1 ? 'channel' : 'channels'} you follow
          </p>
        </div>
        <button onClick={openManage}
          className="flex shrink-0 items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
          <Settings2 className="size-4" /> Manage
        </button>
      </div>

      {channels.length > 0 && <div className="mb-8"><ChannelRail title="Channels" channels={channels} /></div>}

      {online && loading ? (
        <div className="flex justify-center py-20"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
      ) : latest.length === 0 && shorts.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 bg-card/40 p-10 text-center text-sm text-muted-foreground">
          {subs.length === 0 ? (
            <>You haven't added any channels yet.{' '}
              <button onClick={openManage} className="font-semibold text-[var(--yt-accent-fg)] hover:underline">Add some</button>
              {' '}to build your feed.</>
          ) : 'No recent uploads from your subscriptions.'}
        </div>
      ) : (
        <div className="space-y-10">
          {shorts.length > 0 && <MediaShelf title="Shorts" items={shorts} aspect="short" />}
          <section>
            <h2 className="mb-4 text-lg font-bold tracking-tight">Latest</h2>
            <div className={GRID}>
              {latest.map(i => <VideoCard key={i.videoId + (i.localKind ?? '')} item={i} />)}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
