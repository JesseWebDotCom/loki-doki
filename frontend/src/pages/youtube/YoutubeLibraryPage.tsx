import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock, Heart, History, Trash2, Download } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SkeletonCards } from '@/components/shared/SkeletonBlocks'
import { OfflineSelectionToolbar } from '@/components/shared/OfflineSelectionToolbar'
import { useYtDownloads } from '@/lib/youtube/useData'
import { getHistory, deleteDownloads } from '@/lib/youtube/api'
import { savedToItem, historyToItem, type VideoItem } from '@/lib/youtube/types'
import { qualityBadge, fmtBytes } from '@/lib/youtube/format'
import { useCollection, removeFromCollection, type SavedVideoMeta } from '@/lib/youtube/collections'
import { VideoCard } from '@/components/youtube/VideoCard'

type Tab = 'history' | 'watch-later' | 'liked' | 'saved'
const TABS: { key: Tab; label: string; icon: typeof Clock }[] = [
  { key: 'history', label: 'History', icon: History },
  { key: 'watch-later', label: 'Watch Later', icon: Clock },
  { key: 'liked', label: 'Liked', icon: Heart },
  { key: 'saved', label: 'Offline', icon: Download },
]

const GRID = 'grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-4'
const metaToItem = (m: SavedVideoMeta): VideoItem => ({ videoId: m.videoId, title: m.title, author: m.author, channelId: m.channelId, channelThumb: m.channelThumb, durationSec: m.durationSec })

export function YoutubeLibraryPage() {
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) ?? 'history'

  return (
    <PageContainer width="wide" className="pb-6">
      <PageHeader title="Library" className="pt-6 pb-5" />
      <div className="mb-6 flex gap-1 border-b border-border/50">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setParams({ tab: t.key })}
            className={cn('-mb-px flex items-center gap-2 border-b-2 px-3.5 py-2.5 text-sm font-semibold transition-colors',
              tab === t.key ? 'border-[var(--yt-accent)] text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            <t.icon className="size-4" /> {t.label}
          </button>
        ))}
      </div>
      {tab === 'watch-later' ? <CollectionTab kind="watch-later" empty="Nothing in Watch Later yet." />
        : tab === 'liked' ? <CollectionTab kind="liked" empty="No liked videos yet." />
        : tab === 'saved' ? <SavedTab />
        : <HistoryTab />}
    </PageContainer>
  )
}

function HistoryTab() {
  const { data: history = [], isPending } = useQuery({ queryKey: ['yt-history'], queryFn: getHistory })
  if (isPending) return <SkeletonCards count={8} className="xl:grid-cols-4" />
  if (!history.length) return <Empty label="No watch history yet. Videos you play show up here." />
  return <div className={GRID}>{history.map(h => <VideoCard key={h.videoId} item={historyToItem(h)} />)}</div>
}

// Everything saved for offline, findable regardless of the app's Online/Offline mode.
function SavedTab() {
  const qc = useQueryClient()
  const { data: downloads = [], isPending } = useYtDownloads()
  const ready = useMemo(() => downloads.filter(r => r.status === 'ready'), [downloads])
  const rows = useMemo(() => ready.map(r => ({ id: r.id, item: savedToItem(r, qualityBadge(r.kind, r.maxHeight)) })), [ready])
  const totalBytes = useMemo(() => ready.reduce((n, r) => n + (r.sizeBytes ?? 0), 0), [ready])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const toggle = (id: string) => setSelected(s => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next })
  const allSelected = rows.length > 0 && selected.size === rows.length

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
  if (!rows.length) return <Empty label="Nothing saved offline yet. Use “Save for offline” on any video." />
  return (
    <>
      <p className="mb-3 text-xs text-muted-foreground">
        {rows.length} video{rows.length === 1 ? '' : 's'}{totalBytes ? ` · ${fmtBytes(totalBytes)}` : ''} saved offline
      </p>
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
          </div>
        ))}
      </div>
    </>
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
