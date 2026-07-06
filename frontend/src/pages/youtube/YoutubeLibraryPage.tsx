import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock, Heart, History, Trash2, ListVideo, Plus, Search, X, type LucideIcon } from 'lucide-react'
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
import { getHistoryFull, deleteDownloads, cancelDownloads, clearHistory, removeHistoryItem, type HistoryRow, type SavedRow } from '@/lib/youtube/api'
import { savedToItem, historyToItem, type VideoItem } from '@/lib/youtube/types'
import { qualityBadge, fmtBytes } from '@/lib/youtube/format'
import { VideoThumb } from '@/components/youtube/media'
import { useCollection, removeFromCollection, type SavedVideoMeta } from '@/lib/youtube/collections'
import { listYtPlaylists, createYtPlaylist } from '@/lib/youtube/playlists'
import { VideoCollection, YT_GRID as GRID } from '@/components/youtube/VideoCollection'
import { ViewToggle } from '@/components/shared/ViewToggle'
import { useViewPreference } from '@/hooks/useViewPreference'
import { PlaylistCover } from '@/components/youtube/PlaylistCover'
import { AddToPlaylistButton } from '@/components/youtube/AddToPlaylistButton'

const cardAddBtnClass = 'absolute right-2 top-2 hidden size-7 bg-black/70 text-white opacity-100 hover:bg-black/90 group-hover:flex'
const toVid = (item: VideoItem) => ({ videoId: item.videoId, title: item.title, author: item.author ?? undefined, channelId: item.channelId ?? undefined, durationSec: item.durationSec ?? undefined })

const metaToItem = (m: SavedVideoMeta): VideoItem => ({ videoId: m.videoId, title: m.title, author: m.author, channelId: m.channelId, channelThumb: m.channelThumb, durationSec: m.durationSec })

