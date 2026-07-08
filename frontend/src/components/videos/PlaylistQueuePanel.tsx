import { Link } from 'react-router-dom'
import { ListVideo } from 'lucide-react'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { SOURCE_META, MINE_META } from '@/lib/videos/sources'
import { VideoThumb } from '@/components/youtube/media'
import { playlistWatchHref } from '@/lib/videos/playlistWatch'
import { Card } from '@/components/ui/card'
import type { YtPlaylistVideo } from '@/lib/youtube/playlists'

/** The side-panel queue for a full-page playlist playthrough — replaces the algorithmic
 *  "Up next" list on the watch page when you got here via a playlist's "Play all" or a row
 *  click. Mine entries show (so the list stays complete) but aren't links — there's no watch
 *  page to send them to. */
export function PlaylistQueuePanel({ playlistId, playlistName, videos, pos }: {
  playlistId: string
  playlistName: string | null
  videos: YtPlaylistVideo[]
  pos: number
}) {
  return (
    <Card className="p-3">
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground"><ListVideo className="size-3.5" aria-hidden /> Playing from playlist</p>
          <Link to={`/videos/youtube/my-playlist/${playlistId}`} className="truncate text-sm font-semibold hover:underline">
            {playlistName ?? 'Playlist'}
          </Link>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{Math.min(pos + 1, videos.length)}/{videos.length}</span>
      </div>
      <div className="max-h-[60vh] space-y-1 overflow-y-auto">
        {videos.map((v, i) => {
          const active = i === pos
          const badge = v.videoSource === 'mine' ? MINE_META : SOURCE_META[v.videoSource]
          const row = (
            <div className={cn('flex items-center gap-2.5 rounded-control p-1.5 transition-colors', active ? 'bg-accent' : 'hover:bg-accent/50')}>
              <span className={cn('w-4 shrink-0 text-center text-xs tabular-nums', active ? 'text-[var(--yt-accent-fg)]' : 'text-muted-foreground')}>{i + 1}</span>
              <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-control bg-muted">
                {v.videoSource === 'youtube' ? (
                  <VideoThumb videoId={v.videoId} title={v.title} className="size-full" />
                ) : v.thumbnailUrl ? (
                  <img src={proxyImg(v.thumbnailUrl)} alt="" loading="lazy" className="size-full object-cover" />
                ) : null}
                <span className={cn('absolute left-1 top-1 inline-flex items-center rounded-full p-0.5', badge.badgeClass)}>
                  <badge.icon className="size-2" aria-hidden />
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <p className={cn('line-clamp-2 text-xs font-medium leading-snug', active && 'text-[var(--yt-accent-fg)]')}>{v.title}</p>
                {v.author && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{v.author}</p>}
              </div>
            </div>
          )
          if (v.videoSource === 'mine') return <div key={v.id} className="cursor-not-allowed opacity-50" title="Mine content has no watch page">{row}</div>
          return <Link key={v.id} to={playlistWatchHref(v.videoSource, v.videoId, playlistId, i)}>{row}</Link>
        })}
      </div>
    </Card>
  )
}
