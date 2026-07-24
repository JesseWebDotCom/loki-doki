// Camera wall: a grid of Frigate snapshot tiles refreshed every ten seconds,
// with a rail of recent detection events when available.

import { useQuery } from '@tanstack/react-query'
import { Cctv } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { TvScreenProps } from './index'
import { ScreenFrame, StatusPanel, agoLabel, getJson, toMs, useTick } from './shared'

interface FrigateEvent {
  id: string
  title: string | null
  camera: string | null
  label: string | null
  createdAt: number | string | null
}

function cameraLabel(cam: string): string {
  return cam.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function SecurityScreen({ channel, title, subtitle }: TvScreenProps) {
  const cameras = useQuery({
    queryKey: ['dokitv', 'security', 'cameras'],
    queryFn: () => getJson<{ cameras: string[] }>('/api/frigate/cameras'),
    refetchInterval: 60_000,
  })
  const events = useQuery({
    queryKey: ['dokitv', 'security', 'events'],
    queryFn: () => getJson<{ events: FrigateEvent[] }>('/api/frigate/events?limit=8'),
    refetchInterval: 30_000,
    retry: false,
  })
  // Cache-busting tick so each <img> refetches a fresh snapshot every 10s.
  const tick = Math.floor(useTick(10_000) / 10_000)

  if (cameras.isPending) {
    return (
      <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel channel={channel} icon={Cctv} headline="Bringing cameras online" note="Waiting for data" />
      </ScreenFrame>
    )
  }
  const cams = cameras.data?.cameras ?? []
  if (cameras.isError || cams.length === 0) {
    return (
      <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel channel={channel} icon={Cctv} headline="No cameras configured" note="Connect Frigate to put the camera wall on air" />
      </ScreenFrame>
    )
  }

  const recent = (events.data?.events ?? []).slice(0, 6)

  return (
    <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
      <div className="flex h-full gap-6">
        <div
          className={cn(
            'grid min-h-0 flex-1 gap-4',
            cams.length === 1 && 'grid-cols-1',
            cams.length === 2 && 'grid-cols-2',
            cams.length >= 3 && cams.length <= 4 && 'grid-cols-2',
            cams.length > 4 && 'grid-cols-3',
          )}
        >
          {cams.slice(0, 9).map((cam) => (
            <div key={cam} className="relative overflow-hidden rounded-card border border-border/50 bg-card/50">
              <img
                src={`/api/frigate/snapshot/${encodeURIComponent(cam)}?t=${tick}`}
                alt={`${cameraLabel(cam)} camera`}
                decoding="async"
                className="h-full w-full object-cover"
              />
              <span className="absolute bottom-3 left-3 flex items-center gap-2 rounded-full bg-black/70 px-4 py-1.5 text-base font-semibold">
                <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: channel.color }} />
                {cameraLabel(cam)}
              </span>
            </div>
          ))}
        </div>

        {recent.length > 0 ? (
          <div className="hidden w-80 shrink-0 flex-col overflow-hidden rounded-sheet border border-border/50 bg-card/40 xl:flex">
            <p className="border-b border-border/60 px-6 py-4 text-sm font-bold uppercase tracking-[0.3em] text-muted-foreground">
              Recent activity
            </p>
            <div className="min-h-0 flex-1 overflow-hidden px-6">
              {recent.map((ev) => {
                const at = toMs(ev.createdAt)
                return (
                  <div key={ev.id} className="border-b border-border/40 py-4 last:border-b-0">
                    <p className="line-clamp-2 text-lg font-semibold">{ev.title ?? ev.label ?? 'Detection'}</p>
                    <p className="mt-1 truncate text-base text-muted-foreground">
                      {ev.camera ? cameraLabel(ev.camera) : 'Camera'}
                      {at != null ? <span className="ml-2">{agoLabel(at)}</span> : null}
                    </p>
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}
      </div>
    </ScreenFrame>
  )
}
