import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Play, Headphones, Mic, Music, Download, Tv, BookOpen, Podcast } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { usePodcastPlayback } from '@/context/PodcastPlaybackContext'
import { usePodcastFeed, continueListening, newEpisodes, type FeedEpisode } from '@/lib/podcast/useFeed'
import { ShowCover } from '@/components/podcast/ShowCover'
import { EpisodeRow } from '@/components/podcast/EpisodeRow'
import { DirectoryCard } from '@/components/podcast/DirectoryCard'
import { CardGridSkeleton } from '@/components/store/SectionHead'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { coverUrl, toTrack, getCharts, type Show } from '@/lib/podcast/api'
import { ArtBillboard, type ArtBillboardItem } from '@/components/shared/ArtBillboard'
import { fmtTime } from '@/lib/podcast/format'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { PageContainer } from '@/components/shared/PageContainer'
import { getAppByPath } from '@/lib/appCategories'

export function ListenNowPage() {
  const { data, isLoading } = usePodcastFeed()
  const { play } = usePodcastPlayback()
  // Same query key as the Browse page so the charts fetch is shared between the two.
  const { data: charts } = useQuery({
    queryKey: ['podcast-dir-charts', null],
    queryFn: () => getCharts(null),
    staleTime: 30 * 60 * 1000,
  })

  const cont = data ? continueListening(data.all) : []
  const fresh = data ? newEpisodes(data.all) : []
  const shows = data?.shows ?? []
  // "Your podcasts" = real RSS subscriptions; "Your shows" = AI-produced shows.
  const subscriptions = shows.filter((s) => s.source === 'rss')
  const aiShows = shows.filter((s) => s.source !== 'rss')
  const popular = charts?.results ?? []
  const libraryEmpty = shows.length === 0 && (data?.all.length ?? 0) === 0

  // Billboard: resume where you left off, else spotlight your library.
  const billboardItems: ArtBillboardItem[] = cont.length > 0
    ? cont.slice(0, 6).map((x): ArtBillboardItem => ({
        key: x.episode.id,
        title: x.episode.title,
        subtitle: x.show.name,
        art: coverUrl(x.show.id),
        onClick: () => play(toTrack(x.episode, x.show), x.episode.watchState?.positionSec ?? 0),
        pillLabel: 'Resume',
        PillIcon: Play,
      }))
    : shows.slice(0, 6).map((s): ArtBillboardItem => ({
        key: s.id,
        title: s.name,
        subtitle: showSubtitle(s),
        art: coverUrl(s.id),
        to: `/podcasts/show/${s.id}`,
        pillLabel: s.source === 'rss' ? 'Open podcast' : 'Open show',
        PillIcon: s.source === 'rss' ? Podcast : Headphones,
      }))

  const popularSection = popular.length > 0 && (
    <section>
      <SectionHeader title="Popular podcasts" to="/podcasts/browse" className="mb-4" />
      <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
        {popular.slice(0, 12).map((r, i) => (
          <div key={r.itunesId ?? r.feedUrl ?? i} className="w-44 shrink-0">
            <DirectoryCard result={r} />
          </div>
        ))}
      </div>
    </section>
  )

  // No PageHeader: the rail states where we are and the billboard is the focal point.
  return (
    <PageContainer width="wide" className="space-y-9 py-6 pb-24">
      {isLoading ? (
        <CardGridSkeleton count={4} />
      ) : data && libraryEmpty ? (
        <>
          <EmptyAppState
            icon={Headphones}
            gradient={getAppByPath('/podcasts')?.gradient}
            title="AI-produced podcasts from anything you watch"
            tagline="Your companion writes, narrates, and produces a full podcast episode for any show, movie, or YouTube content - with music, stingers, and chapters - entirely offline."
            actions={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Link to="/podcasts/library">
                  <Button><Mic className="mr-1.5 size-4" />Create your first show</Button>
                </Link>
                <Link to="/podcasts/browse">
                  <Button variant="outline"><Podcast className="mr-1.5 size-4" />Browse real podcasts</Button>
                </Link>
              </div>
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
          {popularSection}
        </>
      ) : (
        <>
          {billboardItems.length > 0 && (
            <ArtBillboard
              eyebrow={cont.length > 0 ? 'Continue listening' : 'Your library'}
              items={billboardItems}
            />
          )}

          {cont.length > 0 && (
            <section>
              <SectionHeader title="Continue listening" className="mb-4" />
              <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
                {cont.map(x => <ContinueCard key={x.episode.id} item={x} onPlay={() => play(toTrack(x.episode, x.show), x.episode.watchState?.positionSec ?? 0)} />)}
              </div>
            </section>
          )}

          {subscriptions.length > 0 && (
            <section>
              <SectionHeader title="Your podcasts" to="/podcasts/library" count={subscriptions.length} className="mb-4" />
              <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
                {subscriptions.map(s => <ShowTile key={s.id} show={s} />)}
              </div>
            </section>
          )}

          {aiShows.length > 0 && (
            <section>
              <SectionHeader title="Your shows" to="/podcasts/library" count={aiShows.length} className="mb-4" />
              <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
                {aiShows.map(s => <ShowTile key={s.id} show={s} />)}
              </div>
            </section>
          )}

          {popularSection}

          {fresh.length > 0 && (
            <section>
              <SectionHeader title="New episodes" className="mb-4" />
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

function showSubtitle(s: Show): string {
  if (s.source === 'rss') return s.author ?? 'Podcast'
  return s.isOwn ? 'Your show' : `by ${s.ownerName}`
}

function ShowTile({ show }: { show: Show }) {
  return (
    <Link to={`/podcasts/show/${show.id}`} className="w-36 shrink-0">
      <ShowCover showId={show.id} title={show.name} size={144} className="w-36" />
      <p className="mt-2 truncate text-sm font-semibold">{show.name}</p>
      <p className="truncate text-xs text-muted-foreground">{showSubtitle(show)}</p>
    </Link>
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
