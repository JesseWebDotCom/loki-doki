import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Link2, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { OfflineSelectionToolbar } from '@/components/shared/OfflineSelectionToolbar'
import { SkeletonCards } from '@/components/shared/SkeletonBlocks'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'
import { proxyImg } from '@/lib/img'
import { SourceChip, MineChip } from '@/components/videos/SourceChip'
import { HubCard } from '@/components/videos/HubCard'
import { HubVideoCard } from '@/components/videos/HubVideoCard'
import { MineCard } from '@/components/videos/MineCard'
import { AddToPlaylistButton } from '@/components/youtube/AddToPlaylistButton'
import { VideoThumb } from '@/components/youtube/media'
import { SOURCE_META, MINE_META } from '@/lib/videos/sources'
import { deleteSave, listSaves, type HubVideoItem, type VideoSource } from '@/lib/videos/api'
import { listClips, clipFileUrl, type Clip } from '@/lib/clipper/api'
import { listStudioBin, isMineBinItem } from '@/lib/videos/studioApi'
import { useYtDownloads } from '@/lib/youtube/useData'
import { deleteDownloads, cancelDownloads, type SavedRow } from '@/lib/youtube/api'
import { savedToItem } from '@/lib/youtube/types'
import { qualityBadge, fmtBytes } from '@/lib/youtube/format'
import { ytItemToHub } from '@/components/videos/HubCard'

// 'link' doubles as the badge for Clip a Link saves below — they're the same idea (paste any
// URL, keep it offline), just a separate legacy table under the hood. No standalone "Clips"
// filter: it's not a source of its own, so it rides the existing 'link' pill.
type OfflineFilter = 'all' | 'mine' | VideoSource
const SOURCE_FILTERS: VideoSource[] = ['youtube', 'reddit', 'tiktok', 'vimeo', 'link']

interface OfflineEntry {
  key: string
  kind: 'yt' | 'hub'
  id: string
  item: HubVideoItem
  sizeBytes: number | null
}

const toVid = (item: HubVideoItem) => ({
  videoId: item.id, title: item.title, author: item.creator?.name ?? undefined,
  channelId: item.creator?.id ?? undefined, durationSec: item.durationSec ?? undefined,
  videoSource: item.source, thumbnailUrl: item.thumbnailUrl,
})

