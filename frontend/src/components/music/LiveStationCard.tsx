import { useState } from 'react'
import { Play, Plus, Loader2, RadioTower, Check } from 'lucide-react'
import { useLiveRadio } from '@/context/LiveRadioContext'
import { proxyImg } from '@/lib/img'
import { cn } from '@/lib/cn'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { LiveSearchStation } from '@/lib/music/liveRadioApi'

/** Station favicon with a radio-tower fallback — shared by the search cards, the saved-station
 *  grid, and the library tab. All remote art goes through the /api/img proxy. */
export function LiveStationFavicon({ favicon, className }: { favicon?: string | null; className?: string }) {
  const [failed, setFailed] = useState(false)
  return (
    <div className={cn('relative grid shrink-0 place-items-center overflow-hidden rounded-md bg-gradient-to-br from-amber-500/25 to-amber-700/15', className)}>
      <RadioTower className="absolute size-1/2 text-amber-600/70" />
      {favicon && !failed && (
        <img src={proxyImg(favicon)} alt="" loading="lazy" className="relative size-full object-cover"
          onError={() => setFailed(true)} />
      )}
    </div>
  )
}

/** Format the "tags · country" support line off radio-browser's comma-string tags. */
export function stationTagLine(tags: string | null | undefined, country: string | null | undefined): string {
  const t = (tags ?? '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 3).join(', ')
  return [t, country].filter(Boolean).join(' · ')
}

/** A radio-browser search result: preview-play (streams via 'rb:<uuid>' before it's saved)
 *  + add-to-library. HLS stations can't be proxied — Play/Add are disabled. */
export function LiveStationCard({ s, onAdd, adding, added }: {
  s: LiveSearchStation
  onAdd: (s: LiveSearchStation) => void
  adding?: boolean
  added?: boolean
}) {
  const live = useLiveRadio()
  const playing = live.active && live.station?.id === `rb:${s.id}`
  const meta = [s.codec, s.bitrate ? `${s.bitrate} kbps` : null, s.votes ? `${s.votes} votes` : null].filter(Boolean).join(' · ')

  return (
    <Card className="flex items-center gap-3 p-3">
      <LiveStationFavicon favicon={s.favicon} className="size-12" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{s.name}</p>
        <p className="truncate text-xs text-muted-foreground">{stationTagLine(s.tags, s.country) || s.language}</p>
        <p className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground/70">
          {meta}
          {s.hls && <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">Not supported</Badge>}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button onClick={() => live.playLive({ id: `rb:${s.id}`, name: s.name, favicon: s.favicon, preview: true })}
          disabled={s.hls}
          className={cn(
            'grid size-9 place-items-center rounded-full bg-foreground text-background transition hover:opacity-90 disabled:opacity-30',
            playing && 'ring-2 ring-amber-500',
          )}
          aria-label={`Play ${s.name}`} title={s.hls ? 'HLS streams are not supported' : 'Preview'}>
          <Play className="ml-0.5 size-4 fill-current" />
        </button>
        <button onClick={() => onAdd(s)} disabled={s.hls || adding || added}
          className="grid size-9 place-items-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-30"
          aria-label={`Add ${s.name}`} title={s.hls ? 'HLS streams are not supported' : added ? 'In your stations' : 'Add to your stations'}>
          {adding ? <Loader2 className="size-4 animate-spin" /> : added ? <Check className="size-4 text-emerald-500" /> : <Plus className="size-4" />}
        </button>
      </div>
    </Card>
  )
}