// Each library section is its own page/route with its own header: click "History"
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
export { LibraryPage }

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
  const { data: full, isPending } = useQuery({ queryKey: ['yt-history-full'], queryFn: getHistoryFull })
  const history = full?.history ?? []
  const accountHistory = full?.accountHistory ?? []
  const [q, setQ] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [view, setView] = useViewPreference('youtube.library_history_view', 'grid')

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return history
    return history.filter(h => (h.title ?? '').toLowerCase().includes(needle) || (h.author ?? '').toLowerCase().includes(needle))
  }, [history, q])
  const groups = useMemo(() => groupHistoryByDate(filtered), [filtered])

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
  if (!history.length && !accountHistory.length) return <Empty label="No watch history yet. Videos you play show up here." />

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
        <ViewToggle value={view} onChange={setView} className="ml-auto shrink-0" />
      </div>

      {!groups.length ? (
        <Empty label={`No history matches “${q}”.`} />
      ) : (
        <div className="space-y-8">
          {groups.map(g => (
            <section key={g.label}>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{g.label}</h3>
              <VideoCollection items={g.rows.map(historyToItem)} view={view} wrap={(item, node) => (
                <div className="group relative">
                  {node}
                  <AddToPlaylistButton video={toVid(item)} className={cn(cardAddBtnClass, 'right-11')} />
                  <button onClick={() => void remove(item.videoId)}
                    className="absolute right-2 top-2 hidden rounded-full bg-black/70 p-1.5 text-white hover:bg-black/90 group-hover:flex" aria-label="Remove from history">
                    <X className="size-3.5" />
                  </button>
                </div>
              )} />
            </section>
          ))}
        </div>
      )}

      {accountHistory.length > 0 && (
        <section className="mt-10">
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">Watched on your YouTube account</h3>
          <VideoCollection
            items={accountHistory.map(v => ({
              videoId: v.videoId, title: v.title, author: v.author,
              channelId: v.channelId, durationSec: v.durationSec,
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

// Everything saved for offline, findable regardless of the app's Online/Offline mode.
export function SavedTab() {
  const qc = useQueryClient()
  const { data: downloads = [], isPending } = useYtDownloads()
  // In-flight saves (queued or downloading) show at the top with a live progress bar, so a
  // fresh "Save offline" is visible here immediately instead of only once it finishes.
  const inFlight = useMemo(() => downloads.filter(r => r.status === 'pending' || r.status === 'downloading'), [downloads])
  const ready = useMemo(() => downloads.filter(r => r.status === 'ready'), [downloads])
  const rows = useMemo(() => ready.map(r => ({ id: r.id, item: savedToItem(r, qualityBadge(r.kind, r.maxHeight)) })), [ready])
  // Map each rendered card back to its download-ref id (selection is keyed by ref, not videoId).
  const idByKey = useMemo(() => new Map(rows.map(r => [r.item.videoId + (r.item.localKind ?? ''), r.id])), [rows])
  const totalBytes = useMemo(() => ready.reduce((n, r) => n + (r.sizeBytes ?? 0), 0), [ready])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [syncingPlex, setSyncingPlex] = useState(false)
  const [view, setView] = useViewPreference('youtube.library_saved_view', 'grid')

  const toggle = (id: string) => setSelected(s => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next })
  const allSelected = rows.length > 0 && selected.size === rows.length

  // Manual trigger while the Plex export feature is new (automatic sync on save/prune
  // is a separate, later piece of the same feature). Requires a Plex library already
  // provisioned for this user (Admin → Plex); the backend now fails loudly with a real
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

  const cancel = async (id: string) => {
    try {
      await cancelDownloads([id])
      await qc.invalidateQueries({ queryKey: ['yt-downloads'] })
      toast.success('Save canceled')
    } catch { toast.error('Could not cancel') }
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
        <span className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={syncingPlex} onClick={syncToPlex}>
            Sync to Plex
          </Button>
          {rows.length > 0 && <ViewToggle value={view} onChange={setView} className="shrink-0" />}
        </span>
      </p>
      {inFlight.length > 0 && (
        <div className={cn(GRID, 'mb-6')}>
          {inFlight.map(r => <DownloadingCard key={r.id} row={r} onCancel={() => void cancel(r.id)} />)}
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
          <VideoCollection items={rows.map(r => r.item)} view={view} className="mt-4" wrap={(item, node) => {
            const id = idByKey.get(item.videoId + (item.localKind ?? ''))
            return (
              <div className="group relative">
                {id && (
                  <button
                    type="button"
                    onClick={() => toggle(id)}
                    className={cn('absolute left-2 top-2 z-10 flex size-6 items-center justify-center rounded-full border-2 transition-colors',
                      selected.has(id) ? 'border-[var(--yt-accent)] bg-[var(--yt-accent)]' : 'border-white/70 bg-black/40 opacity-0 group-hover:opacity-100')}
                    aria-label={selected.has(id) ? 'Deselect' : 'Select'}
                  >
                    {selected.has(id) && <span className="size-2 rounded-full bg-white" />}
                  </button>
                )}
                {node}
                <AddToPlaylistButton video={toVid(item)} className={cardAddBtnClass} />
              </div>
            )
          }} />
        </>
      )}
    </>
  )
}

// A save that's still downloading: same card shape as a finished one, but greyed out,
// non-navigating (nothing to play yet), with a live progress bar + percentage overlay.
function DownloadingCard({ row, onCancel }: { row: SavedRow; onCancel?: () => void }) {
  const pct = row.progress != null ? Math.round(row.progress * 100) : null
  const label = row.status === 'downloading' ? (pct != null ? `Downloading ${pct}%` : 'Downloading…') : 'Queued…'
  return (
    <div className="group flex flex-col gap-2.5">
      <div className="relative aspect-video overflow-hidden rounded-card bg-muted">
        <VideoThumb videoId={row.videoId} title={row.title} className="size-full grayscale" />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/55 text-white">
          <Spinner size="lg" className="text-white" />
          <span className="text-xs font-semibold">{label}</span>
        </div>
        {onCancel && (
          <button type="button" onClick={onCancel} title="Cancel download" aria-label="Cancel download"
            className="absolute right-1.5 top-1.5 z-10 grid size-7 place-items-center rounded-full bg-black/70 text-white opacity-0 transition hover:bg-black/90 group-hover:opacity-100">
            <X className="size-3.5" />
          </button>
        )}
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
  )
}

function CollectionTab({ kind, empty }: { kind: 'watch-later' | 'liked'; empty: string }) {
  const list = useCollection(kind)
  const [view, setView] = useViewPreference(`youtube.library_${kind}_view`, 'grid')
  if (!list.length) return <Empty label={empty} />
  return (
    <div>
      <div className="mb-4 flex justify-end">
        <ViewToggle value={view} onChange={setView} className="shrink-0" />
      </div>
      <VideoCollection items={list.map(metaToItem)} view={view} wrap={(item, node) => (
        <div className="group relative">
          {node}
          <AddToPlaylistButton video={toVid(item)} className={cn(cardAddBtnClass, 'right-11')} />
          <button onClick={() => { removeFromCollection(kind, item.videoId); toast.success('Removed') }}
            className="absolute right-2 top-2 hidden rounded-full bg-black/70 p-1.5 text-white hover:bg-black/90 group-hover:flex" aria-label="Remove">
            <Trash2 className="size-3.5" />
          </button>
        </div>
      )} />
    </div>
  )
}

function Empty({ label }: { label: string }) {
  return <p className="py-24 text-center text-sm text-muted-foreground">{label}</p>
}
