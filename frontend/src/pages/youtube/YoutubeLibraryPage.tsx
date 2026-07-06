import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock, Heart, History, Trash2, Download, ListVideo, Plus, Search, X, type LucideIcon } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SkeletonCards } from '@/components/shared/SkeletonBlocks'
import { OfflineSelectionToolbar } from '@/components/shared/OfflineSelectionToolbar'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { useYtDownloads } from '@/lib/youtube/useData'
import { getHistory, deleteDownloads, clearHistory, removeHistoryItem, type HistoryRow, type SavedRow } from '@/lib/youtube/api'
import { savedToItem, historyToItem, type VideoItem } from '@/lib/youtube/types'
import { qualityBadge, fmtBytes } from '@/lib/youtube/format'
import { VideoThumb } from '@/components/youtube/media'
import { useCollection, removeFromCollection, type SavedVideoMeta } from '@/lib/youtube/collections'
import { listYtPlaylists, createYtPlaylist } from '@/lib/youtube/playlists'
import { VideoCard } from '@/components/youtube/VideoCard'
import { PlaylistCover } from '@/components/youtube/PlaylistCover'
import { AddToPlaylistButton } from '@/components/youtube/AddToPlaylistButton'

const cardAddBtnClass = 'absolute right-2 top-2 hidden size-7 bg-black/70 text-white opacity-100 hover:bg-black/90 group-hover:flex'
const toVid = (item: VideoItem) => ({ videoId: item.videoId, title: item.title, author: item.author ?? undefined, channelId: item.channelId ?? undefined, durationSec: item.durationSec ?? undefined })

const GRID = 'grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-4'
const metaToItem = (m: SavedVideoMeta): VideoItem => ({ videoId: m.videoId, title: m.title, author: m.author, channelId: m.channelId, channelThumb: m.channelThumb, durationSec: m.durationSec })

// Each library section is its own page/route with its own header — click "History"
// and you land on a dedicated History page, not a shared "Library" shell with tabs.
function LibraryPage({ title, icon, children }: { title: string; icon: LucideIcon; children: React.ReactNode }) {
  return (
    <PageContainer width="wide" className="pb-6">
      <PageHeader title={title} icon={icon} className="pt-6 pb-5" />
      {children}
    </PageContainer>
  )
}

export function YoutubeHistoryPage() {
  return <LibraryPage title="History" icon={History}><HistoryTab /></LibraryPage>
}
export function YoutubePlaylistsPage() {
  return <LibraryPage title="Playlists" icon={ListVideo}><PlaylistsTab /></LibraryPage>
}
export function YoutubeWatchLaterPage() {
  return <LibraryPage title="Watch Later" icon={Clock}><CollectionTab kind="watch-later" empty="Nothing in Watch Later yet." /></LibraryPage>
}
export function YoutubeLikedPage() {
  return <LibraryPage title="Liked" icon={Heart}><CollectionTab kind="liked" empty="No liked videos yet." /></LibraryPage>
}
export function YoutubeOfflinePage() {
  return <LibraryPage title="Offline" icon={Download}><SavedTab /></LibraryPage>
}

// Bucket history rows into YouTube-style date sections (rows arrive newest-first).
function groupHistoryByDate(rows: HistoryRow[]): { label: string; rows: HistoryRow[] }[] {
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
  const map = new Map<string, HistoryRow[]>()
  for (const h of rows) { const b = bucket(h.updatedAt); (map.get(b) ?? map.set(b, []).get(b)!).push(h) }
  return order.filter(l => map.has(l)).map(l => ({ label: l, rows: map.get(l)! }))
}

