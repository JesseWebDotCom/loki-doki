import { useQuery } from '@tanstack/react-query'
import { Disc3, User } from 'lucide-react'
import { proxyImg } from '@/lib/img'
import { cn } from '@/lib/cn'
import { getArtistInfo } from '@/lib/music/catalogApi'

/** Album cover: shows the Cover Art Archive image, falling back cleanly to a disc tile when the
 *  release-group has no art (CAA 404s) instead of a broken-image icon. */
export function AlbumCover({ coverUrl, className }: { coverUrl: string | null; className?: string }) {
  return (
    <div className={cn('relative grid place-items-center overflow-hidden bg-gradient-to-br from-brand/30 to-brand/10', className)}>
      <Disc3 className="absolute size-1/3 text-brand/50" />
      {coverUrl && (
        <img src={proxyImg(coverUrl)} alt="" loading="lazy" className="relative size-full object-cover"
          onError={e => { e.currentTarget.style.visibility = 'hidden' }} />
      )}
    </div>
  )
}

/** Artist avatar: lazily fetches the artist's Wikipedia thumbnail (cached) and shows it, with a
 *  person-icon fallback while loading or when no image exists. */
export function ArtistAvatar({ name, className }: { name: string; className?: string }) {
  const { data } = useQuery({
    queryKey: ['music-artist-img', name], queryFn: () => getArtistInfo(name),
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
