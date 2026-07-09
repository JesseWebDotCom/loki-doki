import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { User } from 'lucide-react'
import { proxyImg } from '@/lib/img'
import { cn } from '@/lib/cn'
import { getArtistInfo, getAlbumCoverFallback } from '@/lib/music/catalogApi'
import { GeneratedAlbumCover } from '@/components/music/GeneratedAlbumCover'

/** Album cover: iTunes art is the PRIMARY source (fast CDN + 7-day-cached lookup); the
 *  Cover Art Archive URL is the FALLBACK - its redirect chain to archive.org routinely
 *  takes seconds (or hangs outright on bootlegs/live tapes that have no cover), so the
 *  CAA attempt runs under a hang guard. When neither source has art, renders a
 *  GeneratedAlbumCover - a deterministic album-art poster - so every tile reads as
 *  intentional and never shows the WRONG album (or an empty gradient). */
const CAA_HANG_MS = 4000

export function AlbumCover({ coverUrl, artist, album, artistImage, artistLogo, className }: {
  coverUrl: string | null; artist?: string; album?: string; artistImage?: string | null; artistLogo?: string | null; className?: string
}) {
  const canItunes = !!(artist && album)
  const [stage, setStage] = useState<'itunes' | 'caa' | 'none'>(canItunes ? 'itunes' : (coverUrl ? 'caa' : 'none'))
  const [caaLoaded, setCaaLoaded] = useState(false)
  const { data: fb } = useQuery({
    queryKey: ['album-cover-fallback', artist, album],
    queryFn: () => getAlbumCoverFallback(artist!, album!),
    enabled: stage === 'itunes' && canItunes, staleTime: Infinity,
  })

  // iTunes lookup finished with no art → COMMIT the move to CAA (or generated). Deriving
  // this in render left `stage` stale, so a failing CAA image retried itself once more -
  // two multi-second 404 round-trips before the generated cover finally appeared.
  const itunesMissed = stage === 'itunes' && fb !== undefined && !fb?.coverUrl
  useEffect(() => {
    if (itunesMissed) setStage(coverUrl ? 'caa' : 'none')
  }, [itunesMissed, coverUrl])

  // CAA hang guard: bootlegs with no cover leave the request dangling. If the image
  // hasn't rendered within the window, take the generated cover instead of a blank tile.
  useEffect(() => {
    if (stage !== 'caa' || caaLoaded) return
    const t = setTimeout(() => setStage('none'), CAA_HANG_MS)
    return () => clearTimeout(t)
  }, [stage, caaLoaded])

  const src = stage === 'itunes' ? (fb?.coverUrl ?? null) : stage === 'caa' ? coverUrl : null
  const waitingItunes = stage === 'itunes' && fb === undefined
  const showGenerated = !src && !waitingItunes
  return (
    <div className={cn('relative overflow-hidden bg-gradient-to-br from-brand/30 to-brand/10', className)}>
      {showGenerated && <GeneratedAlbumCover band={artist} album={album} photo={artistImage} logo={artistLogo} className="absolute inset-0" />}
      {src && (
        <img key={src} src={proxyImg(src)} alt="" loading="lazy" className="absolute inset-0 size-full object-cover"
          onLoad={() => { if (stage === 'caa') setCaaLoaded(true) }}
          onError={() => setStage(s => (s === 'itunes' && coverUrl) ? 'caa' : 'none')} />
      )}
    </div>
  )
}

/** Artist avatar: lazily fetches the artist's photo (cached) and shows it, with a person-icon
 *  fallback while loading or when no image exists. Passing the MusicBrainz mbid lets the backend
 *  resolve images via Wikidata → Wikimedia Commons that a bare-name Wikipedia lookup would miss. */
export function ArtistAvatar({ name, mbid, className }: { name: string; mbid?: string; className?: string }) {
  const { data } = useQuery({
    queryKey: ['music-artist-img-v3', mbid ?? name], queryFn: () => getArtistInfo(name, mbid),
    enabled: !!name, staleTime: Infinity,
  })
  const img = data?.found ? data.image : null
  return (
    <div className={cn('relative grid place-items-center overflow-hidden bg-gradient-to-br from-brand/30 to-brand/10', className)}>
      <User className="absolute size-1/3 text-brand/60" />
      {img && (
        <img src={proxyImg(img)} alt="" loading="lazy" className="relative size-full object-cover"
          onError={e => { e.currentTarget.style.visibility = 'hidden' }} />
      )}
    </div>
  )
}
