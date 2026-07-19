import { Link } from 'react-router-dom'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Play, Headphones, Mic, Podcast } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { usePodcastPlayback } from '@/context/PodcastPlaybackContext'
import { usePodcastFeed, continueListening, newEpisodes, type FeedEpisode } from '@/lib/podcast/useFeed'
import { ShowCover } from '@/components/podcast/ShowCover'
import { EpisodeRow } from '@/components/podcast/EpisodeRow'
import { DirectoryCard, previewHref } from '@/components/podcast/DirectoryCard'
import { CardGridSkeleton } from '@/components/store/SectionHead'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { coverUrl, toTrack, podcastChartsQueryOptions, getSuggestedPodcasts, type DirectoryResult, type Show } from '@/lib/podcast/api'
import { DismissableCard } from '@/components/shared/DismissableCard'
import { PitchBanner } from '@/components/shared/PitchBanner'
import { useSuggestionDismiss } from '@/hooks/useSuggestionDismiss'
import { ArtBillboard, type ArtBillboardItem } from '@/components/shared/ArtBillboard'
import { fmtTime } from '@/lib/podcast/format'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { PageContainer } from '@/components/shared/PageContainer'
import { getAppByPath } from '@/lib/appCategories'
import { proxyImg } from '@/lib/img'
import { useFamilyAudio } from '@/hooks/useFamilyAudio'
import { FamilyAudioBlockedCard } from '@/components/shared/FamilyAudioBlockedCard'
import type { PodcastFeed } from '@/lib/podcast/useFeed'

/** iTunes chart art comes back ~170px; mzstatic URLs encode the size, so ask for 600. */
function hiResArt(url: string | null): string | null {
  if (!url) return null
  return proxyImg(url.replace(/\/\d+x\d+(bb)?\.(png|jpg|jpeg)/i, '/600x600bb.$2'))
}

export function ListenNowPage() {
  const { data, isLoading } = usePodcastFeed()
  const { play } = usePodcastPlayback()
  // Family audio: allowlist-only profiles get the simplified kids lane instead of the
  // discovery surfaces (charts, suggestions, billboard). The feed itself is already
  // server-filtered to approved shows for these profiles.
  const { data: family } = useFamilyAudio()
  // Same query keys as the Browse page so chart fetches are shared between the two.
  const { data: charts } = useQuery({
    ...podcastChartsQueryOptions(null),
    enabled: !family?.allowlistOnly,
  })
  const genres = (charts?.genres ?? []).slice(0, 3)
  const genreCharts = useQueries({
    queries: genres.map((g) => podcastChartsQueryOptions(g.id)),
  })

  if (family?.allowlistOnly) {
    return <KidsListenNow feed={data} isLoading={isLoading} />
  }

  const cont = data ? continueListening(data.all) : []
  const fresh = data ? newEpisodes(data.all) : []
  const shows = data?.shows ?? []
  // "Your podcasts" = real RSS subscriptions; "Your shows" = AI-produced shows.
  const subscriptions = shows.filter((s) => s.source === 'rss')
  const aiShows = shows.filter((s) => s.source !== 'rss')
  const popular = charts?.results ?? []
  const libraryEmpty = shows.length === 0 && (data?.all.length ?? 0) === 0

  // Billboard: resume where you left off > spotlight your library > featured from the charts.
  const billboardEyebrow = cont.length > 0 ? 'Continue listening' : shows.length > 0 ? 'Your library' : 'Popular podcasts'
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
    : shows.length > 0
      ? shows.slice(0, 6).map((s): ArtBillboardItem => ({
          key: s.id,
          title: s.name,
          subtitle: showSubtitle(s),
          art: coverUrl(s.id),
          to: `/podcasts/show/${s.id}`,
          pillLabel: s.source === 'rss' ? 'Open podcast' : 'Open show',
          PillIcon: s.source === 'rss' ? Podcast : Headphones,
        }))
      : popular.slice(0, 6).map((r, i): ArtBillboardItem => ({
          key: String(r.itunesId ?? r.feedUrl ?? i),
          title: r.title,
          subtitle: r.author,
          art: hiResArt(r.artworkUrl),
          to: previewHref(r),
          pillLabel: 'Listen',
          PillIcon: Play,
        }))

  const popularSection = popular.length > 0 && (
    <ChartRail title="Popular podcasts" results={popular} />
  )
  const genreSections = genres.map((g, i) => {
    const results = genreCharts[i]?.data?.results ?? []
    if (results.length === 0) return null
    return <ChartRail key={g.id} title={g.name} results={results} />
  })

  // No PageHeader: the rail states where we are and the billboard is the focal point.
  return (
    <PageContainer width="wide" className="space-y-9 py-6 pb-24">
      {isLoading ? (
        <CardGridSkeleton count={4} />
      ) : data && libraryEmpty && popular.length === 0 ? (
        // Offline / directory unreachable and nothing in the library: full-page pitch.
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
            { icon: Podcast, title: 'Real podcasts too', desc: 'Subscribe to any show from the podcast directory and keep everything in one player.' },
            { icon: Play, title: 'Continuous playback', desc: 'A persistent mini player keeps your episode going as you navigate.' },
          ]}
          footnote="All narration and music runs on your local hardware - no external APIs required."
        />
      ) : (
        <>
          <FamilyAudioBlockedCard />
          {billboardItems.length > 0 && (
            <ArtBillboard eyebrow={billboardEyebrow} items={billboardItems} />
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

          {/* Nobody here has made an AI show yet: pitch it in one compact banner, not a whole page. */}
          {aiShows.length === 0 && (
            <PitchBanner
              prefKey="podcasts.createBannerDismissed"
              icon={Mic}
              gradient={getAppByPath('/podcasts')?.gradient}
              title="Make your own AI podcast"
              description="Your companion writes, narrates, and produces full episodes about any show, movie, or YouTube channel, with music, stingers, and chapters. All of it runs offline on your own hardware."
              action={
                <Link to="/podcasts/library">
                  <Button variant="secondary">
                    <Mic className="mr-1.5 size-4" />
                    Create a show
                  </Button>
                </Link>
              }
            />
          )}

          <SuggestedRail />

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

          {genreSections}
        </>
      )}
    </PageContainer>
  )
}

