// Every downloaded episode across every show, in one place: Podcasts previously
// had no such view at all (downloaded state only showed inline per-episode on
// ListenNowPage/ShowDetailPage). Matches YouTube's "Offline" library tab and
// Music's "Offline" tab: select individual episodes or clear everything at once.
// No new backend endpoint needed for the list: usePodcastFeed() already returns
// every episode across every show, filtered here to download.status === 'ready'.

import { useCallback, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { Spinner } from '@/components/ui/spinner'
import { OfflineSelectionToolbar } from '@/components/shared/OfflineSelectionToolbar'
import { EpisodeRow } from '@/components/podcast/EpisodeRow'
import { usePodcastFeed } from '@/lib/podcast/useFeed'
import { removeEpisodeDownload } from '@/lib/podcast/api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/cn'

export function PodcastOfflinePage() {
  const qc = useQueryClient()
  const { data, isLoading } = usePodcastFeed()
  const downloaded = useMemo(() => (data?.all ?? []).filter((f) => f.episode.download?.status === 'ready'), [data])

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const toggle = useCallback((id: string) => setSelected((s) => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next }), [])
  const allSelected = downloaded.length > 0 && selected.size === downloaded.length

  const clear = useCallback(async (ids: string[]) => {
    setBusy(true)
    try {
      await Promise.all(ids.map((id) => removeEpisodeDownload(id)))
      setSelected(new Set())
      await qc.invalidateQueries({ queryKey: ['podcast-feed'] })
      toast.success(ids.length === 1 ? 'Removed from offline' : `Removed ${ids.length} from offline`)
    } catch {
      toast.error('Could not remove all downloads')
    } finally {
      setBusy(false)
    }
  }, [qc])

  return (
    <PageContainer width="wide" className="space-y-9 py-6 pb-24">
      <PageHeader title="Offline" eyebrow="Podcasts" subtitle="Every episode downloaded for offline listening." className="pt-0 pb-0" />

      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner size="lg" /></div>
      ) : downloaded.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
          <Download className="size-8 opacity-40" />
          <p className="text-sm">Nothing downloaded yet. Download an episode from Listen Now or a show's page.</p>
        </div>
      ) : (
        <>
          <OfflineSelectionToolbar
            totalCount={downloaded.length}
            selectedCount={selected.size}
            allSelected={allSelected}
            busy={busy}
            itemLabel="episode"
            onToggleSelectAll={() => setSelected(allSelected ? new Set() : new Set(downloaded.map((f) => f.episode.id)))}
            onClearSelected={() => clear([...selected])}
            onClearAll={() => clear(downloaded.map((f) => f.episode.id))}
          />
          <div className="space-y-1">
            {downloaded.map(({ episode, show }) => (
              <div key={episode.id} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => toggle(episode.id)}
                  className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
                    selected.has(episode.id) ? 'border-brand bg-brand' : 'border-border')}
                  aria-label={selected.has(episode.id) ? 'Deselect' : 'Select'}
                >
                  {selected.has(episode.id) && <span className="size-1.5 rounded-full bg-white" />}
                </button>
                <div className="min-w-0 flex-1">
                  <EpisodeRow episode={episode} show={show} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </PageContainer>
  )
}
