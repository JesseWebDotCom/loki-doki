import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useRadio } from '@/context/RadioContext'
import { useSongArt } from '@/components/music/SongArt'
import { StationArt } from '@/components/music/StationArt'
import { DJ_STATIONS, type DjStation } from '@/lib/music/radioStations'
import { listStations, stationToDj, type Station } from '@/lib/music/catalogApi'

// Music page of the island panel: a browsable station grid where the ALBUM
// ART is the tile (name as a bottom scrim overlay), same cover-resolution
// path as the Music app's StationCard (useSongArt over the station's cover
// track, StationArt silhouette fallback when no cover exists, so cover-less
// stations get the Music app's designed tile instead of an empty wash).
// Tapping a tile starts the AI radio engine IN THIS WINDOW, so the island is
// a self-contained player; the Home page shows the transport.

interface Tile {
  key: string
  name: string
  emoji: string | null
  art: Pick<Station, 'name' | 'accent' | 'category' | 'iconUrl'>
  coverTrack: { videoId: string; title: string; artist: string | null } | null
  dj: DjStation
}

function tilesFromStations(stations: Station[]): Tile[] {
  return stations.map((s) => ({
    key: `st-${s.id}`,
    name: s.name,
    emoji: null,
    art: { name: s.name, accent: s.accent, category: s.category, iconUrl: s.iconUrl },
    coverTrack: s.coverTrack,
    dj: stationToDj(s),
  }))
}

const PRESET_TILES: Tile[] = DJ_STATIONS.map((d) => ({
  key: `dj-${d.id}`,
  name: d.label,
  emoji: d.emoji,
  art: { name: d.label, accent: d.color, category: null, iconUrl: null },
  coverTrack: null,
  dj: d,
}))

// One tile component so each can resolve its own album art (useSongArt is a
// hook; results are query-cached, matching the Music app's stations grid).
function StationTile({ tile, onPlay }: { tile: Tile; onPlay: (t: Tile) => void }) {
  const coverUrl = useSongArt(tile.coverTrack?.videoId, tile.coverTrack?.title, tile.coverTrack?.artist)

  return (
    <button
      type="button"
      title={`Play ${tile.name}`}
      onClick={() => onPlay(tile)}
      className="group relative overflow-hidden rounded-[14px] transition-transform hover:scale-[1.03]"
    >
      {tile.emoji ? (
        // Preset DJ stations carry a curated emoji identity.
        // design-ok(hex-in-tsx): accent is per-station DATA, not a UI token
        <span
          className="absolute inset-0 flex items-center justify-center pb-4"
          style={{ background: tile.art.accent ? `linear-gradient(140deg, ${tile.art.accent}44, ${tile.art.accent}18)` : 'rgba(255,255,255,0.07)' }}
        >
          <span className="text-3xl leading-none drop-shadow">{tile.emoji}</span>
        </span>
      ) : (
        <StationArt station={tile.art} coverUrl={coverUrl} showName={false} className="absolute inset-0" />
      )}
      {/* Name scrim over the artwork bottom edge */}
      <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-2 pb-1.5 pt-5 text-left">
        <span className="block truncate text-[11px] font-semibold text-white drop-shadow">{tile.name}</span>
      </span>
    </button>
  )
}

export function IslandPageMusic({ onStarted }: { onStarted: () => void }) {
  const radio = useRadio()
  const [tiles, setTiles] = useState<Tile[] | null>(null)

  useEffect(() => {
    let cancelled = false
    listStations()
      .then((b) => {
        if (cancelled) return
        const saved = tilesFromStations([...b.mine, ...b.builtin, ...b.shared])
        setTiles(saved.length > 0 ? saved : PRESET_TILES)
      })
      .catch(() => { if (!cancelled) setTiles(PRESET_TILES) })
    return () => { cancelled = true }
  }, [])

  const play = (t: Tile) => {
    radio.start(t.dj, { silentIntro: true })
    // Jump to Home so the now-playing player takes over immediately.
    onStarted()
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-widest text-white/45">Stations</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => window.maipaiDesktop?.openMainWindow('/music')}
          // design-ok(glass-on-plain-bg): sits inside the black island surface
          className="h-6 rounded-full px-2 text-[11px] text-white/55 hover:bg-white/10 hover:text-white"
        >
          <ExternalLink className="size-3" />
          Open Music
        </Button>
      </div>

      <div className="grid flex-1 auto-rows-[92px] grid-cols-4 gap-2.5 overflow-y-auto pb-1">
        {(tiles ?? []).map((t) => (
          <StationTile key={t.key} tile={t} onPlay={play} />
        ))}
        {tiles === null && (
          <span className="col-span-4 self-center text-center text-xs text-white/40">Loading stations…</span>
        )}
      </div>
    </div>
  )
}
