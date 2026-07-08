import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Clapperboard, Clock, Heart, History, Trash2, ListVideo, Plus, Search, X, type LucideIcon } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { proxyImg } from '@/lib/img'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SkeletonCards } from '@/components/shared/SkeletonBlocks'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { getHistoryFull, clearHistory, removeHistoryItem, ytImageProxy, type HistoryRow } from '@/lib/youtube/api'
import { getHubHistory, getSubscriptionPlaylists, type HubVideoItem, type VideoSource } from '@/lib/videos/api'
import { LibrarySourceRow, type LibrarySourceFilter } from '@/components/videos/LibrarySourceRow'
import { HUB_PATHS } from '@/components/videos/HubVideoCard'
import { HubCard, HubRow } from '@/components/videos/HubCard'
import { MineCard, MineRow } from '@/components/videos/MineCard'
import { listStudioBin, listStudioProjects, isMineBinItem, type StudioBinItem } from '@/lib/videos/studioApi'
import { CreatorAvatar } from '@/components/videos/CreatorAvatar'
import { PlaylistCard } from '@/components/videos/PlaylistCard'
import { HScroll } from '@/components/youtube/shelves'
import { SOURCE_META, MINE_META } from '@/lib/videos/sources'
import { type VideoItem } from '@/lib/youtube/types'
import { useCollection, removeFromCollection, type SavedVideoMeta } from '@/lib/youtube/collections'
import { listYtPlaylists, createYtPlaylist } from '@/lib/youtube/playlists'
import { VideoCollection, YT_GRID as GRID, YT_SHORTS_GRID } from '@/components/youtube/VideoCollection'
import { ViewToggle } from '@/components/shared/ViewToggle'
import { useViewPreference } from '@/hooks/useViewPreference'
import { PlaylistCover } from '@/components/youtube/PlaylistCover'
import { AddToPlaylistButton } from '@/components/youtube/AddToPlaylistButton'

const cardAddBtnClass = 'absolute right-2 top-2 hidden size-7 bg-black/70 text-white opacity-100 hover:bg-black/90 group-hover:flex'
const toVid = (item: VideoItem) => ({ videoId: item.videoId, title: item.title, author: item.author ?? undefined, channelId: item.channelId ?? undefined, durationSec: item.durationSec ?? undefined })
const hubToVid = (item: HubVideoItem) => ({
  videoId: item.id, title: item.title, author: item.creator?.name ?? undefined, channelId: item.creator?.id ?? undefined,
  durationSec: item.durationSec ?? undefined, videoSource: item.source, thumbnailUrl: item.thumbnailUrl,
})
const mineToVid = (item: StudioBinItem) => ({ videoId: item.assetId, title: item.title, durationSec: item.durationSec ?? undefined, videoSource: 'mine' as const, thumbnailUrl: item.thumbUrl })

const metaToItem = (m: SavedVideoMeta): VideoItem => ({ videoId: m.videoId, title: m.title, author: m.author, channelId: m.channelId, channelThumb: m.channelThumb, durationSec: m.durationSec })

// Each library section is its own page/route with its own header: click "History"
// and you land on a dedicated History page, not a shared "Library" shell with tabs.
function LibraryPage({ title, icon, subtitle, actions, children }: {
  title: string; icon: LucideIcon; subtitle?: string; actions?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <PageContainer width="wide" className="pb-6">
      <PageHeader title={title} icon={icon} subtitle={subtitle} actions={actions} className="pt-6 pb-5" />
      {children}
    </PageContainer>
  )
}

