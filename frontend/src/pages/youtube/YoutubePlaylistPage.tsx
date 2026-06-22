import { useState } from 'react'
import { useParams, useLocation, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ListVideo, Loader2, Plus, Check } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { getPlaylist, addSubscription } from '@/lib/youtube/api'
import { itToItem } from '@/lib/youtube/types'
import { thumbUrl } from '@/lib/youtube/format'
import { useYtSubs } from '@/lib/youtube/useData'
import { ChannelAvatar } from '@/components/youtube/media'
import { VideoCard } from '@/components/youtube/VideoCard'
import { PodcastSourceButtons } from '@/components/youtube/PodcastSourceButtons'

const GRID = 'grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-4'

export function YoutubePlaylistPage() {
  const { id = '' } = useParams()
  const playlistId = decodeURIComponent(id)
  const qc = useQueryClient()
  const navState = (useLocation().state ?? {}) as { title?: string }
  const { data: subs = [] } = useYtSubs()
  const [busy, setBusy] = useState(false)

  const { data, isLoading } = useQuery({ queryKey: ['yt-playlist', playlistId], queryFn: () => getPlaylist(playlistId), enabled: !!playlistId })
  const title = data?.title || navState.title || 'Playlist'
  const videos = data?.videos ?? []
  const owner = data?.owner ?? null
  // Playlist video renderers omit per-video channel thumbs. Borrow the owning channel's
  // avatar for videos that are actually the owner's (the common channel-uploads playlist), so
  // those cards show a real logo — but not for guest/other-channel videos in a mixed playlist
  // (those keep their own author's coloured-initial avatar).
  const items = videos.map(v => {
    const it = itToItem(v)
    const byOwner = !it.author || (owner?.name != null && it.author === owner.name)
    return {
      ...it,
      channelThumb: it.channelThumb ?? (byOwner ? owner?.thumbnailUrl ?? null : null),
      author: it.author ?? owner?.name ?? null,
    }
  })

  const subscribed = subs.some(s => s.externalId === playlistId)
  async function subscribe() {
    setBusy(true)
    try {
      const d = await addSubscription(`https://www.youtube.com/playlist?list=${playlistId}`)
      if (d.error) { toast.error(d.error); return }
      toast.success('Added to subscriptions')
      qc.invalidateQueries({ queryKey: ['yt-subs'] }); qc.invalidateQueries({ queryKey: ['yt-feed'] })
    } catch { toast.error('Could not subscribe') } finally { setBusy(false) }
  }

  return (
    <div className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6">
      <div className="mb-8 flex items-start gap-4">
        <div className="flex size-20 shrink-0 items-center justify-center rounded-2xl bg-[var(--yt-accent-soft)] text-[var(--yt-accent-fg)] ring-1 ring-border/40">
          <ListVideo className="size-9" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">Playlist</p>
          <h1 className="truncate text-2xl font-black tracking-tight">{title}</h1>
          {owner?.channelId ? (
            <Link to={`/youtube/channel/${encodeURIComponent(owner.channelId)}`}
              state={{ title: owner.name, thumbnailUrl: owner.thumbnailUrl }}
              className="mt-1 inline-flex items-center gap-2 rounded-full py-0.5 pr-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              <ChannelAvatar title={owner.name ?? 'Channel'} src={owner.thumbnailUrl} className="size-6 text-[10px] ring-1 ring-border/40" />
              <span className="truncate">{owner.name ?? 'View channel'}</span>
            </Link>
          ) : owner?.name ? (
            <p className="mt-1 text-sm text-muted-foreground">{owner.name}</p>
          ) : null}
          <p className="text-sm text-muted-foreground">{videos.length} {videos.length === 1 ? 'video' : 'videos'}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <PodcastSourceButtons
            videos={videos.map(v => ({ videoId: v.videoId, title: v.title ?? undefined, author: v.author ?? undefined }))}
            sourceId={`playlist:${playlistId}`} suggestedShowName={title} sourceDescription={data?.description ?? undefined}
            coverImageUrl={videos[0] ? thumbUrl(videos[0].videoId, 'hq') : undefined} />
          <button onClick={subscribe} disabled={busy || subscribed}
            className={cn('flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-60',
              subscribed ? 'bg-muted text-muted-foreground' : 'bg-[var(--yt-accent)] text-white hover:bg-[var(--yt-accent-hover)]')}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : subscribed ? <Check className="size-4" /> : <Plus className="size-4" />}
            {subscribed ? 'Following' : 'Follow playlist'}
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex h-[40vh] items-center justify-center"><Loader2 className="size-7 animate-spin text-muted-foreground" /></div>
      ) : videos.length === 0 ? (
        <p className="py-24 text-center text-sm text-muted-foreground">This playlist has no videos, or it couldn’t be loaded.</p>
      ) : (
        <div className={GRID}>{items.map(i => <VideoCard key={i.videoId} item={i} />)}</div>
      )}
    </div>
  )
}
