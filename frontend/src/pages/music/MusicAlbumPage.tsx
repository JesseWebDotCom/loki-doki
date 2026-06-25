import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Play, Radio } from 'lucide-react'
import { AlbumCover } from '@/components/music/MediaArt'
import { Button } from '@/components/ui/button'
import { useRadio } from '@/context/RadioContext'
import { toast } from 'sonner'
import { getAlbum, instantStationDj, resolveSong, type CatalogSong } from '@/lib/music/catalogApi'

const fmt = (sec: number | null) => sec == null ? '' : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`

export function MusicAlbumPage() {
  const { mbid = '' } = useParams()
  const navigate = useNavigate()
  const radio = useRadio()
  const { data, isLoading } = useQuery({ queryKey: ['music-album', mbid], queryFn: () => getAlbum(mbid), enabled: !!mbid })

  if (isLoading) return <div className="px-5 pt-6 text-sm text-muted-foreground">Loading…</div>
  if (!data?.album) return <div className="px-5 pt-6 text-sm text-muted-foreground">Album not found.</div>
  const { album, songs } = data

  const playSong = async (s: CatalogSong) => {
    const r = await resolveSong({ mbid: s.mbid, title: s.title, artist: s.artistName, durationSec: s.durationSec })
    if (r) radio.playTrack({ videoId: r.videoId, title: r.title, author: r.artist })
    else toast.error('Could not find that song')
  }
  const playAlbum = () => { if (songs[0]) void playSong(songs[0]) }

  return (
    <div className="px-5 pt-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <AlbumCover coverUrl={album.coverUrl} className="aspect-square w-40 shrink-0 rounded-xl shadow-lg" />
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{album.primaryType ?? 'Album'}{album.year ? ` · ${album.year}` : ''}</p>
          <h1 className="text-3xl font-black tracking-tight sm:text-4xl">{album.title}</h1>
          <button onClick={() => album.artistMbid && navigate(`/music/artist/${album.artistMbid}`)} className="mt-1 text-sm font-medium text-muted-foreground hover:text-foreground">{album.artistName}</button>
          <div className="mt-3 flex gap-2">
            <Button onClick={playAlbum} disabled={!songs.length}><Play className="size-4 fill-current" /> Play</Button>
            <Button variant="secondary" onClick={() => { radio.start(instantStationDj({ type: 'artist', value: album.artistName })); navigate('/music/now-playing') }}><Radio className="size-4" /> Artist station</Button>
          </div>
        </div>
      </div>

      <div className="mt-6 mb-4 divide-y divide-border/50 rounded-xl border border-border/60">
        {songs.map((s, i) => (
          <button key={s.mbid + i} onClick={() => playSong(s)} className="group flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-accent/40">
            <span className="w-5 shrink-0 text-center text-xs text-muted-foreground group-hover:hidden">{i + 1}</span>
            <Play className="hidden size-4 shrink-0 fill-current text-brand group-hover:block" />
            <p className="min-w-0 flex-1 truncate text-sm font-medium">{s.title}</p>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmt(s.durationSec)}</span>
          </button>
        ))}
        {!songs.length && <p className="px-3 py-4 text-sm text-muted-foreground">No tracklist available.</p>}
      </div>
    </div>
  )
}
