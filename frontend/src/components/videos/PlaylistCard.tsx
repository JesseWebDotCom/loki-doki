import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ListVideo } from 'lucide-react'
import { proxyImg } from '@/lib/img'
import type { VideoSource } from '@/lib/videos/api'

/** Minimal shape a playlist card needs; satisfied by both search and channel-tab rows. */
export interface PlaylistCardData {
  playlistId: string
  title: string
  videoCount: number | null
  thumbnailUrl: string | null
  author: string | null
}

interface PlaylistCardProps {
  p: PlaylistCardData
  /** Which source's watch route to link into. Defaults to YouTube (the original caller). */
  source?: VideoSource
  /** Image proxy to route the cover through. Defaults to the generic /api/img; YouTube
   *  passes ytImageProxy so Google-CDN thumbnails use YouTube's own cache. */
  proxy?: (url: string) => string
}

/** Cover art: a real thumbnail (ring so a near-black/dark frame still reads as "present"
 *  against the app's dark theme, not a blank void), falling back to the ListVideo icon on
 *  a missing URL or a genuine load failure. */
function Cover({ thumbnailUrl, proxy, title }: { thumbnailUrl: string | null; proxy: (url: string) => string; title: string }) {
  const [failed, setFailed] = useState(false)
  if (!thumbnailUrl || failed) {
    return <div className="flex size-full items-center justify-center ring-1 ring-inset ring-border/40"><ListVideo className="size-8 text-muted-foreground/40" /></div>
  }
  return (
    <img src={proxy(thumbnailUrl)} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)}
      className="size-full object-cover ring-1 ring-inset ring-border/40 transition group-hover:scale-105" title={title} />
  )
}

/** A single playlist card (search results, a creator's Playlists tab, playlist rails).
 *  Source-agnostic: shared by the YouTube channel page and the non-YouTube source creator
 *  pages so every playlist grid looks identical. */
export function PlaylistCard({ p, source = 'youtube', proxy = proxyImg }: PlaylistCardProps) {
  return (
    <Link to={`/videos/${source}/playlist/${encodeURIComponent(p.playlistId)}`}
      state={{ title: p.title, thumbnailUrl: p.thumbnailUrl, videoCount: p.videoCount }} className="group">
      <div className="relative aspect-video overflow-hidden rounded-card bg-muted">
        <Cover thumbnailUrl={p.thumbnailUrl} proxy={proxy} title={p.title} />
        <div className="absolute bottom-0 right-0 flex items-center gap-1 rounded-tl-control bg-black/80 px-2 py-1 text-[11px] font-semibold text-white">
          <ListVideo className="size-3" /> {p.videoCount != null ? `${p.videoCount}` : 'Playlist'}
        </div>
      </div>
      <p className="mt-1.5 line-clamp-2 text-sm font-semibold leading-snug">{p.title}</p>
      {p.author && <p className="truncate text-xs text-muted-foreground">{p.author}</p>}
    </Link>
  )
}

/** Full-width horizontal playlist row (list view), matching PlaylistCard's target/badges. */
export function PlaylistListRow({ p, source = 'youtube', proxy = proxyImg }: PlaylistCardProps) {
  return (
    <Link to={`/videos/${source}/playlist/${encodeURIComponent(p.playlistId)}`}
      state={{ title: p.title, thumbnailUrl: p.thumbnailUrl, videoCount: p.videoCount }}
      className="group flex gap-3 rounded-card p-1.5 transition-colors hover:bg-accent/50 sm:gap-4">
      <div className="relative aspect-video w-40 shrink-0 overflow-hidden rounded-card bg-muted sm:w-56">
        <Cover thumbnailUrl={p.thumbnailUrl} proxy={proxy} title={p.title} />
        <div className="absolute bottom-0 right-0 flex items-center gap-1 rounded-tl-control bg-black/80 px-2 py-1 text-[11px] font-semibold text-white">
          <ListVideo className="size-3" /> {p.videoCount != null ? `${p.videoCount}` : 'Playlist'}
        </div>
      </div>
      <div className="min-w-0 flex-1 py-0.5">
        <p className="line-clamp-2 text-sm font-semibold leading-snug sm:text-[15px]">{p.title}</p>
        {p.author && <p className="mt-1 truncate text-xs text-muted-foreground">{p.author}</p>}
        {p.videoCount != null && <p className="mt-0.5 truncate text-xs text-muted-foreground">{p.videoCount} {p.videoCount === 1 ? 'video' : 'videos'}</p>}
      </div>
    </Link>
  )
}
