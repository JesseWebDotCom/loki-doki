import { Link } from 'react-router-dom'
import { Play, Radio } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { usePodcastPlayback } from '@/context/PodcastPlaybackContext'
import { usePodcastFeed, continueListening, newEpisodes, type FeedEpisode } from '@/lib/podcast/useFeed'
import { ShowCover } from '@/components/podcast/ShowCover'
import { EpisodeRow } from '@/components/podcast/EpisodeRow'
import { SectionHead, CardGridSkeleton } from '@/components/store/SectionHead'
import { toTrack } from '@/lib/podcast/api'
import { fmtTime } from '@/lib/podcast/format'

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

export function ListenNowPage() {
  const { user } = useAuth()
  const { data, isLoading } = usePodcastFeed()
  const { play } = usePodcastPlayback()

  const cont = data ? continueListening(data.all) : []
  const fresh = data ? newEpisodes(data.all) : []
  const shows = data?.shows ?? []

  return (
    <div className="mx-auto max-w-5xl space-y-9 px-6 py-7 pb-24">
      <h1 className="text-3xl font-black tracking-tight">{greeting()}{user?.firstName ? `, ${user.firstName}` : ''}</h1>

      {isLoading ? (
        <CardGridSkeleton count={4} />
      ) : data && data.all.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-20 text-center">
          <Radio className="size-10 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">No episodes yet.</p>
          <Link to="/podcasts/library" className="text-sm font-medium text-brand hover:underline">Create your first show</Link>
        </div>
      ) : (
        <>
          {cont.length > 0 && (
            <section>
              <SectionHead title="Continue Listening" />
              <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
                {cont.map(x => <ContinueCard key={x.episode.id} item={x} onPlay={() => play(toTrack(x.episode, x.show), x.episode.watchState?.positionSec ?? 0)} />)}
              </div>
            </section>
          )}

          {shows.length > 0 && (
            <section>
              <SectionHead title="Your Shows" viewAllTo="/podcasts/library" />
              <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
                {shows.map(s => (
                  <Link key={s.id} to={`/podcasts/show/${s.id}`} className="w-36 shrink-0">
                    <ShowCover showId={s.id} title={s.name} size={144} className="w-36" />
                    <p className="mt-2 truncate text-sm font-semibold">{s.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{s.isOwn ? 'Your show' : `by ${s.ownerName}`}</p>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {fresh.length > 0 && (
            <section>
              <SectionHead title="New Episodes" />
              <div className="space-y-1">
                {fresh.slice(0, 12).map((x, i) => (
                  <EpisodeRow key={x.episode.id} episode={x.episode} show={x.show}
                    playlist={{ tracks: fresh.map(f => toTrack(f.episode, f.show)), index: i }} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

function ContinueCard({ item, onPlay }: { item: FeedEpisode; onPlay: () => void }) {
  const { episode, show } = item
  const remain = episode.durationSec && episode.watchState
    ? Math.max(0, episode.durationSec - episode.watchState.positionSec) : 0
  const pct = episode.durationSec && episode.watchState
    ? Math.min(100, (episode.watchState.positionSec / episode.durationSec) * 100) : 0
  return (
    <div className="w-56 shrink-0">
      <button onClick={onPlay} className="group relative block w-56">
        <ShowCover showId={show.id} title={show.name} size={224} className="w-56" />
        <span className="absolute bottom-2 left-2 flex size-10 items-center justify-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur transition-opacity group-hover:opacity-100">
          <Play className="size-5 fill-current" />
        </span>
      </button>
      <p className="mt-2 truncate text-xs font-medium text-muted-foreground">{show.name}</p>
      <p className="truncate text-sm font-semibold">{episode.title}</p>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} /></div>
      {remain > 0 && <p className="mt-1 text-[11px] text-muted-foreground">{fmtTime(remain)} left</p>}
    </div>
  )
}
