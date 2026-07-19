// Square album art for a song, the way modern players present it. Local/Plex refs use
// their own library art; YouTube refs upgrade from the 16:9 (often letterboxed) video
// thumbnail to real square album art via /api/music/info/art the moment it resolves.
// Always renders a music-note gradient behind, so a miss is a tasteful tile - not a hole.

import { useQuery } from '@tanstack/react-query'
import { Music4 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { artUrlForRef, isYouTubeRef } from '@/lib/music/trackRef'

/** Shared factory so the music idle prefetcher warms the exact per-tile art queries
 *  useSongArt reads (staleTime Infinity: art is immutable per song). */
export function songArtQueryOptions(artist: string, title: string) {
  return {
    queryKey: ['song-art', artist, title] as const,
    queryFn: () => fetchSongArt(artist, title),
    staleTime: Infinity,
    gcTime: 24 * 60 * 60 * 1000,
  }
}

async function fetchSongArt(artist: string, title: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/music/info/art?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}&v=2`, { credentials: 'include' })
    if (!r.ok) return null
    const body = await r.json() as { url?: string }
    return body.url ?? null
  } catch {
    return null
  }
}

/** `w` = device-pixel width bucket for the proxied bytes (default 480, right for tiles
 *  and rails). Pass `null` on hero/player surfaces that want the full-res original. */
export function useSongArt(trackRef: string | null | undefined, title?: string | null, artist?: string | null, w: number | null = 480): string | null {
  // No ref at all (catalog/chart entries known only by artist+title) → pure iTunes lookup.
  const yt = !trackRef || isYouTubeRef(trackRef)
  const { data } = useQuery({
    queryKey: ['song-art', artist ?? '', title ?? ''],
    queryFn: () => fetchSongArt(artist!, title!),
    enabled: yt && !!artist && !!title,
    staleTime: Infinity,
    gcTime: 24 * 60 * 60 * 1000,
  })
  if (!trackRef) return data ? proxyImg(data, w ?? undefined) : null
  if (!yt) return artUrlForRef(trackRef)
  return data ? proxyImg(data, w ?? undefined) : artUrlForRef(trackRef)
}

/** Square song tile. Pass trackRef=null for catalog/chart entries known only by artist+title. */
export function SongArt({ trackRef, title, artist, className, rounded = 'rounded-card', w = 480 }: {
  trackRef: string | null
  title?: string | null
  artist?: string | null
  className?: string
  rounded?: string
  w?: number | null
}) {
  const url = useSongArt(trackRef, title, artist, w)
  return (
    <div className={cn('relative grid shrink-0 place-items-center overflow-hidden bg-gradient-to-br from-brand/25 to-brand/5', rounded, className)}>
      <Music4 className="absolute size-[28%] text-brand/50" />
      {url && (
        <img src={url} alt="" loading="lazy" draggable={false}
          className="relative size-full object-cover"
          onError={e => { e.currentTarget.style.visibility = 'hidden' }} />
      )}
    </div>
  )
}
