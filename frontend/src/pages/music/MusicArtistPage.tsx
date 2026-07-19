import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Radio, ExternalLink, Disc3, Heart, Hourglass } from 'lucide-react'
import { AlbumCover, ArtistAvatar } from '@/components/music/MediaArt'
import { AlbumFilterButton, albumPassesFilters, defaultAlbumFilters, type AlbumFilters } from '@/components/music/AlbumFilterButton'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { PageContainer } from '@/components/shared/PageContainer'
import { proxyImg } from '@/lib/img'
import { cn } from '@/lib/cn'
import { useRadio } from '@/context/RadioContext'
import { getArtist, getArtistInfo, instantStationDj, type CatalogAlbum } from '@/lib/music/catalogApi'
import { useFavorite } from '@/lib/music/useFavorite'

export function MusicArtistPage() {
  const { mbid = '' } = useParams()
  const navigate = useNavigate()
  const radio = useRadio()
  const { data, isLoading } = useQuery({ queryKey: ['music-artist', mbid], queryFn: () => getArtist(mbid), enabled: !!mbid })
  // Wikipedia extract (bio) + photo, from the same source that powers the avatar and the song
  // "About" blurb. Same query key as ArtistAvatar → shared cache, no extra request. Fetched on the
  // resolved artist name/mbid, so it waits for the artist load.
  const artistName = data?.artist.name ?? ''
  const { data: info } = useQuery({
    queryKey: ['music-artist-img-v3', mbid || artistName],
    queryFn: () => getArtistInfo(artistName, mbid || undefined),
    enabled: !!artistName, staleTime: Infinity,
  })
  const [logoBroken, setLogoBroken] = useState(false)
  const fav = useFavorite('artist', mbid)
  // Live tapes, demos, and mixtapes bury the real discography (MB catalogs every club
  // bootleg) - hidden by default; the filter button by the section header adjusts.
  const [filters, setFilters] = useState<AlbumFilters>(defaultAlbumFilters)

  if (isLoading) return <div className="px-5 pt-6 text-sm text-muted-foreground">Loading…</div>
  if (!data) return <div className="px-5 pt-6 text-sm text-muted-foreground">Artist not found.</div>

  const { artist, albums } = data
  const bio = info?.found ? info.extract : null
  const bioUrl = info?.url ?? artist.wikipediaUrl
  const showLogo = !!info?.logo && !logoBroken

  const visible = albums.filter(a => albumPassesFilters(a, filters))
  const albumsByType = (t: string) => visible.filter(a => (a.primaryType ?? 'Album') === t)
  const groups: Array<[string, CatalogAlbum[]]> = [['Album', albumsByType('Album')], ['EP', albumsByType('EP')], ['Single', albumsByType('Single')]]

  return (
    <div>
      <div className="relative overflow-hidden px-5 pt-12 pb-6 sm:px-8">
        {/* Header backdrop: the band photo as a VISIBLE hero (lightly softened, not heavily blurred),
            darkened by theme-independent scrims so the left-aligned content + white logo always read.
            Brand gradient stands in when there's no photo. */}
        <div aria-hidden className="absolute inset-0 bg-gradient-to-br from-brand/40 via-brand/15 to-transparent" />
        {info?.image && (
          <div aria-hidden className="absolute inset-0">
            <img src={proxyImg(info.image)} alt="" className="size-full scale-105 object-cover object-center opacity-75 blur-[2px]" />
            {/* design-ok(raw-palette-semantic): black scrims over a photo hero, mirrors NowPlayingPage */}
            <div className="absolute inset-0 bg-gradient-to-r from-black/85 via-black/35 to-transparent" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
          </div>
        )}
        <div className="relative">
          {/* design-ok(raw-palette-semantic): light text on the darkened photo hero */}
          <p className="text-overline text-white/70">Artist</p>
          {showLogo ? (
            // Band logo as the left-aligned feature image. Logos are usually monochrome SVGs, so we
            // force them white (the hero is always dark) with a shadow so they read on any photo.
            <img src={proxyImg(info!.logo!)} alt={artist.name}
              className="mt-1 h-20 w-auto max-w-[72%] object-contain object-left sm:h-28"
              style={{ filter: 'brightness(0) invert(1) drop-shadow(0 2px 12px rgba(0,0,0,0.65))' }}
              onError={() => setLogoBroken(true)} />
          ) : (
            <div className="flex items-end gap-4">
              <ArtistAvatar name={artist.name} mbid={artist.mbid} className="size-24 shrink-0 rounded-full shadow-xl ring-1 ring-border/40 sm:size-28" />
              {/* design-ok(raw-palette-semantic): band name on the darkened photo hero */}
              <div className="truncate text-display text-white sm:text-display-lg">{artist.name}</div>
            </div>
          )}
          {artist.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">{artist.tags.slice(0, 5).map(t => <Badge key={t} variant="secondary">{t}</Badge>)}</div>
          )}
        </div>
        <div className="relative mt-4 flex flex-wrap gap-2">
          <Button onClick={() => { radio.start(instantStationDj({ type: 'artist', value: artist.name })); navigate('/music/now-playing') }}><Radio className="size-4" /> Start station</Button>
          {/* Plexamp-style artist pivots: the same personal-station recipes, scoped to this artist. */}
          <Button variant="secondary" title={`Album tracks and B-sides by ${artist.name} - no hits`}
            onClick={() => {
              radio.start(instantStationDj({
                type: 'prompt', label: `${artist.name}: Deep Cuts`,
                value: `Lesser-known album tracks, B-sides and deep cuts by ${artist.name} only - strictly no hit singles or radio staples`,
              }))
              navigate('/music/now-playing')
            }}>
            <Disc3 className="size-4" /> Deep cuts
          </Button>
          <Button variant="secondary" title={`${artist.name}'s catalog in order, oldest first`}
            onClick={() => {
              radio.start(instantStationDj({
                type: 'prompt', label: `${artist.name}: Time Travel`,
                value: `A chronological journey through ${artist.name}'s catalog: start with their oldest recordings and progress steadily to their newest`,
              }))
              navigate('/music/now-playing')
            }}>
            <Hourglass className="size-4" /> Time travel
          </Button>
          <Button variant="secondary" onClick={() => void fav.toggle({ title: artist.name, mbid: artist.mbid })}>
            <Heart className={cn('size-4', fav.isFavorite && 'fill-current text-brand')} /> {fav.isFavorite ? 'Favorited' : 'Favorite'}
          </Button>
          {bioUrl && (
            <Button variant="secondary" asChild><a href={bioUrl} target="_blank" rel="noreferrer"><ExternalLink className="size-4" /> Wikipedia</a></Button>
          )}
        </div>
      </div>

      <PageContainer width="wide" className="pt-4 pb-10">
        {bio && (
          <section className="mb-6">
            <SectionHeader title="About" />
            <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{bio}</p>
          </section>
        )}
        {groups.filter(([, list]) => list.length > 0).map(([label, list], gi) => (
          <section key={label} className="mb-6">
            <SectionHeader
              title={label === 'Album' ? 'Albums' : `${label}s`}
              count={list.length}
              action={gi === 0 ? <AlbumFilterButton albums={albums} filters={filters} onChange={setFilters} /> : undefined}
            />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {list.map(al => (
                <button key={al.mbid} onClick={() => navigate(`/music/album/${al.mbid}`)} className="flex flex-col gap-2 rounded-card p-2 text-left transition hover:bg-accent/50">
                  <AlbumCover coverUrl={al.coverUrl} artist={artist.name} album={al.title} artistImage={info?.image} artistLogo={info?.logo} className="aspect-square w-full rounded-control" />
                  <div><p className="truncate text-sm font-medium">{al.title}</p>{al.year && <p className="text-caption text-muted-foreground">{al.year}</p>}</div>
                </button>
              ))}
            </div>
          </section>
        ))}
        {albums.length === 0 && <p className="text-sm text-muted-foreground">No discography found.</p>}
      </PageContainer>
    </div>
  )
}
