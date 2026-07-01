import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Camera, Loader2, Play, Video, VideoOff } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Card } from '@/components/ui/card'
import { useAuth } from '@/context/AuthContext'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { getFrigateStatus, listEvents, type FrigateEvent } from '@/lib/frigate/api'

const GRADIENT = 'linear-gradient(135deg,#1c1917,#3f3f46)'

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.round(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

function EventCard({ event, onOpen }: { event: FrigateEvent; onOpen: () => void }) {
  return (
    <Card variant="interactive" className="overflow-hidden p-0" onClick={onOpen}>
      <div className="relative aspect-video bg-muted">
        {event.snapshotUrl ? (
          <img src={event.snapshotUrl} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center"><VideoOff className="size-6 text-muted-foreground/40" /></div>
        )}
        {event.clipUrl && (
          <span className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-black/60 text-white">
            <Play className="size-3 fill-white" />
          </span>
        )}
      </div>
      <div className="p-2.5">
        <p className="truncate text-sm font-semibold">{event.camera ?? 'Camera'}</p>
        <p className="truncate text-xs text-muted-foreground">
          {event.label ?? 'Activity'}{event.subLabel ? ` · ${event.subLabel}` : ''} · {relTime(event.createdAt)}
        </p>
      </div>
    </Card>
  )
}

function EventDialog({ event, onOpenChange }: { event: FrigateEvent | null; onOpenChange: (open: boolean) => void }) {
  const [playing, setPlaying] = useState(false)
  return (
    <Dialog open={!!event} onOpenChange={(open) => { onOpenChange(open); if (!open) setPlaying(false) }}>
      <DialogContent className="max-w-lg">
        {event && (
          <>
            <DialogHeader>
              <DialogTitle>{event.camera ?? 'Camera'} · {event.label ?? 'Activity'}</DialogTitle>
            </DialogHeader>
            <div className="overflow-hidden rounded-lg bg-black">
              {playing && event.clipUrl ? (
                // eslint-disable-next-line jsx-a11y/media-has-caption -- Frigate clips carry no captions
                <video src={event.clipUrl} controls autoPlay className="aspect-video w-full" />
              ) : event.snapshotUrl ? (
                <img src={event.snapshotUrl} alt="" className="aspect-video w-full object-contain" />
              ) : (
                <div className="flex aspect-video items-center justify-center"><VideoOff className="size-8 text-muted-foreground/40" /></div>
              )}
            </div>
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>{relTime(event.createdAt)}</span>
              {event.clipUrl && !playing && (
                <button type="button" onClick={() => setPlaying(true)}
                  className="flex items-center gap-1.5 rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-brand-foreground">
                  <Play className="size-3.5 fill-current" /> Play clip
                </button>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function CamerasPage() {
  const { user } = useAuth()
  const [cameraFilter, setCameraFilter] = useState<string | null>(null)
  const [active, setActive] = useState<FrigateEvent | null>(null)

  usePublishUIContext({
    label: 'Cameras',
    description: 'User is viewing recent camera activity and clips.',
  })

  const { data: status } = useQuery({ queryKey: ['frigate-status'], queryFn: getFrigateStatus })
  const enabled = status?.enabled ?? false
  const { data: events, isLoading } = useQuery({
    queryKey: ['frigate-events'],
    queryFn: () => listEvents(80),
    enabled,
    refetchInterval: 20_000,
  })

  const cameras = useMemo(() => {
    const set = new Set((events ?? []).map((e) => e.camera).filter((c): c is string => !!c))
    return [...set].sort()
  }, [events])

  const filtered = useMemo(() => {
    const list = events ?? []
    return cameraFilter ? list.filter((e) => e.camera === cameraFilter) : list
  }, [events, cameraFilter])

  return (
    <PageShell gradient={GRADIENT} GhostIcon={Camera}>
      <PageHeader variant="compact" title="Cameras" subtitle="Recent activity from your home cameras." />

      <div className="px-5 pb-10">
        {!enabled ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border/60 bg-card/40 py-20 text-center">
            <Video className="size-8 text-muted-foreground/40" />
            <p className="text-sm font-medium text-muted-foreground">No cameras set up yet.</p>
            <p className="max-w-sm text-xs text-muted-foreground/70">
              {user?.role === 'admin'
                ? 'Connect a Frigate NVR in Admin → Frigate to see live activity and clips here.'
                : 'Ask an admin to connect your camera system to see activity here.'}
            </p>
          </div>
        ) : (
          <>
            {cameras.length > 1 && (
              <ChipRow className="mb-4">
                <Chip label="All cameras" active={cameraFilter === null} onClick={() => setCameraFilter(null)} />
                {cameras.map((c) => (
                  <Chip key={c} label={c} active={cameraFilter === c} onClick={() => setCameraFilter(c)} />
                ))}
              </ChipRow>
            )}
            {isLoading ? (
              <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
            ) : !filtered.length ? (
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground">
                <Camera className="size-8 opacity-40" /><p className="text-sm">No activity yet.</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {filtered.map((e) => <EventCard key={e.id} event={e} onOpen={() => setActive(e)} />)}
              </div>
            )}
          </>
        )}
      </div>

      <EventDialog event={active} onOpenChange={(open) => { if (!open) setActive(null) }} />
    </PageShell>
  )
}
