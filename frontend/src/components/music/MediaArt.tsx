import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Disc3, User } from 'lucide-react'
import { proxyImg } from '@/lib/img'
import { cn } from '@/lib/cn'
import { getArtistInfo, getAlbumCoverFallback } from '@/lib/music/catalogApi'

/** Album cover: shows the Cover Art Archive image. When the CAA image 404s (common for live
 *  bootlegs / broadcasts), it falls back to iTunes cover art — but only if the caller passes the
 *  album identity (artist + album), and only lazily, once CAA has actually failed. Falls back to a
 *  clean disc tile when neither source has art (no broken-image icon). */
export function AlbumCover({ coverUrl, artist, album, className }: {
  coverUrl: string | null; artist?: string; album?: string; className?: string
}) {
  const canFallback = !!(artist && album)
  // 'caa' → the constructed Cover Art Archive URL; 'itunes' → the iTunes fallback; 'none' → disc.
  const [stage, setStage] = useState<'caa' | 'itunes' | 'none'>(coverUrl ? 'caa' : (canFallback ? 'itunes' : 'none'))
  const { data: fb } = useQuery({
    queryKey: ['album-cover-fallback', artist, album],
    queryFn: () => getAlbumCoverFallback(artist!, album!),
    enabled: stage === 'itunes' && canFallback, staleTime: Infinity,
  })
  const src = stage === 'caa' ? coverUrl : stage === 'itunes' ? (fb?.coverUrl ?? null) : null
  return (
    <div className={cn('relative grid place-items-center overflow-hidden bg-gradient-to-br from-brand/30 to-brand/10', className)}>
      <Disc3 className="absolute size-1/3 text-brand/50" />
      {src && (
        <img key={src} src={proxyImg(src)} alt="" loading="lazy" className="relative size-full object-cover"
          onError={() => setStage(s => (s === 'caa' && canFallback) ? 'itunes' : 'none')} />
      )}
    </div>
  )
}

/** Artist avatar: lazily fetches the artist's photo (cached) and shows it, with a person-icon
 *  fallback while loading or when no image exists. Passing the MusicBrainz mbid lets the backend
 *  resolve images via Wikidata → Wikimedia Commons that a bare-name Wikipedia lookup would miss. */
export function ArtistAvatar({ name, mbid, className }: { name: string; mbid?: string; className?: string }) {
  const { data } = useQuery({
    queryKey: ['music-artist-img', mbid ?? name], queryFn: () => getArtistInfo(name, mbid),
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
