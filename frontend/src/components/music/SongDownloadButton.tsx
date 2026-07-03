import { useState } from 'react'
import { ArrowDownToLine, Check } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { cn } from '@/lib/cn'
import { saveOffline, removeOffline } from '@/lib/music/catalogApi'
import { useOfflineSongs } from '@/lib/music/useOffline'

/** Apple-Music-style per-song download control. Idle → cloud-down arrow; downloading → spinner;
 *  ready → green check (tap again to remove). Reads/writes the shared offline-songs cache. */
export function SongDownloadButton({ videoId, title, className }: { videoId: string; title: string; className?: string }) {
  const qc = useQueryClient()
  const { data } = useOfflineSongs()
  const [busy, setBusy] = useState(false)
  const status = data?.offline.find(t => t.videoId === videoId)?.status
  const ready = status === 'ready'
  const pending = status === 'pending' || status === 'downloading'

  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (busy || pending) return
    setBusy(true)
    try {
      if (ready) { await removeOffline(videoId); toast.success('Removed download') }
      else { await saveOffline({ videoId, title }); toast.success('Downloading…') }
      qc.invalidateQueries({ queryKey: ['music-offline'] })
    } catch { toast.error('Could not update download') }
    finally { setBusy(false) }
  }

  // Idle downloads reveal on row hover; an active/finished state stays visible (parent must be `group`).
  const vis = ready || pending || busy ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
  return (
    <button type="button" onClick={onClick} aria-label={ready ? 'Remove download' : 'Download for offline'}
      title={ready ? 'Downloaded - tap to remove' : pending ? 'Downloading…' : 'Download for offline'}
      className={cn('flex size-8 shrink-0 items-center justify-center rounded-full transition',
        ready ? 'text-success hover:text-destructive' : 'text-muted-foreground hover:text-foreground hover:bg-accent/60',
        vis, className)}>
      {busy || pending ? <Spinner className="text-current" /> : ready ? <Check className="size-4" /> : <ArrowDownToLine className="size-4" />}
    </button>
  )
}
