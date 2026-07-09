import { Play, ArrowDownToLine } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useRadio } from '@/context/RadioContext'
import { cn } from '@/lib/cn'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { StatusDot } from '@/components/shared/StatusDot'
import { StationArt } from '@/components/music/StationArt'
import { useSongArt } from '@/components/music/SongArt'
import { useOfflineStationMap } from '@/lib/music/useOffline'
import { stationToDj, type Station } from '@/lib/music/catalogApi'

// Re-exported for back-compat with callers that imported it from here.
export { stationGradient } from '@/lib/music/stationColors'

export function StationCard({ station, onOpen }: { station: Station; onOpen?: (s: Station) => void }) {
  const radio = useRadio()
  const navigate = useNavigate()
  const offStatus = useOfflineStationMap().get(station.id)
  const playing = radio.active && radio.station?.id === station.id
  // Real album art from the station's "cover song" (last built queue's lead track) - keeps
  // the card visually consistent with the blended-cover detail hero it opens into.
  const coverUrl = useSongArt(station.coverTrack?.videoId, station.coverTrack?.title, station.coverTrack?.artist)
  const play = (e: React.MouseEvent) => { e.stopPropagation(); radio.start(stationToDj(station)); navigate('/music/now-playing') }
  const open = () => (onOpen ? onOpen(station) : navigate(`/music/station/${station.id}`))

  // Caption lives INSIDE the art (StationArt subtitle) so every card is exactly the same
  // height - description for most stations, attribution for family-shared ones.
  const subtitle = station.ownerName
    ? `by ${station.ownerName}`
    : (station.description && !station.description.startsWith('source:') ? station.description : null)

  return (
    <Card variant="interactive" className="group relative overflow-hidden" onClick={open}>
      <div className="relative aspect-[16/9] w-full overflow-hidden">
        <StationArt station={station} coverUrl={coverUrl} subtitle={subtitle} />
        {playing && (
          <span className="absolute left-2 top-2 z-10">
            <StatusDot status="error" pulse />
          </span>
        )}
        {/* Offline indicator: a subtle check once downloaded, a spinner while it's still saving.
            Top-right so it never collides with the station glyph at top-left. */}
        {offStatus && (
          <span
            title={offStatus === 'ready' ? 'Downloaded' : 'Saving offline…'}
            // design-ok(backdrop-blur-outside-chrome): status chip floats over station artwork
            className="absolute right-2 top-2 grid size-6 place-items-center rounded-full bg-black/35 backdrop-blur-sm">
            {offStatus === 'ready'
              ? <ArrowDownToLine className="size-3.5 text-success" />
              : <Spinner size="sm" className="text-warning" />}
          </span>
        )}
        {/* design-ok(backdrop-blur-outside-chrome): play control floats over station artwork */}
        <button onClick={play} aria-label={`Play ${station.name}`}
          className={cn(
            'absolute bottom-2 right-2 flex size-11 items-center justify-center rounded-full bg-black/55 text-white shadow-lg backdrop-blur transition', // design-ok(backdrop-blur-outside-chrome): over artwork
            'opacity-0 group-hover:opacity-100 hover:scale-105',
            playing && 'opacity-100 ring-2 ring-white',
          )}>
          <Play className="size-5 translate-x-px fill-current" />
        </button>
      </div>
    </Card>
  )
}
