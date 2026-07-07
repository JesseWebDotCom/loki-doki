import { useEffect, useMemo, useState } from 'react'
import { useParams, useLocation, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { HardDriveDownload, Check, Plus } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { PageContainer } from '@/components/shared/PageContainer'
import { SkeletonCards } from '@/components/shared/SkeletonBlocks'
import { toast } from '@/lib/toast'
import { useYtSubs, useYtDownloads } from '@/lib/youtube/useData'
import {
  addSubscription, deleteSubscription, updateSubscription, saveChannelNow,
  getChannelPage, getChannelPlaylists, getChannelAbout, ytImageProxy,
  type ItVideo, type Subscription, type ChannelVideoTab,
} from '@/lib/youtube/api'
import { itToItem, savedToItem, type VideoItem } from '@/lib/youtube/types'
import { qualityBadge } from '@/lib/youtube/format'
import { VideoCard } from '@/components/youtube/VideoCard'
import { VideoCollection, YT_GRID as GRID } from '@/components/youtube/VideoCollection'
import { ChannelHeader } from '@/components/videos/ChannelHeader'
import { ChannelTabBar } from '@/components/videos/ChannelTabBar'
import { PlaylistCard, PlaylistListRow } from '@/components/youtube/shelves'
import { ViewToggle } from '@/components/shared/ViewToggle'
import { useViewPreference } from '@/hooks/useViewPreference'
import { PodcastSourceButtons } from '@/components/youtube/PodcastSourceButtons'
import { useUnsubscribeConfirm } from '@/components/youtube/UnsubscribeDialog'
import { useYoutubeMode } from '@/components/videos/VideosLayout'
import { Switch } from '@/components/ui/switch'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from '@/components/ui/dropdown-menu'

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
// name/thumbnail; otherwise VideoCard (which hides the avatar when author is empty) shows
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
      <Button variant="outline" onClick={onClick} disabled={loading}
        className="h-auto px-5 py-2.5 font-semibold hover:border-[var(--yt-accent)]">
        {loading && <Spinner />} Load more
      </Button>
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
  const online = useYoutubeMode() === 'online'
  const { data: subs = [] } = useYtSubs()
  const { data: downloads = [] } = useYtDownloads()
  const [busy, setBusy] = useState(false)
  // "Save latest N now" — immediately downloads this channel's current back-catalogue to the
  // Offline library (distinct from auto-save, which only covers future uploads).
  const [saveKind, setSaveKind] = useState<'video' | 'audio'>('video')
  const [saveCount, setSaveCount] = useState(10)
  const [savingNow, setSavingNow] = useState(false)
  // Card vs list view for the tab grids: persisted per-user so it sticks across visits.
  const [view, setView] = useViewPreference('youtube.channel_view', 'grid')

  // Render a tab's videos as either the card grid or the full-width list, per `view`.
  const renderVideos = (items: VideoItem[], aspect: 'video' | 'short' = 'video') =>
    <VideoCollection items={items} view={view} aspect={aspect} />

  const [params, setParams] = useSearchParams()
  const tab = (TABS.find(([k]) => k === params.get('tab'))?.[0] ?? 'videos') as Tab
  const setTab = (next: Tab) => setParams(prev => {
    const p = new URLSearchParams(prev)
    if (next === 'videos') p.delete('tab'); else p.set('tab', next)
    return p
  }, { replace: true })

  // Videos tab is always fetched (when online): it carries the channel meta (header, available
  // tabs) and seeds the "make a podcast" source, even while another tab is on screen. Offline,
  // none of the live tabs fetch; the page falls back to this channel's downloaded videos.
  const videos = useChannelVideos(channelId, 'videos', online)

  // When arriving from a search/related card the channel isn't subscribed yet, so fall
  // back to name/avatar passed via router state. InnerTube channel meta wins when present.
  const navState = (useLocation().state ?? {}) as { title?: string; thumbnailUrl?: string | null }
  const sub = subs.find(s => s.externalId === channelId)
  const meta = videos.firstPage?.meta

  // Only show tabs the channel actually publishes; otherwise Live/Playlists/Shorts silently
  // fall back to the channel's Home content. Videos is always shown; until meta loads (or for
  // an old cache without availableTabs) we show all so nothing flickers in late.
  const available = meta?.availableTabs
  const visibleTabs = TABS.filter(([k, label]) => k === 'videos' || !available?.length || available.includes(label))
  // If the URL points at a now-hidden tab, fall back to Videos.
  const activeTab = visibleTabs.some(([k]) => k === tab) ? tab : 'videos'

  // Secondary tabs only fetch when actually open (gated on the resolved active tab) and online.
  const shorts = useChannelVideos(channelId, 'shorts', activeTab === 'shorts' && online)
  const live = useChannelVideos(channelId, 'live', activeTab === 'live' && online)
  const playlistsQuery = useQuery({
    queryKey: ['yt-channel-playlists', channelId],
    queryFn: () => getChannelPlaylists(channelId),
    enabled: activeTab === 'playlists' && !!channelId && online,
  })
  const aboutQuery = useQuery({
    queryKey: ['yt-channel-about', channelId],
    queryFn: () => getChannelAbout(channelId),
    enabled: !!channelId && online,
  })

  // Offline: this channel's downloaded videos stand in for the live catalogue.
  const offlineVideos = useMemo(
    () => downloads
      .filter(r => r.status === 'ready' && r.channelId === channelId)
      .map(r => savedToItem(r, qualityBadge(r.kind, r.maxHeight))),
    [downloads, channelId],
  )

  const about = aboutQuery.data
  const title = meta?.title || sub?.title || navState.title || channelId
  const thumb = meta?.thumbnailUrl ?? sub?.thumbnailUrl ?? navState.thumbnailUrl ?? null
  const bannerUrl = meta?.bannerUrl ?? null
  // Prefer the description that arrives with the videos query (channel metadata) over the
  // one from the slower about query; same text, but using it avoids a re-layout when about
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

  // Immediately save this channel's latest N uploads to the Offline library.
  async function saveChannelNowClick() {
    setSavingNow(true)
    try {
      const d = await saveChannelNow(channelId, { kind: saveKind, count: saveCount })
      if (d.error) { toast.error(d.error); return }
      toast.success(`Saving ${d.queued ?? 0} ${saveKind === 'audio' ? 'audio track' : 'video'}${(d.queued ?? 0) === 1 ? '' : 's'} offline`)
      qc.invalidateQueries({ queryKey: ['yt-downloads'] })
    } catch { toast.error('Could not save this channel') } finally { setSavingNow(false) }
  }

  // Offline: no live fetch, just the channel header (from local sub/nav state) over a grid of
  // whatever's been saved from this channel. Nothing here touches the network.
  if (!online) {
    return (
      <PageContainer width="wide" className="py-6">
        <ChannelHeader
          title={title}
          avatarUrl={thumb}
          proxyImage={ytImageProxy}
          metaLine={`${offlineVideos.length} ${offlineVideos.length === 1 ? 'video' : 'videos'} saved offline`}
        />
        {offlineVideos.length === 0
          ? <EmptyTab label="offline videos" />
          : <div className={GRID}>{offlineVideos.map(i => <VideoCard key={i.videoId + (i.localKind ?? '')} item={i} />)}</div>}
      </PageContainer>
    )
  }

  // Until the channel's primary data lands, show a skeleton that mirrors the final layout:
  // banner, meta line, tabs and grid all arrive together from this one query, so the header
  // no longer pops in after the content and shoves it down.
  if (videos.isLoading && !videos.firstPage) return <ChannelSkeleton />

  return (
    <PageContainer width="wide" className="py-6">
      {unsubDialog}

      <ChannelHeader
        title={title}
        avatarUrl={thumb}
        bannerUrl={bannerUrl}
        proxyImage={ytImageProxy}
        metaLine={metaLine}
        description={description}
        links={links}
        linksLoading={aboutQuery.isLoading}
        actions={<>
          <PodcastSourceButtons
            videos={videoItems.map(v => ({ videoId: v.videoId, title: v.title, author: v.author ?? title }))}
            sourceId={`channel:${channelId}`} suggestedShowName={title} sourceDescription={description ?? undefined} coverImageUrl={thumb ?? undefined} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon"
                aria-label="Save this channel offline"
                title={sub?.autoSave ? `Auto-saving new ${sub.autoSaveKind}` : 'Save this channel offline'}
                className={cn('size-10',
                  sub?.autoSave ? 'bg-[var(--yt-accent)] text-white hover:bg-[var(--yt-accent-hover)]' : 'bg-muted text-muted-foreground hover:bg-muted hover:text-foreground')}>
                <HardDriveDownload className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72 space-y-3 p-3">
              {/* Save now: immediately grab this channel's current back-catalogue. */}
              <div className="space-y-2.5">
                <div>
                  <p className="text-sm font-medium">Save videos now</p>
                  <p className="text-xs text-muted-foreground">Download this channel's latest uploads to Offline.</p>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted-foreground">Save as</span>
                  <div className="flex overflow-hidden rounded-full border border-border">
                    {(['video', 'audio'] as const).map(k => (
                      <button key={k} onClick={() => setSaveKind(k)}
                        className={cn('px-3 py-1 text-xs font-medium capitalize transition-colors',
                          saveKind === k ? 'bg-[var(--yt-accent)] text-white' : 'bg-background text-muted-foreground hover:text-foreground')}>
                        {k}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted-foreground">How many</span>
                  <div className="flex items-center gap-1.5">
                    <input type="number" min={1} max={50} value={saveCount}
                      onChange={e => setSaveCount(Math.max(1, Math.min(50, Math.floor(Number(e.target.value)) || 1)))}
                      className="w-16 rounded-control border border-border bg-background px-2 py-1 text-sm" />
                    <span className="text-xs text-muted-foreground">latest</span>
                  </div>
                </div>
                <Button onClick={saveChannelNowClick} disabled={savingNow} className="w-full gap-1.5 font-semibold">
                  {savingNow ? <Spinner className="text-primary-foreground" /> : <HardDriveDownload className="size-4" />}
                  Save {saveCount} now
                </Button>
              </div>

              {/* Auto-save future uploads (subscription-scoped). */}
              {sub ? (
                <div className="space-y-3 border-t border-border/50 pt-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">Auto-save new videos</p>
                      <p className="text-xs text-muted-foreground">Also grab future uploads automatically.</p>
                    </div>
                    <Switch checked={sub.autoSave} onCheckedChange={v => void patchSub({ autoSave: v })} />
                  </div>
                  {sub.autoSave && (
                    <>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm text-muted-foreground">Save as</span>
                        <div className="flex overflow-hidden rounded-full border border-border">
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
                            className="w-16 rounded-control border border-border bg-background px-2 py-1 text-sm" />
                          <span className="text-xs text-muted-foreground">videos</span>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <p className="border-t border-border/50 pt-3 text-xs text-muted-foreground">Subscribe to auto-save new uploads from this channel.</p>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="icon" onClick={toggleSub} disabled={busy}
            aria-label={subscribed ? 'Subscribed. Click to unsubscribe' : 'Subscribe'}
            title={subscribed ? 'Subscribed. Click to unsubscribe' : 'Subscribe'}
            className={cn('group size-10 disabled:opacity-60',
              subscribed ? 'bg-[var(--yt-accent)] text-white hover:bg-destructive hover:text-white' : 'bg-muted text-muted-foreground hover:bg-muted hover:text-foreground')}>
            {busy ? <Spinner className="text-current" /> : subscribed ? <Check className="size-4" /> : <Plus className="size-4" />}
          </Button>
        </>}
      />

      <ChannelTabBar
        tabs={visibleTabs}
        active={activeTab}
        onChange={setTab}
        right={<ViewToggle value={view} onChange={setView} className="mb-2 shrink-0" />}
      />

      {activeTab === 'videos' && (
        videos.isLoading ? <TabLoading />
          : videoItems.length === 0 ? <EmptyTab label="videos" />
          : <div className="space-y-8">
              {renderVideos(videoItems)}
              {videos.cursor && <LoadMore onClick={videos.loadMore} loading={videos.loadingMore} />}
            </div>
      )}

      {activeTab === 'shorts' && (
        shorts.isLoading ? <TabLoading />
          : shortItems.length === 0 ? <EmptyTab label="Shorts" />
          : <div className="space-y-8">
              {renderVideos(shortItems, 'short')}
              {shorts.cursor && <LoadMore onClick={shorts.loadMore} loading={shorts.loadingMore} />}
            </div>
      )}

      {activeTab === 'live' && (
        live.isLoading ? <TabLoading />
          : liveItems.length === 0 ? <EmptyTab label="live streams" />
          : <div className="space-y-8">
              {renderVideos(liveItems)}
              {live.cursor && <LoadMore onClick={live.loadMore} loading={live.loadingMore} />}
            </div>
      )}

      {activeTab === 'playlists' && (
        playlistsQuery.isLoading ? <TabLoading />
          : (playlistsQuery.data?.playlists.length ?? 0) === 0 ? <EmptyTab label="playlists" />
          : view === 'list'
            ? <div className="space-y-1">{playlistsQuery.data!.playlists.map(p => <PlaylistListRow key={p.playlistId} p={p} />)}</div>
            : <div className={GRID}>{playlistsQuery.data!.playlists.map(p => <PlaylistCard key={p.playlistId} p={p} />)}</div>
      )}
    </PageContainer>
  )
}

function TabLoading() {
  return <SkeletonCards count={8} className="xl:grid-cols-4" />
}

// Mirrors the loaded layout (header row + tab bar + video grid) so the page doesn't reflow
// when real data arrives. No banner placeholder; many channels have none, and reserving it
// would itself cause a shift when they don't.
function ChannelSkeleton() {
  return (
    <PageContainer width="wide" className="py-6">
      <div className="mb-6 flex items-start gap-4">
        <Skeleton className="size-20 shrink-0 rounded-full sm:size-24" />
        <div className="min-w-0 flex-1 space-y-2 pt-1.5">
          <Skeleton className="h-7 w-56 max-w-full" />
          <Skeleton className="h-4 w-72 max-w-full" />
          <Skeleton className="h-3 w-full max-w-lg" />
        </div>
      </div>
      <div className="mb-6 flex gap-6 border-b border-border/60 pb-3">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-4 w-16" />)}
      </div>
      <div className={GRID}>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2.5">
            <Skeleton className="aspect-video rounded-card" />
            <div className="flex gap-2.5">
              <Skeleton className="mt-0.5 size-8 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </PageContainer>
  )
}
