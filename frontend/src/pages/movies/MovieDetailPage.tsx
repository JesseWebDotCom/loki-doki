import { useState } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Clapperboard, ExternalLink, Loader2, Mic, Music, Play, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { PageShell } from '@/components/shared/PageShell'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useYoutubePlayback } from '@/context/YoutubePlaybackContext'
import { Backdrop } from '@/components/media/Backdrop'
import { SectionHeading } from '@/components/media/TitleCard'
import { MediaStationButton, ParentsGuideSection, ReviewsSection, SoundtrackAlbums, StreamingChips, TriviaSection, VideoRow } from '@/components/media/sections'
import { ShowtimesPanel } from '@/components/media/Showtimes'
import { WatchlistButton } from '@/components/media/WatchlistButton'
import { PlexBadge } from '@/components/media/PlexBadge'
import { MoviePodcastSection } from '@/components/media/PodcastSection'
import { MediaTabs } from '@/components/media/MediaTabs'
import { ActionBar, ActionButton, ActionIcon } from '@/components/media/ActionBar'
import {
  getMovie,
  getMovieMedia,
  getMovieOverview,
  getMovieParentsGuide,
  getMovieBackdrop,
  getMovieReviews,
  getMovieTrivia,
  getMoviePodcastApi,
  type MovieCore,
} from '@/lib/movies/api'
import { mediaImg } from '@/lib/shows/api'
import { fetchShowSoundtrack } from '@/lib/music/musicInfo'

const MOVIES_GRADIENT = 'linear-gradient(135deg,#1e1b4b,#6d28d9)'

