import { Play, Users, ArrowDownToLine, Loader2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useRadio } from '@/context/RadioContext'
import { cn } from '@/lib/cn'
import { Card } from '@/components/ui/card'
import { StationArt } from '@/components/music/StationArt'
import { useOfflineStationMap } from '@/lib/music/useOffline'
import { stationToDj, type Station } from '@/lib/music/catalogApi'

// Re-exported for back-compat with callers that imported it from here.
export { stationGradient } from '@/lib/music/stationColors'

export function StationCard({ station, onOpen }: { station: Station; onOpen?: (s: Station) => void }) {
  const radio = useRadio()
  const navigate = useNavigate()
  const offStatus = useOfflineStationMap().get(station.id)
  const playing = radio.active && radio.station?.id === station.id
  const play = (e: React.MouseEvent) => { e.stopPropagation(); radio.start(stationToDj(station)); navigate('/music/now-playing') }
  const open = () => (onOpen ? onOpen(station) : navigate(`/music/station/${station.id}`))

  return (
    <Card variant="interactive" className="group relative overflow-hidden" onClick={open}>
      <div className="relative aspect-[16/9] w-full overflow-hidden">
        <StationArt station={station} />
        {/* Offline indicator: a subtle check once downloaded, a spinner while it's still saving.
            Top-right so it never collides with the station glyph at top-left. */}
        {offStatus && (
          <span
            title={offStatus === 'ready' ? 'Downloaded' : 'Saving offline…'}
            className="absolute right-2 top-2 grid size-6 place-items-center rounded-full bg-black/35 backdrop-blur-sm">
            {offStatus === 'ready'
              ? <ArrowDownToLine className="size-3.5 text-emerald-300/90" />
              : <Loader2 className="size-3.5 animate-spin text-amber-300/90" />}
          </span>
        )}
        <button onClick={play} aria-label={`Play ${station.name}`}
          className={cn(
            'absolute bottom-2 right-2 flex size-11 items-center justify-center rounded-full bg-black/55 text-white shadow-lg backdrop-blur transition',
            'opacity-0 group-hover:opacity-100 hover:scale-105',
            playing && 'opacity-100 ring-2 ring-white',
          )}>
          <Play className="size-5 translate-x-px fill-current" />
        </button>
      </div>
      <div className="p-3">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-sm font-semibold">{station.name}</p>
          {playing && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-red-500" />}
        </div>
        {station.description && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{station.description}</p>}
        {station.ownerName && (
          <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground/70">
            <Users className="size-3" /> by {station.ownerName}
          </p>
        )}
      </div>
    </Card>
  )
}