function fmtDur(sec: number | null): string | null {
  if (sec == null || sec <= 0) return null
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

// A save that's still downloading: greyed out, non-navigating, with a live progress bar.
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

/** Clips saved through Clip a Link (a separate legacy table, no delete API yet — so unlike
 *  every other card here, this one has no select checkbox). Badged and sized like every
 *  other card so it sits in the same grid without looking like an outlier. */
function ClipCard({ clip }: { clip: Clip }) {
  const badge = SOURCE_META.link
  const dur = fmtDur(clip.durationSeconds)
  return (
    <a href={clipFileUrl(clip.id)} target="_blank" rel="noreferrer noopener" className="group flex flex-col gap-2.5">
      <div className="relative aspect-video w-full overflow-hidden rounded-card bg-muted">
        {clip.thumbnailUrl ? (
          <img src={proxyImg(clip.thumbnailUrl)} alt="" loading="lazy" className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.03]" />
        ) : (
          <div className="flex size-full items-center justify-center"><Link2 className="size-7 text-muted-foreground/50" /></div>
        )}
        <span className={cn('absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold', badge.badgeClass)}>
          <badge.icon className="size-2.5" aria-hidden /> {badge.label}
        </span>
        {dur && <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/80 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">{dur}</span>}
      </div>
      <div className="min-w-0">
        <p className="line-clamp-2 text-sm font-semibold leading-snug">{clip.title || 'Clip'}</p>
        {clip.extractor && <p className="mt-0.5 text-xs capitalize text-muted-foreground">{clip.extractor}</p>}
      </div>
    </a>
  )
}

// Cross-source Offline library: one flat, badge-annotated grid across every source, with
// filter pills to narrow it down instead of splitting the page into per-source sections.
export function VideosOfflinePage() {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<OfflineFilter>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [syncingPlex, setSyncingPlex] = useState(false)

  const { data: downloads = [], isPending: ytPending } = useYtDownloads()
  const { data: savesData, isPending: hubPending } = useQuery({ queryKey: ['videos-saves', 'all'], queryFn: () => listSaves() })
  const { data: clipsData, isPending: clipsPending } = useQuery({ queryKey: ['clipper-clips'], queryFn: listClips })
  const { data: mineBin, isPending: minePending } = useQuery({ queryKey: ['studio-bin'], queryFn: listStudioBin })

  const ytInFlight = useMemo(() => downloads.filter((r) => r.status === 'pending' || r.status === 'downloading'), [downloads])
  const ytReady = useMemo(() => downloads.filter((r) => r.status === 'ready'), [downloads])
  const hubSaves = savesData?.saves ?? []
  const clips = useMemo(() => (clipsData ?? []).filter((c) => c.status === 'ready'), [clipsData])
  const mineItems = useMemo(() => (mineBin?.items ?? []).filter(isMineBinItem), [mineBin])

  const counts = useMemo(() => {
    const m = new Map<VideoSource, number>()
    if (ytReady.length) m.set('youtube', ytReady.length)
    for (const s of hubSaves) if (s.status === 'ready') m.set(s.source, (m.get(s.source) ?? 0) + 1)
    if (clips.length) m.set('link', (m.get('link') ?? 0) + clips.length)
    return m
  }, [ytReady, hubSaves, clips])

  const entries = useMemo<OfflineEntry[]>(() => {
    const yt = ytReady.map((r): OfflineEntry => ({
      key: `yt:${r.id}`, kind: 'yt', id: r.id,
      item: ytItemToHub(savedToItem(r, qualityBadge(r.kind, r.maxHeight))),
      sizeBytes: r.sizeBytes,
    }))
    const hub = hubSaves.filter((s) => s.status === 'ready').map((s): OfflineEntry => ({
      key: `hub:${s.id}`, kind: 'hub', id: s.id,
      item: {
        source: s.source, id: s.videoId, url: '', title: s.title,
        creator: s.creatorName ? { id: '', name: s.creatorName } : null,
        thumbnailUrl: s.thumbnailUrl, durationSec: s.durationSec,
      },
      sizeBytes: s.sizeBytes ?? null,
    }))
    return [...yt, ...hub].filter((e) => filter === 'all' || e.item.source === filter)
  }, [ytReady, hubSaves, filter])

  const visibleInFlight = filter === 'all' || filter === 'youtube' ? ytInFlight : []
  const visibleClips = filter === 'all' || filter === 'link' ? clips : []
  const visibleMine = filter === 'all' || filter === 'mine' ? mineItems : []

  const totalBytes = useMemo(
    () => entries.reduce((n, e) => n + (e.sizeBytes ?? 0), 0) + visibleClips.reduce((n, c) => n + (c.sizeBytes ?? 0), 0),
    [entries, visibleClips],
  )

  const toggle = (key: string) => setSelected((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })
  const allSelected = entries.length > 0 && selected.size === entries.length

  const clearSelection = async (keys: string[]) => {
    setBusy(true)
    try {
      const ytIds = keys.filter((k) => k.startsWith('yt:')).map((k) => k.slice(3))
      const hubIds = keys.filter((k) => k.startsWith('hub:')).map((k) => k.slice(4))
      await Promise.all([
        ...(ytIds.length ? [deleteDownloads(ytIds)] : []),
        ...hubIds.map((id) => deleteSave(id)),
      ])
      setSelected(new Set())
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['yt-downloads'] }),
        qc.invalidateQueries({ queryKey: ['videos-saves', 'all'] }),
      ])
      toast.success(keys.length === 1 ? 'Removed from offline' : `Removed ${keys.length} from offline`)
    } catch {
      toast.error('Could not remove')
    } finally {
      setBusy(false)
    }
  }

  const cancelYt = async (id: string) => {
    try {
      await cancelDownloads([id])
      await qc.invalidateQueries({ queryKey: ['yt-downloads'] })
      toast.success('Save canceled')
    } catch { toast.error('Could not cancel') }
  }

  // Manual trigger while the Plex export feature is new. Requires a Plex library already
  // provisioned for this user (Admin → Plex); syncs every save regardless of the current
  // filter, so it stays visible whenever any exist. YouTube rides its own exporter route;
  // the other sources share the generic one — each leg only runs when it has saves, and a
  // "no library provisioned" failure from one leg doesn't hide the other's success.
  const hubReadyCount = hubSaves.filter((s) => s.status === 'ready').length
  const syncToPlex = async () => {
    setSyncingPlex(true)
    try {
      type SyncResult = { ok: boolean; enqueued?: number; error?: string }
      const legs: Promise<SyncResult>[] = []
      if (ytReady.length) legs.push(fetch('/api/youtube/plex/sync-all', { method: 'POST', credentials: 'include' }).then((r) => r.json() as Promise<SyncResult>))
      if (hubReadyCount) legs.push(fetch('/api/videos/plex/sync-all', { method: 'POST', credentials: 'include' }).then((r) => r.json() as Promise<SyncResult>))
      const results = await Promise.all(legs)
      const enqueued = results.reduce((n, r) => n + (r.ok ? (r.enqueued ?? 0) : 0), 0)
      if (enqueued > 0) toast.success(`Syncing ${enqueued} video${enqueued === 1 ? '' : 's'} to Plex`)
      else toast.error(results.find((r) => !r.ok)?.error ?? 'Could not start Plex sync')
    } catch {
      toast.error('Could not start Plex sync')
    } finally {
      setSyncingPlex(false)
    }
  }

  const isPending = ytPending || hubPending || clipsPending || minePending
  const isEmpty = !visibleInFlight.length && !entries.length && !visibleClips.length && !visibleMine.length
  const totalVisible = entries.length + visibleClips.length + visibleMine.length

  return (
    <PageContainer width="wide" className="pt-1 pb-8">
      <PageHeader title="Offline" icon={Download} subtitle="Everything saved to this server." className="pt-4 pb-4" />

      <ChipRow className="mb-6">
        <MineChip active={filter === 'mine'} onClick={() => setFilter(filter === 'mine' ? 'all' : 'mine')} />
        <Chip label="All" active={filter === 'all'} onClick={() => setFilter('all')} />
        {SOURCE_FILTERS.map((s) => (
          (s === 'youtube' || (counts.get(s) ?? 0) > 0) &&
            <SourceChip key={s} source={s} active={filter === s} onClick={() => setFilter(filter === s ? 'all' : s)} />
        ))}
      </ChipRow>

      {isPending ? (
        <SkeletonCards count={8} className="xl:grid-cols-4" />
      ) : isEmpty ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          {filter === 'all' ? 'Nothing saved offline yet. Use “Save offline” on any video.' : `Nothing saved from ${filter === 'mine' ? MINE_META.label : SOURCE_META[filter].label} yet.`}
        </p>
      ) : (
        <>
          {totalVisible > 0 && (
            <p className="mb-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>
                {visibleInFlight.length > 0 && <>{visibleInFlight.length} downloading · </>}
                {totalVisible} video{totalVisible === 1 ? '' : 's'}{totalBytes ? ` · ${fmtBytes(totalBytes)}` : ''} saved offline
              </span>
              {(ytReady.length > 0 || hubReadyCount > 0) && (
                <Button variant="outline" size="sm" disabled={syncingPlex} onClick={syncToPlex}>
                  Sync to Plex
                </Button>
              )}
            </p>
          )}

          {visibleInFlight.length > 0 && (
            <div className="mb-6 grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-4">
              {visibleInFlight.map((r) => <DownloadingCard key={r.id} row={r} onCancel={() => void cancelYt(r.id)} />)}
            </div>
          )}

          {entries.length > 0 && (
            <OfflineSelectionToolbar
              totalCount={entries.length}
              selectedCount={selected.size}
              allSelected={allSelected}
              busy={busy}
              itemLabel="video"
              onToggleSelectAll={() => setSelected(allSelected ? new Set() : new Set(entries.map((e) => e.key)))}
              onClearSelected={() => clearSelection([...selected])}
              onClearAll={() => clearSelection(entries.map((e) => e.key))}
            />
          )}

          <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 xl:grid-cols-4">
            {entries.map((e) => (
              <div key={e.key} className="group relative">
                <button
                  type="button"
                  onClick={() => toggle(e.key)}
                  aria-label={selected.has(e.key) ? 'Deselect' : 'Select'}
                  className={cn('absolute left-2 top-2 z-10 flex size-6 items-center justify-center rounded-full border-2 transition-colors',
                    selected.has(e.key) ? 'border-[var(--yt-accent)] bg-[var(--yt-accent)]' : 'border-white/70 bg-black/40 opacity-0 group-hover:opacity-100')}
                >
                  {selected.has(e.key) && <span className="size-2 rounded-full bg-white" />}
                </button>
                {e.kind === 'yt' ? <HubCard item={e.item} shape="wide" /> : <HubVideoCard item={e.item} interactive={false} />}
                <AddToPlaylistButton video={toVid(e.item)} className="absolute right-2 top-2 hidden size-7 bg-black/70 text-white opacity-100 hover:bg-black/90 group-hover:flex" />
              </div>
            ))}
            {visibleClips.map((c) => <ClipCard key={c.id} clip={c} />)}
            {visibleMine.map((item) => (
              <div key={item.assetId} className="group relative">
                <MineCard item={item} />
                <AddToPlaylistButton
                  video={{ videoId: item.assetId, title: item.title, durationSec: item.durationSec ?? undefined, videoSource: 'mine', thumbnailUrl: item.thumbUrl }}
                  className="absolute right-2 top-2 hidden size-7 bg-black/70 text-white opacity-100 hover:bg-black/90 group-hover:flex" />
              </div>
            ))}
          </div>
        </>
      )}
    </PageContainer>
  )
}