function HistoryTab() {
  const qc = useQueryClient()
  const { data: history = [], isPending } = useQuery({ queryKey: ['yt-history'], queryFn: getHistory })
  const [q, setQ] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return history
    return history.filter(h => (h.title ?? '').toLowerCase().includes(needle) || (h.author ?? '').toLowerCase().includes(needle))
  }, [history, q])
  const groups = useMemo(() => groupHistoryByDate(filtered), [filtered])

  const remove = async (videoId: string) => {
    qc.setQueryData<HistoryRow[]>(['yt-history'], prev => (prev ?? []).filter(h => h.videoId !== videoId))
    try { await removeHistoryItem(videoId) }
    catch { toast.error('Could not remove'); qc.invalidateQueries({ queryKey: ['yt-history'] }) }
  }
  const clearAll = async () => {
    try { await clearHistory(); qc.setQueryData(['yt-history'], []); toast.success('Watch history cleared') }
    catch { toast.error('Could not clear history') }
  }

  if (isPending) return <SkeletonCards count={8} className="xl:grid-cols-4" />
  if (!history.length) return <Empty label="No watch history yet. Videos you play show up here." />

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search watch history" className="pl-9" />
        </div>
        <Button variant="outline" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => setConfirmClear(true)}>
          <Trash2 className="size-4" /> Clear all history
        </Button>
      </div>

      {!groups.length ? (
        <Empty label={`No history matches “${q}”.`} />
      ) : (
        <div className="space-y-8">
          {groups.map(g => (
            <section key={g.label}>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{g.label}</h3>
              <div className={GRID}>
                {g.rows.map(h => {
                  const item = historyToItem(h)
                  return (
                    <div key={h.videoId} className="group relative">
                      <VideoCard item={item} />
                      <AddToPlaylistButton video={toVid(item)} className={cn(cardAddBtnClass, 'right-11')} />
                      <button onClick={() => void remove(h.videoId)}
                        className="absolute right-2 top-2 hidden rounded-full bg-black/70 p-1.5 text-white hover:bg-black/90 group-hover:flex" aria-label="Remove from history">
                        <X className="size-3.5" />
                      </button>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      <ConfirmDialog open={confirmClear} onOpenChange={setConfirmClear} title="Clear all watch history?"
        description="This removes every video from your history and resets their resume positions." destructive
        confirmLabel="Clear all" onConfirm={() => void clearAll()} />
    </div>
  )
}

// Everything saved for offline, findable regardless of the app's Online/Offline mode.
function SavedTab() {
  const qc = useQueryClient()
  const { data: downloads = [], isPending } = useYtDownloads()
  // In-flight saves (queued or downloading) show at the top with a live progress bar, so a
  // fresh "Save offline" is visible here immediately instead of only once it finishes.
  const inFlight = useMemo(() => downloads.filter(r => r.status === 'pending' || r.status === 'downloading'), [downloads])
  const ready = useMemo(() => downloads.filter(r => r.status === 'ready'), [downloads])
  const rows = useMemo(() => ready.map(r => ({ id: r.id, item: savedToItem(r, qualityBadge(r.kind, r.maxHeight)) })), [ready])
  const totalBytes = useMemo(() => ready.reduce((n, r) => n + (r.sizeBytes ?? 0), 0), [ready])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [syncingPlex, setSyncingPlex] = useState(false)

  const toggle = (id: string) => setSelected(s => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next })
  const allSelected = rows.length > 0 && selected.size === rows.length

  // Manual trigger while the Plex export feature is new (automatic sync on save/prune
  // is a separate, later piece of the same feature). Requires a Plex library already
  // provisioned for this user (Admin → Plex) — the backend now fails loudly with a real
  // error if not, rather than silently enqueueing jobs that no-op (that used to look
  // identical to success: "completed" jobs that did nothing because the library didn't
  // exist yet when they ran).
  const syncToPlex = async () => {
    setSyncingPlex(true)
    try {
      const res = await fetch('/api/youtube/plex/sync-all', { method: 'POST', credentials: 'include' })
      const data = await res.json() as { ok: boolean; enqueued?: number; error?: string }
      if (data.ok) toast.success(`Syncing ${data.enqueued} video${data.enqueued === 1 ? '' : 's'} to Plex`)
      else toast.error(data.error ?? 'Could not start Plex sync')
    } catch {
      toast.error('Could not start Plex sync')
    } finally {
      setSyncingPlex(false)
    }
  }

  const clear = async (ids: string[]) => {
    setBusy(true)
    try {
      await deleteDownloads(ids)
      setSelected(new Set())
      await qc.invalidateQueries({ queryKey: ['yt-downloads'] })
      toast.success(ids.length === 1 ? 'Removed from offline' : `Removed ${ids.length} from offline`)
    } catch {
      toast.error('Could not remove')
    } finally {
      setBusy(false)
    }
  }

  if (isPending) return <SkeletonCards count={8} className="xl:grid-cols-4" />
  if (!rows.length && !inFlight.length) return <Empty label="Nothing saved offline yet. Use “Save for offline” on any video." />
  return (
    <>
      <p className="mb-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          {inFlight.length > 0 && <>{inFlight.length} downloading{rows.length ? ' · ' : ''}</>}
          {rows.length > 0 && <>{rows.length} video{rows.length === 1 ? '' : 's'}{totalBytes ? ` · ${fmtBytes(totalBytes)}` : ''} saved offline</>}
        </span>
        <Button variant="outline" size="sm" disabled={syncingPlex} onClick={syncToPlex}>
          Sync to Plex
        </Button>
      </p>
      {inFlight.length > 0 && (
        <div className={cn(GRID, 'mb-6')}>
          {inFlight.map(r => <DownloadingCard key={r.id} row={r} />)}
        </div>
      )}
      {rows.length > 0 && (
        <>
          <OfflineSelectionToolbar
            totalCount={rows.length}
            selectedCount={selected.size}
            allSelected={allSelected}
            busy={busy}
            itemLabel="video"
            onToggleSelectAll={() => setSelected(allSelected ? new Set() : new Set(rows.map(r => r.id)))}
            onClearSelected={() => clear([...selected])}
            onClearAll={() => clear(rows.map(r => r.id))}
          />
          <div className={cn(GRID, 'mt-4')}>
            {rows.map(({ id, item }) => (
              <div key={item.videoId + (item.localKind ?? '')} className="group relative">
                <button
                  type="button"
                  onClick={() => toggle(id)}
                  className={cn('absolute left-2 top-2 z-10 flex size-6 items-center justify-center rounded-full border-2 transition-colors',
                    selected.has(id) ? 'border-[var(--yt-accent)] bg-[var(--yt-accent)]' : 'border-white/70 bg-black/40 opacity-0 group-hover:opacity-100')}
                  aria-label={selected.has(id) ? 'Deselect' : 'Select'}
                >
                  {selected.has(id) && <span className="size-2 rounded-full bg-white" />}
                </button>
                <VideoCard item={item} />
                <AddToPlaylistButton video={toVid(item)} className={cardAddBtnClass} />
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}

// A save that's still downloading: same card shape as a finished one, but greyed out,
// non-navigating (nothing to play yet), with a live progress bar + percentage overlay.
function DownloadingCard({ row }: { row: SavedRow }) {
  const pct = row.progress != null ? Math.round(row.progress * 100) : null
  const label = row.status === 'downloading' ? (pct != null ? `Downloading ${pct}%` : 'Downloading…') : 'Queued…'
  return (
    <div className="flex flex-col gap-2.5">
      <div className="relative aspect-video overflow-hidden rounded-card bg-muted">
        <VideoThumb videoId={row.videoId} title={row.title} className="size-full grayscale" />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/55 text-white">
          <Spinner size="lg" className="text-white" />
          <span className="text-xs font-semibold">{label}</span>
        </div>
        {/* Live progress bar along the bottom (indeterminate shimmer until bytes flow). */}
        {/* design-ok(adhoc-pulse): indeterminate download-progress bar, pulses only until real bytes arrive */}
        <div className="absolute inset-x-0 bottom-0 h-1 bg-black/40">
          <div
            className={cn('h-full bg-[var(--yt-accent)] transition-[width] duration-500', pct == null && 'animate-pulse')}
            style={{ width: pct != null ? `${Math.max(4, pct)}%` : '35%' }}
          />
        </div>
      </div>
      <div className="min-w-0">
        <p className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">{row.title || row.videoId}</p>
        {row.author && <p className="mt-1 truncate text-xs text-muted-foreground">{row.author}</p>}
      </div>
    </div>
  )
}

function PlaylistsTab() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['yt-playlists'], queryFn: listYtPlaylists })
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const create = async () => {
    const n = name.trim()
    if (!n) return
    try { await createYtPlaylist({ name: n }); await qc.invalidateQueries({ queryKey: ['yt-playlists'] }); toast.success('Playlist created'); setCreating(false); setName('') }
    catch { toast.error('Could not create playlist') }
  }
  const all = [...(data?.mine ?? []), ...(data?.shared ?? [])]
  const [syncingCollections, setSyncingCollections] = useState(false)
  const syncCollectionsToPlex = async () => {
    setSyncingCollections(true)
    try {
      await fetch('/api/youtube/plex/sync-collections', { method: 'POST', credentials: 'include' })
      toast.success('Syncing playlists to Plex Collections')
    } catch {
      toast.error('Could not start Plex collections sync')
    } finally {
      setSyncingCollections(false)
    }
  }
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <Button size="sm" onClick={() => { setName(''); setCreating(true) }}><Plus className="size-4" /> New playlist</Button>
        <Button variant="outline" size="sm" disabled={syncingCollections} onClick={syncCollectionsToPlex}>
          Sync collections to Plex
        </Button>
      </div>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>New playlist</DialogTitle></DialogHeader>
          <Input value={name} autoFocus placeholder="Playlist name" onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void create() }} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button onClick={create} disabled={!name.trim()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {!all.length ? <Empty label="Create a playlist to collect your favorite videos." /> : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {all.map(p => (
            <Card key={p.id} variant="interactive" className="p-3" onClick={() => navigate(`/youtube/my-playlist/${p.id}`)}>
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
  )
}

function CollectionTab({ kind, empty }: { kind: 'watch-later' | 'liked'; empty: string }) {
  const list = useCollection(kind)
  if (!list.length) return <Empty label={empty} />
  return (
    <div className={GRID}>
      {list.map(m => (
        <div key={m.videoId} className="group relative">
          <VideoCard item={metaToItem(m)} />
          <AddToPlaylistButton video={toVid(metaToItem(m))} className={cn(cardAddBtnClass, 'right-11')} />
          <button onClick={() => { removeFromCollection(kind, m.videoId); toast.success('Removed') }}
            className="absolute right-2 top-2 hidden rounded-full bg-black/70 p-1.5 text-white hover:bg-black/90 group-hover:flex" aria-label="Remove">
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}

function Empty({ label }: { label: string }) {
  return <p className="py-24 text-center text-sm text-muted-foreground">{label}</p>
}
