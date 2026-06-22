import { useEffect, useMemo, useState } from 'react'
import { useParams, useLocation, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, HardDriveDownload, Check, Plus, Link2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { useYtSubs } from '@/lib/youtube/useData'
import {
  addSubscription, deleteSubscription, updateSubscription,
  getChannelPage, getChannelPlaylists, getChannelAbout,
  type ItVideo, type Subscription, type ChannelVideoTab,
} from '@/lib/youtube/api'
import { itToItem, type VideoItem } from '@/lib/youtube/types'
import { ChannelAvatar } from '@/components/youtube/media'
import { VideoCard } from '@/components/youtube/VideoCard'
import { PlaylistCard } from '@/components/youtube/shelves'
import { PodcastSourceButtons } from '@/components/youtube/PodcastSourceButtons'
import { useUnsubscribeConfirm } from '@/components/youtube/UnsubscribeDialog'
import { Switch } from '@/components/ui/switch'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from '@/components/ui/dropdown-menu'

const GRID = 'grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-4'
const SHORTS_GRID = 'grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-6'

type Tab = ChannelVideoTab | 'playlists'
const TABS: [Tab, string][] = [['videos', 'Videos'], ['shorts', 'Shorts'], ['live', 'Live'], ['playlists', 'Playlists']]

/** First page + "Load more" paging for a video-bearing channel tab (Videos/Shorts/Live).
 *  Only fetches when `active` (so opening the page doesn't hit every tab at once). */
function useChannelVideos(channelId: string, tab: ChannelVideoTab, active: boolean) {
  const { data: firstPage, isLoading } = useQuery({
    queryKey: ['yt-channel-tab', channelId, tab],
    queryFn: () => getChannelPage(channelId, null, tab),
    enabled: active && !!channelId,
  })
  const [extra, setExtra] = useState<ItVideo[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  useEffect(() => { setExtra([]); setCursor(firstPage?.continuation ?? null) }, [firstPage])

  async function loadMore() {
    if (!cursor) return
    setLoadingMore(true)
    try {
      const page = await getChannelPage(channelId, cursor, tab)
      setExtra(prev => [...prev, ...page.videos])
      setCursor(page.continuation)
    } catch { toast.error('Could not load more') } finally { setLoadingMore(false) }
  }

  return { firstPage, isLoading, extra, cursor, loadingMore, loadMore }
}

// Merge a tab's first page + paged extras into deduped card view-models. A channel's own
// video/short renderers omit the author + channel avatar, so default both to this channel's
// name/thumbnail — otherwise VideoCard (which hides the avatar when author is empty) shows
// no logo at all on the channel's own grid.
function toItems(firstPage: { videos: ItVideo[] } | undefined, extra: ItVideo[], thumb: string | null, channelName: string): VideoItem[] {
  const seen = new Set<string>()
  const out: VideoItem[] = []
  for (const v of [...(firstPage?.videos ?? []), ...extra]) {
    if (seen.has(v.videoId)) continue
    seen.add(v.videoId)
    const item = itToItem(v)
    out.push({ ...item, channelThumb: item.channelThumb ?? thumb, author: item.author ?? channelName })
  }
  return out
}

function LoadMore({ onClick, loading }: { onClick: () => void; loading: boolean }) {
  return (
    <div className="flex justify-center pt-2">
      <button onClick={onClick} disabled={loading}
        className="flex items-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-semibold transition hover:border-[var(--yt-accent)] disabled:opacity-60">
        {loading && <Loader2 className="size-4 animate-spin" />} Load more
      </button>
    </div>
  )
}

function EmptyTab({ label }: { label: string }) {
  return <p className="py-24 text-center text-sm text-muted-foreground">No {label} found for this channel.</p>
}

export function YoutubeChannelPage() {
  const { id = '' } = useParams()
  const channelId = decodeURIComponent(id)
  const qc = useQueryClient()
  const { data: subs = [] } = useYtSubs()
  const [busy, setBusy] = useState(false)
  const [descOpen, setDescOpen] = useState(false)

  const [params, setParams] = useSearchParams()
  const tab = (TABS.find(([k]) => k === params.get('tab'))?.[0] ?? 'videos') as Tab
  const setTab = (next: Tab) => setParams(prev => {
    const p = new URLSearchParams(prev)
    if (next === 'videos') p.delete('tab'); else p.set('tab', next)
    return p
  }, { replace: true })

  // Videos tab is always fetched: it carries the channel meta (header, available tabs) and
  // seeds the "make a podcast" source, even while another tab is on screen.
  const videos = useChannelVideos(channelId, 'videos', true)

  // When arriving from a search/related card the channel isn't subscribed yet, so fall
  // back to name/avatar passed via router state. InnerTube channel meta wins when present.
  const navState = (useLocation().state ?? {}) as { title?: string; thumbnailUrl?: string | null }
  const sub = subs.find(s => s.externalId === channelId)
  const meta = videos.firstPage?.meta

  // Only show tabs the channel actually publishes — otherwise Live/Playlists/Shorts silently
  // fall back to the channel's Home content. Videos is always shown; until meta loads (or for
  // an old cache without availableTabs) we show all so nothing flickers in late.
  const available = meta?.availableTabs
  const visibleTabs = TABS.filter(([k, label]) => k === 'videos' || !available?.length || available.includes(label))
  // If the URL points at a now-hidden tab, fall back to Videos.
  const activeTab = visibleTabs.some(([k]) => k === tab) ? tab : 'videos'

  // Secondary tabs only fetch when actually open (gated on the resolved active tab).
  const shorts = useChannelVideos(channelId, 'shorts', activeTab === 'shorts')
  const live = useChannelVideos(channelId, 'live', activeTab === 'live')
  const playlistsQuery = useQuery({
    queryKey: ['yt-channel-playlists', channelId],
    queryFn: () => getChannelPlaylists(channelId),
    enabled: activeTab === 'playlists' && !!channelId,
  })
  const aboutQuery = useQuery({
    queryKey: ['yt-channel-about', channelId],
    queryFn: () => getChannelAbout(channelId),
    enabled: !!channelId,
  })

  const about = aboutQuery.data
  const title = meta?.title || sub?.title || navState.title || channelId
  const thumb = meta?.thumbnailUrl ?? sub?.thumbnailUrl ?? navState.thumbnailUrl ?? null
  const bannerUrl = meta?.bannerUrl ?? null
  // Prefer the description that arrives with the videos query (channel metadata) over the
  // one from the slower about query — same text, but using it avoids a re-layout when about
  // resolves a beat later.
  const description = meta?.description ?? about?.description ?? sub?.description ?? null
  const subscribers = about?.subscribers ?? meta?.subscribers ?? null
  const videoCount = about?.videoCount ?? meta?.videoCount ?? null
  const handle = meta?.handle ?? sub?.handle ?? null
  const links = about?.links ?? []

  const videoItems = useMemo(() => toItems(videos.firstPage, videos.extra, thumb, title), [videos.firstPage, videos.extra, thumb, title])
  const shortItems = useMemo(() => toItems(shorts.firstPage, shorts.extra, thumb, title), [shorts.firstPage, shorts.extra, thumb, title])
  const liveItems = useMemo(() => toItems(live.firstPage, live.extra, thumb, title), [live.firstPage, live.extra, thumb, title])

  const metaLine = [subscribers, handle, videoCount].filter(Boolean).join(' · ')

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

  // Per-subscription auto-save settings (optimistic; persisted via PATCH). Auto-save
  // applies to NEW uploads going forward, not the existing back-catalogue.
  async function patchSub(patch: Partial<Pick<Subscription, 'autoSave' | 'autoSaveKind' | 'autoSaveKeep'>>) {
    if (!sub) return
    qc.setQueryData<Subscription[]>(['yt-subs'], prev => prev?.map(s => s.id === sub.id ? { ...s, ...patch } : s))
    try {
      await updateSubscription(sub.id, patch)
      if (patch.autoSave !== undefined) toast.success(patch.autoSave ? 'Auto-saving new uploads from this channel' : 'Auto-save turned off')
    } catch {
      toast.error('Could not update auto-save')
      qc.invalidateQueries({ queryKey: ['yt-subs'] })
    }
  }

  // Until the channel's primary data lands, show a skeleton that mirrors the final layout —
  // banner, meta line, tabs and grid all arrive together from this one query, so the header
  // no longer pops in after the content and shoves it down.
  if (videos.isLoading && !videos.firstPage) return <ChannelSkeleton />

  return (
    <div className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6">
      {unsubDialog}

      {bannerUrl && (
        <div className="mb-5 overflow-hidden rounded-2xl ring-1 ring-border/40">
          <img src={bannerUrl} alt="" className="aspect-[6/1] w-full object-cover" />
        </div>
      )}

      <div className="mb-6 flex items-start gap-4">
        <ChannelAvatar title={title} src={thumb} className="size-20 shrink-0 text-3xl ring-1 ring-border/40 sm:size-24" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-black tracking-tight sm:text-3xl">{title}</h1>
          {metaLine && <p className="mt-0.5 text-sm text-muted-foreground">{metaLine}</p>}
          {description && (
            <div className="mt-1.5 max-w-2xl text-xs leading-relaxed text-muted-foreground/80">
              <p className={cn('whitespace-pre-line', !descOpen && 'line-clamp-2')}>{description}</p>
              {description.length > 120 && (
                <button onClick={() => setDescOpen(o => !o)} className="mt-0.5 font-semibold text-foreground/70 hover:text-foreground">
                  {descOpen ? 'Show less' : '…more'}
                </button>
              )}
            </div>
          )}
          {/* Links come from the slower about query; reserve a row for them while it loads so
              they fill in place instead of shoving the tabs + grid down when they arrive. */}
          {(links.length > 0 || aboutQuery.isLoading) && (
            <div className="mt-2 flex min-h-5 flex-wrap items-center gap-x-4 gap-y-1.5">
              {links.map(l => (
                <a key={l.url} href={l.url} target="_blank" rel="noreferrer noopener"
                  className="flex items-center gap-1 text-xs font-medium text-[var(--yt-accent-fg)] hover:underline">
                  <Link2 className="size-3.5" />{l.title}
                </a>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <PodcastSourceButtons
            videos={videoItems.map(v => ({ videoId: v.videoId, title: v.title, author: v.author ?? title }))}
            sourceId={`channel:${channelId}`} suggestedShowName={title} sourceDescription={description ?? undefined} coverImageUrl={thumb ?? undefined} />
          {subscribed && sub && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  aria-label={sub.autoSave ? 'Auto-save on' : 'Auto-save off'}
                  title={sub.autoSave ? `Auto-saving new ${sub.autoSaveKind}` : 'Auto-save new uploads'}
                  className={cn('flex size-10 items-center justify-center rounded-full transition-colors',
                    sub.autoSave ? 'bg-[var(--yt-accent)] text-white hover:bg-[var(--yt-accent-hover)]' : 'bg-muted text-muted-foreground hover:text-foreground')}>
                  <HardDriveDownload className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72 space-y-3 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Auto-save new videos</p>
                    <p className="text-xs text-muted-foreground">Download future uploads from this channel offline.</p>
                  </div>
                  <Switch checked={sub.autoSave} onCheckedChange={v => void patchSub({ autoSave: v })} />
                </div>
                {sub.autoSave && (
                  <>
                    <div className="flex items-center justify-between gap-3 border-t border-border/50 pt-3">
                      <span className="text-sm text-muted-foreground">Save as</span>
                      <div className="flex overflow-hidden rounded-md border border-border">
                        {(['video', 'audio'] as const).map(k => (
                          <button key={k} onClick={() => void patchSub({ autoSaveKind: k })}
                            className={cn('px-3 py-1 text-xs font-medium capitalize transition-colors',
                              sub.autoSaveKind === k ? 'bg-[var(--yt-accent)] text-white' : 'bg-background text-muted-foreground hover:text-foreground')}>
                            {k}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-muted-foreground">Keep latest</span>
                      <div className="flex items-center gap-1.5">
                        <input type="number" min={0} value={sub.autoSaveKeep ?? ''} placeholder="default"
                          onChange={e => void patchSub({ autoSaveKeep: e.target.value === '' ? null : Math.max(0, Math.floor(Number(e.target.value))) })}
                          className="w-16 rounded-md border border-border bg-background px-2 py-1 text-sm" />
                        <span className="text-xs text-muted-foreground">videos</span>
                      </div>
                    </div>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <button onClick={toggleSub} disabled={busy}
            aria-label={subscribed ? 'Subscribed — click to unsubscribe' : 'Subscribe'}
            title={subscribed ? 'Subscribed — click to unsubscribe' : 'Subscribe'}
            className={cn('group flex size-10 items-center justify-center rounded-full transition-colors disabled:opacity-60',
              subscribed ? 'bg-[var(--yt-accent)] text-white hover:bg-destructive hover:text-white' : 'bg-muted text-muted-foreground hover:text-foreground')}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : subscribed ? <Check className="size-4" /> : <Plus className="size-4" />}
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="mb-6 flex gap-6 overflow-x-auto border-b border-border/60 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {visibleTabs.map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={cn('relative -mb-px shrink-0 border-b-2 px-1 pb-3 text-sm font-semibold transition-colors',
              activeTab === key ? 'border-[var(--yt-accent)] text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'videos' && (
        videos.isLoading ? <Spinner />
          : videoItems.length === 0 ? <EmptyTab label="videos" />
          : <div className="space-y-8">
              <div className={GRID}>{videoItems.map(i => <VideoCard key={i.videoId} item={i} />)}</div>
              {videos.cursor && <LoadMore onClick={videos.loadMore} loading={videos.loadingMore} />}
            </div>
      )}

      {activeTab === 'shorts' && (
        shorts.isLoading ? <Spinner />
          : shortItems.length === 0 ? <EmptyTab label="Shorts" />
          : <div className="space-y-8">
              <div className={SHORTS_GRID}>{shortItems.map(i => <VideoCard key={i.videoId} item={i} aspect="short" />)}</div>
              {shorts.cursor && <LoadMore onClick={shorts.loadMore} loading={shorts.loadingMore} />}
            </div>
      )}

      {activeTab === 'live' && (
        live.isLoading ? <Spinner />
          : liveItems.length === 0 ? <EmptyTab label="live streams" />
          : <div className="space-y-8">
              <div className={GRID}>{liveItems.map(i => <VideoCard key={i.videoId} item={i} />)}</div>
              {live.cursor && <LoadMore onClick={live.loadMore} loading={live.loadingMore} />}
            </div>
      )}

      {activeTab === 'playlists' && (
        playlistsQuery.isLoading ? <Spinner />
          : (playlistsQuery.data?.playlists.length ?? 0) === 0 ? <EmptyTab label="playlists" />
          : <div className={GRID}>{playlistsQuery.data!.playlists.map(p => <PlaylistCard key={p.playlistId} p={p} />)}</div>
      )}
    </div>
  )
}

function Spinner() {
  return <div className="flex h-[40vh] items-center justify-center"><Loader2 className="size-7 animate-spin text-muted-foreground" /></div>
}

// Mirrors the loaded layout (header row + tab bar + video grid) so the page doesn't reflow
// when real data arrives. No banner placeholder — many channels have none, and reserving it
// would itself cause a shift when they don't.
function ChannelSkeleton() {
  return (
    <div className="mx-auto max-w-[1500px] animate-pulse px-4 py-6 sm:px-6">
      <div className="mb-6 flex items-start gap-4">
        <div className="size-20 shrink-0 rounded-full bg-muted sm:size-24" />
        <div className="min-w-0 flex-1 space-y-2 pt-1.5">
          <div className="h-7 w-56 max-w-full rounded bg-muted" />
          <div className="h-4 w-72 max-w-full rounded bg-muted" />
          <div className="h-3 w-full max-w-lg rounded bg-muted" />
        </div>
      </div>
      <div className="mb-6 flex gap-6 border-b border-border/60 pb-3">
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-4 w-16 rounded bg-muted" />)}
      </div>
      <div className={GRID}>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2.5">
            <div className="aspect-video rounded-xl bg-muted" />
            <div className="flex gap-2.5">
              <div className="mt-0.5 size-8 shrink-0 rounded-full bg-muted" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="h-3.5 w-full rounded bg-muted" />
                <div className="h-3 w-1/2 rounded bg-muted" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
