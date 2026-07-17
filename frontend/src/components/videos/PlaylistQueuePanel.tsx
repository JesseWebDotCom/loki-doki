import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ListVideo, ThumbsUp } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { SOURCE_META, MINE_META } from '@/lib/videos/sources'
import { VideoThumb } from '@/components/youtube/media'
import { playlistWatchHref } from '@/lib/videos/playlistWatch'
import { castVote, listVotes, type VideoSource } from '@/lib/videos/api'
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
  // Movie-night voting: household-wide tallies over this shared playlist, one vote per
  // person per entry, toggled off by voting again.
  const qc = useQueryClient()
  const votesKey = ['videos-votes', playlistId]
  const { data: votesData } = useQuery({ queryKey: votesKey, queryFn: () => listVotes(playlistId), staleTime: 30_000 })
  const tallies = votesData?.votes ?? []
  const totalVotes = votesData?.total ?? 0
  const tallyFor = (source: string, videoId: string) => tallies.find((t) => t.source === source && t.videoId === videoId)
  const leaderKey = tallies[0] && tallies[0].count > 0 ? `${tallies[0].source}:${tallies[0].videoId}` : null
  const vote = useMutation({
    mutationFn: ({ source, videoId, vote: v }: { source: VideoSource; videoId: string; vote: boolean }) =>
      castVote(playlistId, source, videoId, v),
    onSuccess: () => qc.invalidateQueries({ queryKey: votesKey }),
    onError: () => toast.error('Could not save your vote'),
  })

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
          // Mine entries have no watch page and can't be voted for; narrowing here keeps
          // the vote handler's closure typed (a JSX-level guard doesn't reach into it).
          const votable: VideoSource | null = v.videoSource === 'mine' ? null : v.videoSource
          const tally = votable ? tallyFor(votable, v.videoId) : undefined
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
              {/* Movie-night voting: tap the pill to back this pick. Tallies are
                  household-wide; the leader gets the accent. */}
              {votable && (
                <button
                  onClick={(e) => {
                    e.preventDefault(); e.stopPropagation()
                    vote.mutate({ source: votable, videoId: v.videoId, vote: !tally?.mine })
                  }}
                  aria-label={tally?.mine ? `Remove your vote for ${v.title}` : `Vote for ${v.title}`}
                  className={cn('flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold transition',
                    tally?.mine
                      ? 'bg-brand/20 text-brand'
                      : 'bg-foreground/8 text-muted-foreground hover:bg-foreground/15 hover:text-foreground',
                    leaderKey === `${votable}:${v.videoId}` && 'ring-1 ring-brand/50')}>
                  <ThumbsUp className={cn('size-3', tally?.mine && 'fill-current')} />
                  {tally?.count ?? 0}
                </button>
              )}
            </div>
          )
          if (v.videoSource === 'mine') return <div key={v.id} className="cursor-not-allowed opacity-50" title="Mine content has no watch page">{row}</div>
          return <Link key={v.id} to={playlistWatchHref(v.videoSource, v.videoId, playlistId, i)}>{row}</Link>
        })}
      </div>
      {totalVotes > 0 && (
        <p className="mt-2 px-1 text-[11px] text-muted-foreground">
          Movie night: {totalVotes} {totalVotes === 1 ? 'vote' : 'votes'} so far.
        </p>
      )}
    </Card>
  )
}
