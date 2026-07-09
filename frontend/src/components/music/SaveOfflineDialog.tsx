import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Download, Trash2, Headphones, MonitorPlay, Layers, type LucideIcon } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import {
  snapshotStation, removeOfflineStation, getVideoSaveQuality,
  AUDIO_QUALITIES, getDownloadAudioQuality, setDownloadAudioQuality,
  type OfflineMedia, type AudioQuality,
} from '@/lib/music/catalogApi'

const MEDIA: { id: OfflineMedia; label: string; icon: LucideIcon; hint: string }[] = [
  { id: 'audio', label: 'Audio', icon: Headphones, hint: 'Listen - smallest, includes the AI DJ' },
  { id: 'video', label: 'Video', icon: MonitorPlay, hint: 'Watch - the music videos' },
  { id: 'both', label: 'Both', icon: Layers, hint: 'Listen and Watch offline' },
]
const COUNTS = [20, 50, 100]

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={cn('rounded-full border px-3 py-1.5 text-sm font-medium transition',
        active ? 'border-transparent bg-[var(--music-accent)] text-[var(--music-accent-contrast)]' : 'border-border text-muted-foreground hover:text-foreground')}>
      {children}
    </button>
  )
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground/70">{label}</p>{children}</div>
}

/** Pick media (audio/video/both), how many songs, and (for video) quality, governed by the shared
 *  YouTube admin cap + user default, then snapshot the station offline. Also removes an offline save. */
export function SaveOfflineDialog({ open, onOpenChange, stationId, saved, onChanged }: {
  open: boolean; onOpenChange: (o: boolean) => void; stationId: string; saved: boolean; onChanged: () => void
}) {
  const [media, setMedia] = useState<OfflineMedia>('audio')
  const [count, setCount] = useState(20)
  const [height, setHeight] = useState<number | null>(null)
  const [audioQuality, setAudioQuality] = useState<AudioQuality>(() => getDownloadAudioQuality())
  const [busy, setBusy] = useState(false)
  const wantsVideo = media === 'video' || media === 'both'
  const wantsAudio = media === 'audio' || media === 'both'

  const { data: quality } = useQuery({ queryKey: ['video-save-quality'], queryFn: getVideoSaveQuality, enabled: open && wantsVideo })
  useEffect(() => { if (quality && height == null) setHeight(quality.pref ?? quality.effective) }, [quality, height])
  const tiers = (quality?.tiers ?? []).filter(t => quality && t <= quality.cap)

  const save = async () => {
    setBusy(true)
    try {
      if (wantsAudio) setDownloadAudioQuality(audioQuality)
      await snapshotStation(stationId, {
        count, media,
        maxHeight: wantsVideo ? (height ?? undefined) : undefined,
        audioFormat: wantsAudio ? audioQuality : undefined,
      })
      toast.success('Saving station offline…')
      onChanged(); onOpenChange(false)
    } catch { toast.error('Could not save offline') }
    finally { setBusy(false) }
  }
  const remove = async () => {
    setBusy(true)
    try { await removeOfflineStation(stationId); toast.success('Removed from offline'); onChanged(); onOpenChange(false) }
    catch { toast.error('Could not remove') }
    finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Save station offline</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <Field label="What to download">
            <div className="grid grid-cols-3 gap-2">
              {MEDIA.map(m => (
                <button key={m.id} type="button" onClick={() => setMedia(m.id)}
                  className={cn('flex flex-col items-center gap-1 rounded-control border p-3 text-center transition',
                    media === m.id ? 'border-[var(--music-accent)] bg-[var(--music-accent-soft)]' : 'border-border hover:bg-accent/40')}>
                  <m.icon className="size-5" />
                  <span className="text-sm font-medium">{m.label}</span>
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">{MEDIA.find(m => m.id === media)?.hint}</p>
          </Field>

          <Field label="How many songs">
            <div className="flex gap-2">{COUNTS.map(n => <Chip key={n} active={count === n} onClick={() => setCount(n)}>{n}</Chip>)}</div>
          </Field>

          {wantsAudio && (
            <Field label="Audio quality">
              <div className="flex flex-wrap gap-2">
                {AUDIO_QUALITIES.map(q => (
                  <Chip key={q.id} active={audioQuality === q.id} onClick={() => setAudioQuality(q.id)}>{q.label}</Chip>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">{AUDIO_QUALITIES.find(q => q.id === audioQuality)?.hint}</p>
            </Field>
          )}

          {wantsVideo && (
            <Field label="Video quality">
              <div className="flex flex-wrap gap-2">
                {tiers.length ? tiers.map(t => <Chip key={t} active={height === t} onClick={() => setHeight(t)}>{t}p</Chip>)
                  : <span className="text-xs text-muted-foreground">Loading…</span>}
              </div>
              {quality && <p className="mt-1.5 text-[11px] text-muted-foreground">Capped at {quality.cap}p by your admin. Video uses far more space than audio.</p>}
            </Field>
          )}
        </div>
        <DialogFooter className="!justify-between">
          {saved
            ? <Button variant="ghost" className="text-destructive" onClick={remove} disabled={busy}><Trash2 className="size-4" /> Remove offline</Button>
            : <span />}
          <Button onClick={save} disabled={busy || (wantsVideo && !height)}>
            {busy ? <Spinner className="text-current" /> : <Download className="size-4" />} {saved ? 'Re-download' : 'Save offline'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