export function YoutubeHistoryPage() {
  return <LibraryPage title="History" icon={History}><HistoryTab /></LibraryPage>
}
export function YoutubePlaylistsPage() {
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const create = async () => {
    const n = name.trim()
    if (!n) return
    try {
      await createYtPlaylist({ name: n, description: description.trim() || undefined })
      await qc.invalidateQueries({ queryKey: ['yt-playlists'] })
      toast.success('Playlist created'); setCreating(false); setName(''); setDescription('')
    }
    catch { toast.error('Could not create playlist') }
  }
  return (
    <LibraryPage title="Playlists" icon={ListVideo}
      subtitle="Collections of videos you've built from every source, ready to watch or share."
      actions={<Button onClick={() => { setName(''); setDescription(''); setCreating(true) }}><Plus className="size-4" /> New playlist</Button>}>
      <PlaylistsTab />
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>New playlist</DialogTitle></DialogHeader>
          <Input value={name} autoFocus placeholder="Playlist name" onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void create() }} />
          <Textarea value={description} placeholder="Description (optional)" rows={3}
            onChange={e => setDescription(e.target.value)} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button onClick={create} disabled={!name.trim()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </LibraryPage>
  )
}
export function YoutubeWatchLaterPage() {
  return <LibraryPage title="Watch Later" icon={Clock}><CollectionTab kind="watch-later" empty="Nothing in Watch Later yet." /></LibraryPage>
}
export function YoutubeLikedPage() {
  return <LibraryPage title="Liked" icon={Heart}><CollectionTab kind="liked" empty="No liked videos yet." /></LibraryPage>
}
export { LibraryPage }

// Bucket timestamped rows into YouTube-style date sections (rows arrive newest-first).
// Generic so it works across the merged YouTube + hub history feed, not just YouTube rows.
function groupByDate<T extends { updatedAt: number }>(rows: T[]): { label: string; rows: T[] }[] {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const DAY = 86_400_000
  const bucket = (ts: number) => {
    if (ts >= startOfToday) return 'Today'
    if (ts >= startOfToday - DAY) return 'Yesterday'
    if (ts >= startOfToday - 7 * DAY) return 'This week'
    if (ts >= startOfToday - 30 * DAY) return 'This month'
    return 'Older'
  }
  const order = ['Today', 'Yesterday', 'This week', 'This month', 'Older']
  const map = new Map<string, T[]>()
  for (const r of rows) { const b = bucket(r.updatedAt); (map.get(b) ?? map.set(b, []).get(b)!).push(r) }
  return order.filter(l => map.has(l)).map(l => ({ label: l, rows: map.get(l)! }))
}

// One row of the merged history feed: a hub item (so it renders with the same source
// badge as every other mixed-source surface) plus, for YouTube rows only, the raw
// videoId needed for the remove/add-to-playlist actions that are YouTube-specific. Mine
// (Studio bin) rows carry no watch state at all — there's no "watch" event to hang it off
// of — so they're bucketed by createdAt instead, as a "recently added" proxy, not real history.
type CombinedHistoryEntry =
  | { key: string; updatedAt: number; kind: 'hub'; item: HubVideoItem; ytVideoId: string | null }
  | { key: string; updatedAt: number; kind: 'mine'; mine: StudioBinItem }

