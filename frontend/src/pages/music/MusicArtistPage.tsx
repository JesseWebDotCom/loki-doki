import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Radio, ExternalLink } from 'lucide-react'
import { AlbumCover, ArtistAvatar } from '@/components/music/MediaArt'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { useRadio } from '@/context/RadioContext'
import { getArtist, instantStationDj, type CatalogAlbum } from '@/lib/music/catalogApi'

export function MusicArtistPage() {
  const { mbid = '' } = useParams()
  const navigate = useNavigate()
  const radio = useRadio()
  const { data, isLoading } = useQuery({ queryKey: ['music-artist', mbid], queryFn: () => getArtist(mbid), enabled: !!mbid })

  if (isLoading) return <div className="px-5 pt-6 text-sm text-muted-foreground">Loading…</div>
  if (!data) return <div className="px-5 pt-6 text-sm text-muted-foreground">Artist not found.</div>
  const { artist, albums } = data

  const albumsByType = (t: string) => albums.filter(a => (a.primaryType ?? 'Album') === t)
  const groups: Array<[string, CatalogAlbum[]]> = [['Album', albumsByType('Album')], ['EP', albumsByType('EP')], ['Single', albumsByType('Single')]]

  return (
    <div>
      <div className="relative overflow-hidden bg-gradient-to-br from-brand/30 via-brand/10 to-transparent px-5 pt-10 pb-6">
        <div className="flex items-end gap-4">
          <ArtistAvatar name={artist.name} mbid={artist.mbid} className="size-24 shrink-0 rounded-full ring-1 ring-border/40" />
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Artist</p>
            <h1 className="truncate text-3xl font-black tracking-tight sm:text-4xl">{artist.name}</h1>
            {artist.tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">{artist.tags.slice(0, 5).map(t => <Badge key={t} variant="secondary">{t}</Badge>)}</div>
            )}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => { radio.start(instantStationDj({ type: 'artist', value: artist.name })); navigate('/music/now-playing') }}><Radio className="size-4" /> Start station</Button>
          {artist.wikipediaUrl && (
            <Button variant="secondary" asChild><a href={artist.wikipediaUrl} target="_blank" rel="noreferrer"><ExternalLink className="size-4" /> Wikipedia</a></Button>
          )}
        </div>
      </div>

      <div className="px-5 pt-4">
        {groups.filter(([, list]) => list.length > 0).map(([label, list]) => (
          <section key={label} className="mb-6">
            <SectionHeader title={label === 'Album' ? 'Albums' : `${label}s`} />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {list.map(al => (
                <button key={al.mbid} onClick={() => navigate(`/music/album/${al.mbid}`)} className="flex flex-col gap-2 rounded-xl p-2 text-left transition hover:bg-accent/50">
                  <AlbumCover coverUrl={al.coverUrl} className="aspect-square w-full rounded-lg" />
                  <div><p className="truncate text-sm font-medium">{al.title}</p>{al.year && <p className="text-[11px] text-muted-foreground">{al.year}</p>}</div>
                </button>
              ))}
            </div>
          </section>
        ))}
        {albums.length === 0 && <p className="text-sm text-muted-foreground">No discography found.</p>}
      </div>
    </div>
  )
}
