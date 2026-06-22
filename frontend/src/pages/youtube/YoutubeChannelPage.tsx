import { useEffect, useMemo, useState } from 'react'
import { useParams, useLocation } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { useYtSubs } from '@/lib/youtube/useData'
import { addSubscription, deleteSubscription, getChannelPage, type ItVideo } from '@/lib/youtube/api'
import { isShort, itToItem, type VideoItem } from '@/lib/youtube/types'
import { ChannelAvatar } from '@/components/youtube/media'
import { VideoCard } from '@/components/youtube/VideoCard'
import { PodcastSourceButtons } from '@/components/youtube/PodcastSourceButtons'
import { useUnsubscribeConfirm } from '@/components/youtube/UnsubscribeDialog'
import { MediaShelf } from '@/components/youtube/shelves'

const GRID = 'grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-4'

export function YoutubeChannelPage() {
  const { id = '' } = useParams()
  const channelId = decodeURIComponent(id)
  const qc = useQueryClient()
  const { data: subs = [] } = useYtSubs()
  const [busy, setBusy] = useState(false)

  // Full catalogue from InnerTube (paged), not just whatever the RSS poller cached.
  const { data: firstPage, isLoading } = useQuery({
    queryKey: ['yt-channel', channelId],
    queryFn: () => getChannelPage(channelId),
    enabled: !!channelId,
  })

  // Accumulate paged results behind a "Load more" button.
  const [extra, setExtra] = useState<ItVideo[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  useEffect(() => { setExtra([]); setCursor(firstPage?.continuation ?? null) }, [firstPage])

  async function loadMore() {
    if (!cursor) return
    setLoadingMore(true)
    try {
      const page = await getChannelPage(channelId, cursor)
      setExtra(prev => [...prev, ...page.videos])
      setCursor(page.continuation)
    } catch { toast.error('Could not load more') } finally { setLoadingMore(false) }
  }

  // When arriving from a search/related card the channel isn't subscribed yet, so fall
  // back to name/avatar passed via router state. InnerTube channel meta wins when present.
  const navState = (useLocation().state ?? {}) as { title?: string; thumbnailUrl?: string | null }
  const sub = subs.find(s => s.externalId === channelId)
  const meta = firstPage?.meta
  const title = meta?.title || sub?.title || navState.title || channelId
  const thumb = meta?.thumbnailUrl ?? sub?.thumbnailUrl ?? navState.thumbnailUrl ?? null
  const description = meta?.description ?? sub?.description ?? null
  const subscribers = meta?.subscribers ?? null

  const allItems = useMemo<VideoItem[]>(() => {
    const seen = new Set<string>()
    const out: VideoItem[] = []
    for (const v of [...(firstPage?.videos ?? []), ...extra]) {
      if (seen.has(v.videoId)) continue
      seen.add(v.videoId)
      const item = itToItem(v)
      out.push({ ...item, channelThumb: item.channelThumb ?? thumb })
    }
    return out
  }, [firstPage, extra, thumb])

  const shorts = allItems.filter(isShort)
  const regular = allItems.filter(i => !isShort(i))

  const subscribed = !!sub
  const { ask: askUnsub, dialog: unsubDialog } = useUnsubscribeConfirm()
  async function toggleSub() {
    if (subscribed && sub) {
      askUnsub({
        name: title || 'this channel',
        sourceRef: `channel:${channelId}`,
        kind: 'channel',
        onUnsubscribe: async () => {
          await deleteSubscription(sub.id)
          toast.success('Unsubscribed')
          qc.invalidateQueries({ queryKey: ['yt-subs'] }); qc.invalidateQueries({ queryKey: ['yt-feed'] })
        },
      })
      return
    }
    setBusy(true)
    try {
      const d = await addSubscription(`https://www.youtube.com/channel/${channelId}`)
      if (d.error) { toast.error(d.error); return }
      toast.success('Subscribed')
      qc.invalidateQueries({ queryKey: ['yt-subs'] }); qc.invalidateQueries({ queryKey: ['yt-feed'] })
    } catch { toast.error('Could not update subscription') } finally { setBusy(false) }
  }

  return (
    <div className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6">
      {unsubDialog}
      <div className="mb-8 flex items-start gap-4">
        <ChannelAvatar title={title} src={thumb} className="size-20 shrink-0 text-3xl ring-1 ring-border/40" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-black tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">
            {subscribers ? subscribers : `${allItems.length} ${allItems.length === 1 ? 'video' : 'videos'}`}
            {(meta?.handle || sub?.handle) ? ` · ${meta?.handle ?? sub?.handle}` : ''}
          </p>
          {description && (
            <p className="mt-1.5 line-clamp-2 max-w-2xl whitespace-pre-line text-xs leading-relaxed text-muted-foreground/80">{description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <PodcastSourceButtons
            videos={regular.map(v => ({ videoId: v.videoId, title: v.title, author: v.author ?? title }))}
            sourceId={`channel:${channelId}`} suggestedShowName={title} sourceDescription={description ?? undefined} coverImageUrl={thumb ?? undefined} />
          <button onClick={toggleSub} disabled={busy}
            className={cn('flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-60',
              subscribed ? 'bg-muted text-muted-foreground hover:bg-destructive/10 hover:text-destructive' : 'bg-[var(--yt-accent)] text-white hover:bg-[var(--yt-accent-hover)]')}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {subscribed ? 'Subscribed' : 'Subscribe'}
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex h-[40vh] items-center justify-center"><Loader2 className="size-7 animate-spin text-muted-foreground" /></div>
      ) : allItems.length === 0 ? (
        <p className="py-24 text-center text-sm text-muted-foreground">No videos found for this channel.</p>
      ) : (
        <div className="space-y-10">
          {shorts.length > 0 && <MediaShelf title="Shorts" items={shorts} aspect="short" />}
          <div className={GRID}>{regular.map(i => <VideoCard key={i.videoId} item={i} />)}</div>
          {cursor && (
            <div className="flex justify-center">
              <button onClick={loadMore} disabled={loadingMore}
                className="flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-semibold transition hover:border-[var(--yt-accent)] disabled:opacity-60">
                {loadingMore && <Loader2 className="size-4 animate-spin" />} Load more
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
