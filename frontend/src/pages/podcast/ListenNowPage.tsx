import { Link } from 'react-router-dom'
import { Play, Headphones, Mic, Music, Download, Tv, BookOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { usePodcastPlayback } from '@/context/PodcastPlaybackContext'
import { usePodcastFeed, continueListening, newEpisodes, type FeedEpisode } from '@/lib/podcast/useFeed'
import { ShowCover } from '@/components/podcast/ShowCover'
import { EpisodeRow } from '@/components/podcast/EpisodeRow'
import { SectionHead, CardGridSkeleton } from '@/components/store/SectionHead'
import { toTrack } from '@/lib/podcast/api'
import { fmtTime } from '@/lib/podcast/format'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { getAppByPath } from '@/lib/appCategories'

export function ListenNowPage() {
  const { data, isLoading } = usePodcastFeed()
  const { play } = usePodcastPlayback()

  const cont = data ? continueListening(data.all) : []
  const fresh = data ? newEpisodes(data.all) : []
  const shows = data?.shows ?? []

  return (
    <PageContainer width="wide" className="space-y-9 py-6 pb-24">
      <PageHeader title="Listen Now" className="pt-0 pb-0" />
      {isLoading ? (
        <CardGridSkeleton count={4} />
      ) : data && data.all.length === 0 ? (
        <EmptyAppState
          icon={Headphones}
          gradient={getAppByPath('/podcasts')?.gradient}
          title="AI-produced podcasts from anything you watch"
          tagline="Your companion writes, narrates, and produces a full podcast episode for any show, movie, or YouTube content - with music, stingers, and chapters - entirely offline."
          actions={
            <Link to="/podcasts/library">
              <Button><Mic className="mr-1.5 size-4" />Create your first show</Button>
            </Link>
          }
          features={[
            { icon: Mic, title: 'AI narration', desc: 'Your companion hosts every episode in their own voice and style.' },
            { icon: Music, title: 'Original stingers', desc: 'Intro and outro music generated live to match each show\'s mood.' },
            { icon: Tv, title: 'Shows, movies & YouTube', desc: 'Batch a show by season, dive deep on a movie, or turn a YouTube video, channel, or playlist into episodes.' },
            { icon: BookOpen, title: 'Chapter markers', desc: 'Auto-timestamps let you jump straight to any segment of an episode.' },
            { icon: Play, title: 'Continuous playback', desc: 'A persistent mini player keeps your episode going as you navigate.' },
            { icon: Download, title: 'Take it offline', desc: 'Download episodes to your device and listen anywhere.' },
          ]}
          footnote="All narration and music runs on your local hardware - no external APIs required."
        />
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
    </PageContainer>
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
        {/* design-ok(backdrop-blur-outside-chrome): over artwork */}
        <span className="absolute bottom-2 left-2 flex size-10 items-center justify-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur transition-opacity group-hover:opacity-100">
          <Play className="size-5 fill-current" />
        </span>
      </button>
      <p className="mt-2 truncate text-xs font-medium text-muted-foreground">{show.name}</p>
      <p className="truncate text-sm font-semibold">{episode.title}</p>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} /></div>
      {remain > 0 && <p className="mt-1 text-[11px] text-muted-foreground">{fmtTime(remain)} left</p>}
    </div>
  )
}
