import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { SkeletonCards } from '@/components/shared/SkeletonBlocks'
import { useYtFeed, useYtSubs, useYtDownloads } from '@/lib/youtube/useData'
import { isShort, savedToItem, channelKey, type VideoItem } from '@/lib/youtube/types'
import { qualityBadge } from '@/lib/youtube/format'
import { MediaShelf, ChannelRail, type ChannelEntry } from '@/components/youtube/shelves'
import { VideoCollection } from '@/components/youtube/VideoCollection'
import { ViewToggle } from '@/components/shared/ViewToggle'
import { useViewPreference } from '@/hooks/useViewPreference'
import { useYoutubeMode } from '@/components/youtube/YoutubeLayout'

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
  const [view, setView] = useViewPreference('youtube.subscriptions_view', 'grid')
  const { items: feedItems, loading } = useYtFeed()
  const { data: subs = [] } = useYtSubs()
  const { data: downloads = [] } = useYtDownloads()

  // Offline mirrors online: same feed shape, sourced from the saved library.
  const offlineItems = useMemo(
    () => downloads.filter(r => r.status === 'ready').map(r => savedToItem(r, qualityBadge(r.kind, r.maxHeight))),
    [downloads],
  )
  // Optional channel filter: null = every subscription, otherwise a single channel's uploads.
  const [chan, setChan] = useState<string | null>(null)
  const keyOf = (i: VideoItem) => i.channelId ?? channelKey(i.author)

  const base = online ? feedItems : offlineItems
  const scoped = useMemo(() => (chan ? base.filter(i => keyOf(i) === chan) : base), [base, chan])
  const regular = useMemo(() => scoped.filter(i => !isShort(i)), [scoped])
  const shorts = useMemo(() => scoped.filter(isShort), [scoped])
  // A single channel's feed reads best purely chronological; the full feed interleaves so
  // one prolific uploader doesn't bury the rest.
  const latest = useMemo(() => (chan ? regular : interleaveByChannel(regular)), [regular, chan])
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
          <Button asChild variant="outline" className="shrink-0 gap-2 text-muted-foreground hover:text-foreground">
            <Link to="/youtube/settings/channels"><Settings2 className="size-4" /> Manage</Link>
          </Button>
        } />

      {channels.length > 0 && <div className="mb-8"><ChannelRail title="Channels" channels={channels} /></div>}

      {channels.length > 1 && (
        <ChipRow className="mb-6">
          <Chip label="All" active={!chan} onClick={() => setChan(null)} />
          {channels.map(c => <Chip key={c.id} label={c.title} active={chan === c.id} onClick={() => setChan(chan === c.id ? null : c.id)} />)}
        </ChipRow>
      )}

      {online && loading ? (
        <SkeletonCards count={8} className="xl:grid-cols-4" />
      ) : latest.length === 0 && shorts.length === 0 ? (
        <Card variant="dashed" className="p-10 text-center text-sm text-muted-foreground">
          {subs.length === 0 ? (
            <>You haven't added any channels yet.{' '}
              <Link to="/youtube/settings/channels" className="font-semibold text-[var(--yt-accent-fg)] hover:underline">Add some</Link>
              {' '}to build your feed.</>
          ) : 'No recent uploads from your subscriptions.'}
        </Card>
      ) : (
        <div className="space-y-10">
          {shorts.length > 0 && <MediaShelf title="Shorts" items={shorts} aspect="short" view={view} />}
          <section>
            <div className="mb-4 flex items-center justify-between gap-3">
              <SectionHeader title="Latest" className="mb-0" />
              <ViewToggle value={view} onChange={setView} className="shrink-0" />
            </div>
            <VideoCollection items={latest} view={view} />
          </section>
        </div>
      )}
    </PageContainer>
  )
}