/** Family audio: the simplified Podcasts home for allowlist-only profiles. A big
 *  artwork grid of the parent-approved shows plus a "For you" stack of their newest
 *  episodes; no charts, suggestions, or directory rails. */
function KidsListenNow({ feed, isLoading }: { feed: PodcastFeed | undefined; isLoading: boolean }) {
  const { play } = usePodcastPlayback()
  const shows = feed?.shows ?? []
  const cont = feed ? continueListening(feed.all) : []
  const fresh = feed ? newEpisodes(feed.all) : []
  return (
    <PageContainer width="wide" className="space-y-9 py-6 pb-24">
      <FamilyAudioBlockedCard />
      {isLoading ? (
        <CardGridSkeleton count={4} />
      ) : shows.length === 0 ? (
        <EmptyAppState
          icon={Headphones}
          gradient={getAppByPath('/podcasts')?.gradient}
          title="No shows here yet"
          tagline="Ask a parent to add some shows for you, then they will show up right here."
        />
      ) : (
        <>
          {cont.length > 0 && (
            <section>
              <SectionHeader title="Continue listening" className="mb-4" />
              <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
                {cont.map(x => <ContinueCard key={x.episode.id} item={x} onPlay={() => play(toTrack(x.episode, x.show), x.episode.watchState?.positionSec ?? 0)} />)}
              </div>
            </section>
          )}

          <section>
            <SectionHeader title="Your shows" className="mb-4" />
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {shows.map(s => (
                <Link key={s.id} to={`/podcasts/show/${s.id}`} className="group">
                  <div className="aspect-square w-full">
                    <ShowCover showId={s.id} title={s.name} size={320} fill className="transition group-hover:opacity-90" />
                  </div>
                  <p className="mt-2 truncate text-sm font-semibold">{s.name}</p>
                </Link>
              ))}
            </div>
          </section>

          {fresh.length > 0 && (
            <section>
              <SectionHeader title="For you" className="mb-4" />
              <div className="space-y-1">
                {fresh.slice(0, 15).map((x, i) => (
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

/** One horizontally scrolling shelf of directory chart cards. */
function ChartRail({ title, results }: { title: string; results: DirectoryResult[] }) {
  return (
    <section>
      <SectionHeader title={title} to="/podcasts/browse" className="mb-4" />
      <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
        {results.slice(0, 12).map((r, i) => (
          <div key={r.itunesId ?? r.feedUrl ?? i} className="w-44 shrink-0">
            <DirectoryCard result={r} />
          </div>
        ))}
      </div>
    </section>
  )
}

/** "Suggested for you": interest-engine picks from the directory, matched to your
 *  listening. Hidden while empty or still building (charts cover discovery meanwhile);
 *  each card carries a "Not interested" X. */
function SuggestedRail() {
  const { data } = useQuery({
    queryKey: ['podcasts-suggested'],
    queryFn: getSuggestedPodcasts,
    staleTime: 5 * 60_000,
    refetchInterval: (query) => (query.state.data?.building ? 20_000 : false),
  })
  const { hidden, dismiss } = useSuggestionDismiss('podcasts')
  const items = (data?.items ?? []).filter((r) => !hidden.has(r.ref))
  if (!items.length) return null
  return (
    <section>
      <SectionHeader title="Suggested for you" className="mb-4" />
      <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
        {items.slice(0, 12).map((r) => (
          <div key={r.ref} className="w-44 shrink-0">
            <DismissableCard onDismiss={() => dismiss({ ref: r.ref, creatorName: r.author, title: r.title })}>
              <DirectoryCard result={r} />
            </DismissableCard>
          </div>
        ))}
      </div>
    </section>
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
