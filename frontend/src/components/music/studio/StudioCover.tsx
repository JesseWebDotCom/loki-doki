// Square cover art for Studio tracks / search results. Shows the real image when we have one
// (a same-origin URL, the server-cached cover.jpg for a track), otherwise a DETERMINISTIC
// generated cover (band+album hashed to a consistent poster) instead of a broken CAA request
// or a bare icon. Same approach as the rest of the Music app (AlbumCover) and the stadium
// project's deterministic art, so a coverless song never spams 404s or shows a placeholder.
import { useState } from 'react'
import { cn } from '@/lib/cn'
import { GeneratedAlbumCover } from '@/components/music/GeneratedAlbumCover'

export function StudioCover({ src, artist, album, className }: {
  src?: string | null; artist?: string | null; album?: string | null; className?: string
}) {
  const [failed, setFailed] = useState(false)
  const showImg = !!src && !failed
  return (
    <div className={cn('relative shrink-0 overflow-hidden rounded-control bg-gradient-to-br from-brand/30 to-brand/10', className)}>
      {!showImg && <GeneratedAlbumCover band={artist ?? undefined} album={album ?? undefined} className="absolute inset-0" />}
      {showImg && (
        <img src={src!} alt="" loading="lazy" onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover" />
      )}
    </div>
  )
}
