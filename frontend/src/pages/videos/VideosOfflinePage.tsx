import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Link2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { OfflineSelectionToolbar } from '@/components/shared/OfflineSelectionToolbar'
import { toast } from '@/lib/toast'
import { proxyImg } from '@/lib/img'
import { SavedTab } from '@/pages/youtube/YoutubeLibraryPage'
import { SourceChip } from '@/components/videos/SourceChip'
import { HubVideoCard } from '@/components/videos/HubVideoCard'
import { deleteSave, listSaves, type VideoSource } from '@/lib/videos/api'
import { listClips, clipFileUrl, type Clip } from '@/lib/clipper/api'

type OfflineFilter = 'all' | 'youtube' | 'reddit' | 'tiktok' | 'vimeo' | 'clips'
const SOURCE_FILTERS: VideoSource[] = ['youtube', 'reddit', 'tiktok', 'vimeo']

/** Offline saves for one non-YouTube source, with the same bulk-select model as YouTube:
 *  hover a saved item to reveal its checkbox, plus a Select-all / Clear toolbar. */
function SourceSaves({ source }: { source: Exclude<VideoSource, 'youtube'> }) {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['videos-saves', 'all'], queryFn: () => listSaves() })
  const saves = (data?.saves ?? []).filter((s) => s.source === source)
  const ready = saves.filter((s) => s.status === 'ready')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const allSelected = ready.length > 0 && selected.size === ready.length
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const clear = async (ids: string[]) => {
    setBusy(true)
    try {
      await Promise.all(ids.map((id) => deleteSave(id)))
      setSelected(new Set())
      await qc.invalidateQueries({ queryKey: ['videos-saves', 'all'] })
      toast.success(ids.length === 1 ? 'Removed from offline' : `Removed ${ids.length} from offline`)
    } catch { toast.error('Could not remove') } finally { setBusy(false) }
  }

  if (saves.length === 0) {
    return <p className="py-16 text-center text-sm text-muted-foreground">Nothing saved from this source yet.</p>
  }
  return (
    <>
      {ready.length > 0 && (
        <OfflineSelectionToolbar
          totalCount={ready.length}
          selectedCount={selected.size}
          allSelected={allSelected}
          busy={busy}
          itemLabel="video"
          onToggleSelectAll={() => setSelected(allSelected ? new Set() : new Set(ready.map((s) => s.id)))}
          onClearSelected={() => clear([...selected])}
          onClearAll={() => clear(ready.map((s) => s.id))}
        />
      )}
      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 xl:grid-cols-4">
        {saves.map((s) => (
          <div key={s.id} className="group relative">
            {s.status === 'ready' && (
              <button
                type="button"
                onClick={() => toggle(s.id)}
                aria-label={selected.has(s.id) ? 'Deselect' : 'Select'}
                className={cn('absolute left-2 top-2 z-10 flex size-6 items-center justify-center rounded-full border-2 transition-colors',
                  selected.has(s.id) ? 'border-[var(--yt-accent)] bg-[var(--yt-accent)]' : 'border-white/70 bg-black/40 opacity-0 group-hover:opacity-100')}
              >
                {selected.has(s.id) && <span className="size-2 rounded-full bg-white" />}
              </button>
            )}
            <HubVideoCard
              showSource={false}
              interactive={false}
              savingLabel={s.status === 'ready' ? undefined : s.status === 'failed' ? 'Failed' : 'Saving…'}
              item={{
                source: s.source, id: s.videoId, url: '', title: s.title,
                creator: s.creatorName ? { id: '', name: s.creatorName } : null,
                thumbnailUrl: s.thumbnailUrl, durationSec: s.durationSec,
              }}
            />
          </div>
        ))}
      </div>
    </>
  )
}

/** Clips saved through Clip a Link (personal, any site yt-dlp supports). */
function ClipSaves() {
  const { data } = useQuery({ queryKey: ['clipper-clips'], queryFn: listClips })
  const clips = (data ?? []).filter((c: Clip) => c.status === 'ready')
  if (clips.length === 0) {
    return <p className="py-16 text-center text-sm text-muted-foreground">No saved clips yet. Paste a link into Clip a Link to save one.</p>
  }
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 xl:grid-cols-4">
      {clips.map((c) => (
        <a key={c.id} href={clipFileUrl(c.id)} target="_blank" rel="noreferrer noopener" className="group flex flex-col gap-2.5">
          <div className="relative aspect-video w-full overflow-hidden rounded-card bg-muted">
            {c.thumbnailUrl ? (
              <img src={proxyImg(c.thumbnailUrl)} alt="" loading="lazy" className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.03]" />
            ) : (
              <div className="flex size-full items-center justify-center"><Link2 className="size-7 text-muted-foreground/50" /></div>
            )}
          </div>
          <div className="min-w-0">
            <p className="line-clamp-2 text-sm font-semibold leading-snug">{c.title || 'Clip'}</p>
            {c.extractor && <p className="mt-0.5 text-xs capitalize text-muted-foreground">{c.extractor}</p>}
          </div>
        </a>
      ))}
    </div>
  )
}

// Cross-source Offline library: filter pills keep each source's saves separable
// instead of one undifferentiated pile.
export function VideosOfflinePage() {
  const [filter, setFilter] = useState<OfflineFilter>('all')
  const { data: savesData } = useQuery({ queryKey: ['videos-saves', 'all'], queryFn: () => listSaves() })
  const counts = useMemo(() => {
    const bySource = new Map<string, number>()
    for (const s of savesData?.saves ?? []) bySource.set(s.source, (bySource.get(s.source) ?? 0) + 1)
    return bySource
  }, [savesData])

  return (
    <PageContainer width="wide" className="pt-1 pb-8">
      <PageHeader title="Offline" icon={Download}
        subtitle="Everything saved to this server, by source." className="pt-4 pb-4" />

      <ChipRow className="mb-6">
        <Chip label="All" active={filter === 'all'} onClick={() => setFilter('all')} />
        {SOURCE_FILTERS.map((s) => (
          (s === 'youtube' || (counts.get(s) ?? 0) > 0) &&
            <SourceChip key={s} source={s} active={filter === s} onClick={() => setFilter(s)} />
        ))}
        <Chip label="Clips" active={filter === 'clips'} onClick={() => setFilter('clips')} />
      </ChipRow>

      {(filter === 'all' || filter === 'youtube') && (
        <section className="mb-10">
          {filter === 'all' && <h3 className="mb-3 text-sm font-semibold text-muted-foreground">YouTube</h3>}
          <SavedTab />
        </section>
      )}
      {SOURCE_FILTERS.filter((s): s is Exclude<VideoSource, 'youtube'> => s !== 'youtube').map((s) => (
        (filter === s || (filter === 'all' && (counts.get(s) ?? 0) > 0)) && (
          <section key={s} className="mb-10">
            {filter === 'all' && <h3 className="mb-3 text-sm font-semibold capitalize text-muted-foreground">{s === 'tiktok' ? 'TikTok' : s.charAt(0).toUpperCase() + s.slice(1)}</h3>}
            <SourceSaves source={s} />
          </section>
        )
      ))}
      {filter === 'clips' && <ClipSaves />}
    </PageContainer>
  )
}
