import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Radio, VideoOff, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { cn } from '@/lib/cn'

// Live camera view: the Cameras page could only replay recorded event clips, so "is
// someone at the door RIGHT NOW" had no answer. Frigate publishes an MJPEG stream per
// camera, proxied through our server (the browser never talks to the NVR).
//
// Tiles poll a snapshot rather than each holding an MJPEG connection open: one live
// stream per camera, permanently, would pin a connection per tile for no benefit while
// nobody is looking. Tapping a tile opens the real live stream.

async function listCameras(): Promise<string[]> {
  const r = await fetch('/api/frigate/cameras', { credentials: 'include' })
  if (!r.ok) return []
  return (await r.json() as { cameras: string[] }).cameras ?? []
}

const pretty = (name: string) => name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

export function LiveCameras() {
  const [live, setLive] = useState<string | null>(null)
  // Snapshot cache-buster: bumped on an interval so tiles stay roughly current.
  const { data: cameras = [] } = useQuery({ queryKey: ['frigate-cameras'], queryFn: listCameras, staleTime: 5 * 60_000 })
  const { dataUpdatedAt: tick } = useQuery({
    queryKey: ['frigate-snapshot-tick'],
    queryFn: () => Date.now(),
    refetchInterval: 10_000,
    enabled: cameras.length > 0 && !live,
  })

  if (cameras.length === 0) return null

  return (
    <section className="mb-8">
      <SectionHeader title="Live" className="mb-3" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cameras.map((cam) => (
          <button key={cam} onClick={() => setLive(cam)}
            className={cn('group relative aspect-video overflow-hidden rounded-card bg-muted ring-1 ring-border/60 transition hover:ring-brand/50')}>
            <img
              src={`/api/frigate/snapshot/${encodeURIComponent(cam)}?t=${tick ?? 0}`}
              alt={`${pretty(cam)} camera`}
              className="size-full object-cover"
              onError={(e) => { e.currentTarget.style.visibility = 'hidden' }}
            />
            {/* design-ok(raw-palette-semantic): live badge over a camera image */}
            <span className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold text-white">
              <Radio className="size-2.5 text-red-400" /> LIVE
            </span>
            <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2.5 py-1.5 text-left text-xs font-semibold text-white">
              {pretty(cam)}
            </span>
          </button>
        ))}
      </div>

      {live && (
        // design-ok(raw-overlay): full-screen live view, the same posture as the Plex player
        <div className="fixed inset-0 z-[100] flex flex-col bg-black/95">
          <div className="flex items-center justify-between px-4 py-3">
            <p className="flex items-center gap-2 text-sm font-medium text-white/90">
              {/* design-ok(raw-palette-semantic): live dot over the video surface */}
              <Radio className="size-3.5 text-red-400" /> {pretty(live)}
            </p>
            {/* design-ok(glass-on-plain-bg): over full-screen video surface */}
            <Button variant="ghost" size="icon" onClick={() => setLive(null)} aria-label="Close live view"
              className="text-white/70 hover:bg-white/10 hover:text-white">
              <X className="size-5" />
            </Button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center px-4 pb-4">
            <img src={`/api/frigate/live/${encodeURIComponent(live)}`} alt={`${pretty(live)} live`}
              className="max-h-full max-w-full rounded-card" />
          </div>
        </div>
      )}
    </section>
  )
}

/** Shown when Frigate is connected but exposes no cameras (or is unreachable). */
export function LiveCamerasUnavailable() {
  return (
    <Card variant="dashed" className="mb-8 flex items-center gap-3 p-4 text-sm text-muted-foreground">
      <VideoOff className="size-4 shrink-0" />
      Live view isn't available right now. Recorded clips are still below.
    </Card>
  )
}
