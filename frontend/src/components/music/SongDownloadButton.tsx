import { useState } from 'react'
import { ArrowDownToLine, Check } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { cn } from '@/lib/cn'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import {
  saveOffline, removeOffline, AUDIO_QUALITIES, getDownloadAudioQuality, setDownloadAudioQuality,
  type AudioQuality,
} from '@/lib/music/catalogApi'
import { useOfflineSongs } from '@/lib/music/useOffline'
import { isYouTubeRef } from '@/lib/music/trackRef'

/** Apple-Music-style per-song download control. Idle → cloud-down arrow opening a quality menu
 *  (last-used quality remembered per device); downloading → spinner; ready → green check (tap
 *  again to remove). Reads/writes the shared offline-songs cache.
 *  Renders nothing for owned-library refs - a local file is already "downloaded" by definition. */
export function SongDownloadButton({ videoId, title, className }: { videoId: string; title: string; className?: string }) {
  const qc = useQueryClient()
  const { data } = useOfflineSongs()
  const [busy, setBusy] = useState(false)
  const status = data?.offline.find(t => t.videoId === videoId)?.status
  const ready = status === 'ready'
  const pending = status === 'pending' || status === 'downloading'
  if (!isYouTubeRef(videoId)) return null

  const remove = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (busy || pending) return
    setBusy(true)
    try {
      await removeOffline(videoId)
      toast.success('Removed download')
      qc.invalidateQueries({ queryKey: ['music-offline'] })
    } catch { toast.error('Could not update download') }
    finally { setBusy(false) }
  }

  const download = async (quality: AudioQuality) => {
    if (busy) return
    setBusy(true)
    setDownloadAudioQuality(quality)
    try {
      await saveOffline({ videoId, title, audioFormat: quality })
      toast.success('Downloading…')
      qc.invalidateQueries({ queryKey: ['music-offline'] })
    } catch { toast.error('Could not update download') }
    finally { setBusy(false) }
  }

  // Idle downloads reveal on row hover; an active/finished state stays visible (parent must be `group`).
  const vis = ready || pending || busy ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
  const btnClass = cn('flex size-8 shrink-0 items-center justify-center rounded-full transition',
    ready ? 'text-success hover:text-destructive' : 'text-muted-foreground hover:text-foreground hover:bg-accent/60',
    vis, className)

  if (ready || pending || busy) {
    return (
      <button type="button" onClick={remove} aria-label={ready ? 'Remove download' : 'Downloading'}
        title={ready ? 'Downloaded - tap to remove' : 'Downloading…'} className={btnClass}>
        {busy || pending ? <Spinner className="text-current" /> : <Check className="size-4" />}
      </button>
    )
  }

  const preferred = getDownloadAudioQuality()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" onClick={e => e.stopPropagation()} aria-label="Download for offline"
          title="Download for offline" className={btnClass}>
          <ArrowDownToLine className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={e => e.stopPropagation()}>
        <DropdownMenuLabel>Download quality</DropdownMenuLabel>
        {AUDIO_QUALITIES.map(q => (
          <DropdownMenuItem key={q.id} onSelect={() => void download(q.id)}>
            <span className="flex-1">
              <span className="block text-sm">{q.label}</span>
              <span className="block text-[11px] text-muted-foreground">{q.hint}</span>
            </span>
            {q.id === preferred && <Check className="size-4 text-[var(--music-accent)]" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