function Hero({ bundle, actions }: { bundle: MovieCore; actions?: React.ReactNode }) {
  const d = bundle.details
  const [ok, setOk] = useState(true)
  return (
    <div className="flex flex-col gap-5 sm:flex-row">
      <div className="mx-auto w-[160px] shrink-0 sm:mx-0">
        <div className="aspect-[2/3] overflow-hidden rounded-xl bg-muted shadow-lg ring-1 ring-border/40">
          {d.poster && ok ? (
            <img src={mediaImg(d.poster)} alt={d.title} className="size-full object-cover" onError={() => setOk(false)} />
          ) : (
            <div className="flex size-full items-center justify-center">
              <Clapperboard className="size-8 text-muted-foreground/40" />
            </div>
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div>
          <h1 className="text-2xl font-bold leading-tight sm:text-3xl">{d.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {[d.year, d.runtimeMinutes ? `${d.runtimeMinutes} min` : null].filter(Boolean).join(' · ')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {d.ageCertification && <Badge variant="outline">{d.ageCertification}</Badge>}
          {bundle.inTheaters && <Badge className="border-0 bg-violet-600/20 text-violet-300">In Theaters</Badge>}
        </div>

        {d.summary && <p className="text-sm leading-relaxed text-muted-foreground">{d.summary}</p>}

        {actions && <div className="mt-auto pt-2">{actions}</div>}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <SectionHeading>{title}</SectionHeading>
      {children}
    </section>
  )
}

function fmtMs(ms: number | null): string {
  if (!ms) return ''
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

function SoundtrackSection({ movieTitle }: { movieTitle: string }) {
  const navigate = useNavigate()
  const { data, isLoading } = useQuery({
    queryKey: ['movie-soundtrack', movieTitle],
    queryFn: () => fetchShowSoundtrack(movieTitle),
    staleTime: 60 * 60 * 1000,
  })
  if (isLoading || !data?.songs.length) return null
  return (
    <Section title="Soundtrack">
      <div className="space-y-1">
        {data.songs.map((song, i) => (
          <button key={i} type="button"
            onClick={() => navigate(`/music/browse?q=${encodeURIComponent(song.title)}`)}
            className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/40">
            <span className="w-5 shrink-0 text-right text-xs text-muted-foreground">{i + 1}</span>
            <Music className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm">{song.title}</span>
            {song.durationMs && <span className="shrink-0 text-xs text-muted-foreground">{fmtMs(song.durationMs)}</span>}
          </button>
        ))}
      </div>
    </Section>
  )
}

function DetailBody({ title, year }: { title: string; year: number | null }) {
  const [tab, setTab] = useState<string | null>(null)
  const { playExpanded } = useYoutubePlayback()
  const { data: bundle, isLoading, isError } = useQuery({
    queryKey: ['movie', title, year],
    queryFn: () => getMovie(title, year),
    staleTime: 15 * 60 * 1000,
  })
  const { data: reviews, isLoading: reviewsLoading } = useQuery({
    queryKey: ['movie-reviews', title, year],
    queryFn: () => getMovieReviews(title, year),
    enabled: !!bundle,
    staleTime: 60 * 60 * 1000,
  })
  const { data: trivia, isLoading: triviaLoading } = useQuery({
    queryKey: ['movie-trivia', title, year],
    queryFn: () => getMovieTrivia(title, year),
    enabled: !!bundle,
    staleTime: 60 * 60 * 1000,
  })
  // Enrichments stream into their own sections (streaming comes with the core lookup).
  const { data: media, isLoading: mediaLoading } = useQuery({
    queryKey: ['movie-media', title, year],
    queryFn: () => getMovieMedia(title, year),
    enabled: !!bundle,
    staleTime: 60 * 60 * 1000,
  })
  const { data: overview, isLoading: overviewLoading } = useQuery({
    queryKey: ['movie-overview', title, year],
    queryFn: () => getMovieOverview(title, year),
    enabled: !!bundle,
    staleTime: 60 * 60 * 1000,
  })
  const { data: parentsGuide } = useQuery({
    queryKey: ['movie-parents-guide', title, year],
    queryFn: () => getMovieParentsGuide(title, year),
    enabled: !!bundle,
    staleTime: 60 * 60 * 1000,
  })
  const { data: podcastData } = useQuery({
    queryKey: ['movie-podcast', title],
    queryFn: () => getMoviePodcastApi(title),
    enabled: !!bundle,
    staleTime: 5 * 60 * 1000,
  })

  usePublishUIContext({
    label: 'Movies',
    description: bundle ? `User is viewing the movie "${bundle.details.title}".` : 'User is opening a movie.',
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (isError || !bundle) {
    return (
      <div className="flex flex-col items-center gap-2 py-32 text-center text-muted-foreground">
        <Clapperboard className="size-10 opacity-20" />
        <p className="text-sm">Couldn&rsquo;t load this movie.</p>
      </div>
    )
  }

  const videos = media ? [media.trailer, ...media.clips].filter((v): v is NonNullable<typeof v> => !!v) : []
  const d = bundle.details

  const watchNode = (
    <div className="space-y-8">
      <div>
        <SectionHeading>Where to Watch</SectionHeading>
        <StreamingChips
          providers={bundle.streaming.providers}
          theaters={bundle.streaming.theaters}
          justwatchUrl={bundle.streaming.justwatchUrl}
          webProviders={bundle.streaming.webProviders}
        />
      </div>
      {bundle.inTheaters && (
        <div>
          <SectionHeading>Showtimes Near You</SectionHeading>
          <ShowtimesPanel title={d.title} />
        </div>
      )}
    </div>
  )

  const videosNode = (
    <div className="space-y-8">
      {mediaLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Finding trailers…
        </div>
      ) : videos.length > 0 ? (
        <VideoRow title="Trailers & clips" videos={videos} />
      ) : (
        <p className="text-sm text-muted-foreground">No videos found.</p>
      )}
      {media && media.music.length > 0 && <VideoRow title="Theme & soundtrack" videos={media.music} />}
      {media && media.soundtrackAlbums.length > 0 && <SoundtrackAlbums albums={media.soundtrackAlbums} />}
      <SoundtrackSection movieTitle={d.title} />
    </div>
  )

  const aboutNode = (
    <div className="space-y-8">
      {overviewLoading ? (
        <p className="text-sm text-muted-foreground">Loading overview…</p>
      ) : overview ? (
        <div>
          <SectionHeading>Overview</SectionHeading>
          <p className="text-sm leading-relaxed text-muted-foreground">{overview.text}</p>
          <a href={overview.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-brand hover:underline">
            <ExternalLink className="size-3" /> Wikipedia
          </a>
        </div>
      ) : null}
      {parentsGuide && (
        <div>
          <SectionHeading>Parents Guide</SectionHeading>
          <ParentsGuideSection guide={parentsGuide} />
        </div>
      )}
      <div>
        <SectionHeading>Did You Know?</SectionHeading>
        <TriviaSection facts={trivia} loading={triviaLoading} />
      </div>
    </div>
  )

  const actions = (
    <ActionBar>
      <WatchlistButton
        mediaType="movie"
        refId={d.title}
        title={d.title}
        posterUrl={d.poster}
        subtitle={d.year ? String(d.year) : null}
      />
      {media?.trailer && (
        <ActionButton
          icon={Play}
          label="Trailer"
          onClick={() =>
            playExpanded({
              videoId: media.trailer!.videoId,
              title: media.trailer!.title,
              author: media.trailer!.author,
              channelThumb: media.trailer!.channelThumb,
              durationSec: media.trailer!.durationSec,
              thumbnail: media.trailer!.thumbnailUrl ?? undefined,
            })
          }
        />
      )}
      <ActionButton icon={Mic} label="Podcast" variant={podcastData ? 'primary' : 'secondary'} onClick={() => setTab('podcast')} />
      <MediaStationButton title={d.title} posterUrl={d.poster} kind="movie" />
      <PlexBadge type="movie" title={d.title} year={d.year} />
      {d.justwatchUrl && <ActionIcon icon={ExternalLink} href={d.justwatchUrl} title="JustWatch" />}
    </ActionBar>
  )

  return (
    <div className="relative z-10 space-y-6 pb-16">
      <Hero bundle={bundle} actions={actions} />

      <MediaTabs
        active={tab ?? 'about'}
        onChange={setTab}
        tabs={[
          { key: 'about', label: 'About', node: aboutNode },
          { key: 'watch', label: bundle.inTheaters ? 'Watch & Showtimes' : 'Where to Watch', node: watchNode },
          { key: 'videos', label: 'Media', node: videosNode },
          { key: 'reviews', label: 'Reviews', node: <ReviewsSection reviews={reviews} loading={reviewsLoading} /> },
          {
            key: 'podcast',
            label: 'Podcast',
            node: <MoviePodcastSection title={d.title} year={d.year} overview={overview?.text ?? d.summary} />,
          },
        ]}
      />
    </div>
  )
}

export function MovieDetailPage() {
  const { ref = '' } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const title = decodeURIComponent(ref)
  const yearRaw = params.get('year')
  const year = yearRaw && /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null

  const { data: core } = useQuery({
    queryKey: ['movie', title, year],
    queryFn: () => getMovie(title, year),
    staleTime: 15 * 60 * 1000,
  })
  const { data: betterBackdrop } = useQuery({
    queryKey: ['movie-backdrop', title, year],
    queryFn: () => getMovieBackdrop(title, year),
    enabled: !!core,
    staleTime: 60 * 60 * 1000,
  })

  return (
    <PageShell gradient={MOVIES_GRADIENT} GhostIcon={Clapperboard}>
      <Backdrop url={betterBackdrop ?? core?.backdrop} />
      <div className="relative px-5 pb-12 pt-4">
        <button
          type="button"
          onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/movies'))}
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Back
        </button>
        <DetailBody title={title} year={year} />
      </div>
    </PageShell>
  )
}