function HistoryTab() {
  const qc = useQueryClient()
  const { data: full, isPending } = useQuery({ queryKey: ['yt-history-full'], queryFn: getHistoryFull })
  const history = full?.history ?? []
  const accountHistory = full?.accountHistory ?? []
  const { data: hubHist } = useQuery({ queryKey: ['videos-history'], queryFn: getHubHistory })
  const hubRows = hubHist?.history ?? []
  const { data: mineBin } = useQuery({ queryKey: ['studio-bin'], queryFn: listStudioBin })
  const mineItems = useMemo(() => (mineBin?.items ?? []).filter(isMineBinItem), [mineBin])
  const [sourceFilter, setSourceFilter] = useState<LibrarySourceFilter>('all')
  const availableSources = useMemo(() => {
    const set = new Set<VideoSource>()
    if (history.length || accountHistory.length) set.add('youtube')
    for (const r of hubRows) set.add(r.source)
    return [...set]
  }, [history.length, accountHistory.length, hubRows])
  const [q, setQ] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [view, setView] = useViewPreference('youtube.library_history_view', 'grid')

  // Merge YouTube + every other source (+ Mine, by creation time) into one chronologically-
  // sorted feed so History shows everything in one place, badged the same way as the
  // front-page hub feed, instead of a YouTube-only list with other sources tacked on below.
  const combined = useMemo<CombinedHistoryEntry[]>(() => {
    const yt = history.map((h): CombinedHistoryEntry => ({
      key: `youtube:${h.videoId}`,
      updatedAt: h.updatedAt,
      kind: 'hub',
      ytVideoId: h.videoId,
      item: {
        source: 'youtube',
        id: h.videoId,
        url: `https://www.youtube.com/watch?v=${h.videoId}`,
        title: h.title,
        creator: h.channelId || h.author
          ? { id: h.channelId ?? '', name: h.author ?? '', avatarUrl: h.channelThumb ?? null }
          : null,
        durationSec: h.durationSec,
      },
    }))
    const other = hubRows.map((r): CombinedHistoryEntry => ({
      key: `${r.source}:${r.videoId}`,
      updatedAt: r.updatedAt,
      kind: 'hub',
      ytVideoId: null,
      item: {
        source: r.source,
        id: r.videoId,
        url: '',
        title: r.title,
        creator: r.creatorName ? { id: '', name: r.creatorName } : null,
        thumbnailUrl: r.thumbnailUrl,
        durationSec: r.durationSec,
      },
    }))
    const mine = mineItems.map((m): CombinedHistoryEntry => ({
      key: `mine:${m.assetId}`, updatedAt: m.createdAt, kind: 'mine', mine: m,
    }))
    return [...yt, ...other, ...mine].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [history, hubRows, mineItems])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return combined.filter(e => {
      if (sourceFilter === 'mine' && e.kind !== 'mine') return false
      if (sourceFilter !== 'all' && sourceFilter !== 'mine' && (e.kind !== 'hub' || e.item.source !== sourceFilter)) return false
      if (!needle) return true
      const title = e.kind === 'mine' ? e.mine.title : e.item.title
      const creator = e.kind === 'mine' ? '' : (e.item.creator?.name ?? '')
      return title.toLowerCase().includes(needle) || creator.toLowerCase().includes(needle)
    })
  }, [combined, q, sourceFilter])
  const groups = useMemo(() => groupByDate(filtered), [filtered])

  const remove = async (videoId: string) => {
    qc.setQueryData<{ history: HistoryRow[]; accountHistory: unknown[] }>(['yt-history-full'],
      prev => prev ? { ...prev, history: prev.history.filter(h => h.videoId !== videoId) } : prev)
    try { await removeHistoryItem(videoId) }
    catch { toast.error('Could not remove'); qc.invalidateQueries({ queryKey: ['yt-history-full'] }) }
  }
  const clearAll = async () => {
    try {
      await clearHistory()
      qc.setQueryData<{ history: HistoryRow[]; accountHistory: unknown[] }>(['yt-history-full'],
        prev => prev ? { ...prev, history: [] } : prev)
      toast.success('Watch history cleared')
    }
    catch { toast.error('Could not clear history') }
  }

  if (isPending) return <SkeletonCards count={8} className="xl:grid-cols-4" />
  if (!combined.length) return <Empty label="No watch history yet. Videos you play show up here." icon={History} />

  const gridClass = view === 'list' ? 'space-y-1' : view === 'big' ? YT_SHORTS_GRID : GRID
  const shape: 'wide' | 'tall' = view === 'big' ? 'tall' : 'wide'

  return (
    <div>
      <LibrarySourceRow available={availableSources} active={sourceFilter} onChange={setSourceFilter} />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search watch history" className="pl-9" />
        </div>
        <Button variant="outline" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => setConfirmClear(true)}>
          <Trash2 className="size-4" /> Clear all history
        </Button>
        <ViewToggle value={view} onChange={setView} className="ml-auto shrink-0" />
      </div>

      {!groups.length ? (
        <Empty label={q.trim() ? `No history matches “${q}”.` : 'No history for this source yet.'} icon={q.trim() ? Search : History} />
      ) : (
        <div className="space-y-8">
          {groups.map(g => (
            <section key={g.label}>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{g.label}</h3>
              <div className={gridClass}>
                {g.rows.map(entry => entry.kind === 'mine' ? (
                  <div key={entry.key} className="group relative">
                    {view === 'list' ? <MineRow item={entry.mine} /> : <MineCard item={entry.mine} shape={shape} />}
                    <AddToPlaylistButton video={mineToVid(entry.mine)} className={cardAddBtnClass} />
                  </div>
                ) : (
                  <div key={entry.key} className="group relative">
                    {view === 'list' ? <HubRow item={entry.item} /> : <HubCard item={entry.item} shape={shape} />}
                    <AddToPlaylistButton video={hubToVid(entry.item)} className={cn(cardAddBtnClass, entry.ytVideoId && 'right-11')} />
                    {entry.ytVideoId && (
                      <button onClick={() => void remove(entry.ytVideoId!)}
                        className="absolute right-2 top-2 hidden rounded-full bg-black/70 p-1.5 text-white hover:bg-black/90 group-hover:flex" aria-label="Remove from history">
                        <X className="size-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {accountHistory.length > 0 && (sourceFilter === 'all' || sourceFilter === 'youtube') && (
        <section className="mt-10">
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">Watched on your YouTube account</h3>
          <VideoCollection
            items={accountHistory.map(v => ({
              videoId: v.videoId, title: v.title, author: v.author,
              channelId: v.channelId, durationSec: v.durationSec, channelThumb: v.channelThumb,
            }))}
            view={view}
          />
        </section>
      )}

      <ConfirmDialog open={confirmClear} onOpenChange={setConfirmClear} title="Clear all watch history?"
        description="This removes every video from your history and resets their resume positions." destructive
        confirmLabel="Clear all" onConfirm={() => void clearAll()} />
    </div>
  )
}

function PlaylistsTab() {
  const navigate = useNavigate()
  // Playlists are cross-source at the data layer (yt_playlist_videos.video_source); YouTube
  // playlists are real curated video lists, while Mine surfaces your Studio edit projects —
  // the closest thing to "your own playlists" until non-YouTube videos can be added to a
  // real playlist too.
  const [sourceFilter, setSourceFilter] = useState<LibrarySourceFilter>('all')
  const { data } = useQuery({ queryKey: ['yt-playlists'], queryFn: listYtPlaylists })
  const ytPlaylists = sourceFilter === 'all' || sourceFilter === 'youtube' ? [...(data?.mine ?? []), ...(data?.shared ?? [])] : []
  const { data: projectsData } = useQuery({ queryKey: ['studio-projects'], queryFn: listStudioProjects })
  const mineProjects = sourceFilter === 'all' || sourceFilter === 'mine' ? (projectsData?.projects ?? []) : []
  const isEmpty = !ytPlaylists.length && !mineProjects.length

  return (
    <div>
      <LibrarySourceRow available={['youtube']} active={sourceFilter} onChange={setSourceFilter} className="mb-4" />
      {isEmpty ? (
        <Empty label="Create a playlist to collect your favorite videos." icon={ListVideo} />
      ) : (
        <div className="space-y-6">
          {mineProjects.length > 0 && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {mineProjects.map(p => (
                <Card key={p.id} variant="interactive" className="p-4" onClick={() => navigate(`/videos/mine/${p.id}`)}>
                  <div className="flex items-start gap-3">
                    <Clapperboard className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-sm font-semibold">{p.name}</p>
                        <span className={cn('inline-flex shrink-0 items-center rounded-full p-1', MINE_META.badgeClass)}>
                          <MINE_META.icon className="size-2.5" aria-hidden />
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">updated {new Date(p.updatedAt).toLocaleDateString()}</p>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
          {ytPlaylists.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {ytPlaylists.map(p => (
                <Card key={p.id} variant="interactive" className="p-3" onClick={() => navigate(`/videos/youtube/my-playlist/${p.id}`)}>
                  <PlaylistCover videoIds={p.coverVideoIds ?? []} title={p.name} count={p.videoCount} className="mb-2" />
                  <p className="truncate text-sm font-semibold">{p.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {p.ownerName ? `by ${p.ownerName}` : p.visibility === 'shared' ? 'Shared' : 'Private'}
                    {' · '}{p.videoCount} video{p.videoCount === 1 ? '' : 's'}
                  </p>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
      <SubscriptionPlaylists />
    </div>
  )
}

/** Playlists made by your subscribed channels/creators (YouTube + Reddit/TikTok/Vimeo
 *  follows), one horizontal rail per channel. The backend warms these in the background
 *  (checking hundreds of subscriptions live would be far too slow), so this polls while
 *  `warming` is nonzero and just fills in as results land. */
function SubscriptionPlaylists() {
  const { data } = useQuery({
    queryKey: ['videos-subscription-playlists'],
    queryFn: getSubscriptionPlaylists,
    refetchInterval: (q) => (q.state.data?.warming ? 4000 : false),
  })
  const groups = data?.groups ?? []
  const warming = data?.warming ?? 0
  if (!groups.length && !warming) return null

  return (
    <div className="mt-8 space-y-6 border-t border-border/60 pt-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">From your subscriptions</h2>
        {warming > 0 && (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner size="sm" /> Checking {warming} {warming === 1 ? 'channel' : 'channels'}…
          </span>
        )}
      </div>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No playlists found yet — check back once we've scanned your subscriptions.</p>
      ) : (
        groups.map((g) => {
          const proxy = g.source === 'youtube' ? ytImageProxy : proxyImg
          const meta = SOURCE_META[g.source]
          return (
            <div key={`${g.source}:${g.externalId}`}>
              <Link to={HUB_PATHS[g.source].creator(g.externalId)}
                className="mb-2 inline-flex items-center gap-2 text-sm font-semibold text-foreground hover:underline">
                <CreatorAvatar title={g.title} src={g.thumbnailUrl} className="size-6 text-[10px] ring-1 ring-border/40" />
                {g.title}
                <span className={cn('inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold', meta.badgeClass)}>
                  <meta.icon className="size-2.5" aria-hidden />
                </span>
              </Link>
              <HScroll>
                {g.playlists.map((p) => (
                  <div key={p.id} className="w-48 shrink-0">
                    <PlaylistCard source={g.source} proxy={proxy}
                      p={{ playlistId: p.id, title: p.title, videoCount: p.videoCount ?? null, thumbnailUrl: p.thumbnailUrl ?? null, author: g.title }} />
                  </div>
                ))}
              </HScroll>
            </div>
          )
        })
      )}
    </div>
  )
}

function CollectionTab({ kind, empty }: { kind: 'watch-later' | 'liked'; empty: string }) {
  const list = useCollection(kind)
  const [view, setView] = useViewPreference(`youtube.library_${kind}_view`, 'grid')
  const [sourceFilter, setSourceFilter] = useState<LibrarySourceFilter>('all')
  // Mine entries only ever carry {videoId: assetId, title, durationSec} (see toggleCollection
  // calls on MyVideosPage) — resolve the real bin item here for its thumbnail/origin, same as
  // History does, rather than fabricating one.
  const { data: mineBin } = useQuery({ queryKey: ['studio-bin'], queryFn: listStudioBin })
  const mineByAssetId = useMemo(() => {
    const m = new Map<string, StudioBinItem>()
    for (const item of mineBin?.items ?? []) if (isMineBinItem(item)) m.set(item.assetId, item)
    return m
  }, [mineBin])

  if (!list.length) return <Empty label={empty} icon={kind === 'liked' ? Heart : Clock} />

  // Cross-source: YouTube renders through VideoCollection, Mine resolves to Studio bin
  // items, everything else (reddit/tiktok/vimeo/link) renders as hub cards - same split
  // the History tab uses. The source filter row only lists sources with entries.
  const ytEntries = list.filter(v => !v.videoSource || v.videoSource === 'youtube')
  const hubEntries = list.filter(v => v.videoSource && v.videoSource !== 'youtube' && v.videoSource !== 'mine')
  const availableSources: VideoSource[] = [
    ...(ytEntries.length ? (['youtube'] as VideoSource[]) : []),
    ...[...new Set(hubEntries.map(v => v.videoSource!))] as VideoSource[],
  ]
  const ytList = sourceFilter === 'all' || sourceFilter === 'youtube' ? ytEntries : []
  const hubList = sourceFilter === 'all' ? hubEntries
    : sourceFilter === 'youtube' || sourceFilter === 'mine' ? []
    : hubEntries.filter(v => v.videoSource === sourceFilter)
  const mineList = sourceFilter === 'all' || sourceFilter === 'mine'
    ? list.filter(v => v.videoSource === 'mine').map(v => mineByAssetId.get(v.videoId)).filter((x): x is StudioBinItem => !!x)
    : []
  const isEmpty = !ytList.length && !mineList.length && !hubList.length
  const gridClass = view === 'list' ? 'space-y-1' : view === 'big' ? YT_SHORTS_GRID : GRID
  const shape: 'wide' | 'tall' = view === 'big' ? 'tall' : 'wide'

  const metaToHubItem = (m: SavedVideoMeta): HubVideoItem => ({
    source: (m.videoSource ?? 'link') as HubVideoItem['source'], id: m.videoId, url: '',
    title: m.title,
    creator: m.author ? { id: m.channelId ?? '', name: m.author, avatarUrl: m.channelThumb ?? null } : null,
    thumbnailUrl: m.thumbnailUrl ?? null, durationSec: m.durationSec ?? null,
  })

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <LibrarySourceRow available={availableSources} active={sourceFilter} onChange={setSourceFilter} className="mb-0 min-w-0 flex-1" />
        <ViewToggle value={view} onChange={setView} className="shrink-0" />
      </div>
      {isEmpty ? (
        <Empty label="Nothing for this source yet." icon={kind === 'liked' ? Heart : Clock} />
      ) : (
        <div className="space-y-6">
          {hubList.length > 0 && (
            <div className={gridClass}>
              {hubList.map(m => {
                const item = metaToHubItem(m)
                return (
                  <div key={`${m.videoSource}:${m.videoId}`} className="group relative">
                    {view === 'list' ? <HubRow item={item} /> : <HubCard item={item} shape={shape} />}
                    <AddToPlaylistButton video={hubToVid(item)} className={cn(cardAddBtnClass, 'right-11')} />
                    <button onClick={() => { removeFromCollection(kind, m.videoId); toast.success('Removed') }}
                      className="absolute right-2 top-2 hidden rounded-full bg-black/70 p-1.5 text-white hover:bg-black/90 group-hover:flex" aria-label="Remove">
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
          {mineList.length > 0 && (
            <div className={gridClass}>
              {mineList.map(item => (
                <div key={item.assetId} className="group relative">
                  {view === 'list' ? <MineRow item={item} /> : <MineCard item={item} shape={shape} />}
                  <AddToPlaylistButton video={mineToVid(item)} className={cn(cardAddBtnClass, 'right-11')} />
                  <button onClick={() => { removeFromCollection(kind, item.assetId); toast.success('Removed') }}
                    className="absolute right-2 top-2 hidden rounded-full bg-black/70 p-1.5 text-white hover:bg-black/90 group-hover:flex" aria-label="Remove">
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {ytList.length > 0 && (
            <VideoCollection items={ytList.map(metaToItem)} view={view} wrap={(item, node) => (
              <div className="group relative">
                {node}
                <AddToPlaylistButton video={toVid(item)} className={cn(cardAddBtnClass, 'right-11')} />
                <button onClick={() => { removeFromCollection(kind, item.videoId); toast.success('Removed') }}
                  className="absolute right-2 top-2 hidden rounded-full bg-black/70 p-1.5 text-white hover:bg-black/90 group-hover:flex" aria-label="Remove">
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            )} />
          )}
        </div>
      )}
    </div>
  )
}

function Empty({ label, icon: Icon = ListVideo }: { label: string; icon?: LucideIcon }) {
  return (
    <div className="flex flex-col items-center gap-3 py-24 text-center text-muted-foreground">
      <Icon className="size-10 opacity-25" />
      <p className="text-sm">{label}</p>
    </div>
  )
}
