import { useState } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Clapperboard, ExternalLink, Mic, Music, Play, Star, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useYoutubePlayback } from '@/context/YoutubePlaybackContext'
import { Backdrop } from '@/components/media/Backdrop'
import { DetailHero } from '@/components/media/DetailHero'
import { ArtAccentScope } from '@/components/shared/ArtAccentScope'
import { SectionHeading, TitleCard } from '@/components/media/TitleCard'
import { ScoresRow } from '@/components/media/ScoresRow'
import { RequestButton } from '@/components/media/MediaIntegrations'
import { RatingBadge } from '@/components/media/RatingBadge'
import { MediaStationButton, ParentsGuideSection, ReviewsSection, SoundtrackAlbums, StreamingChips, TriviaSection, VideoRow } from '@/components/media/sections'
import { ShowtimesPanel } from '@/components/media/Showtimes'
import { WatchlistButton } from '@/components/media/WatchlistButton'
import { PlexBadge } from '@/components/media/PlexBadge'
import { MoviePodcastSection } from '@/components/media/PodcastSection'
import { MediaTabs } from '@/components/media/MediaTabs'
import { ActionBar, ActionButton, ActionIcon } from '@/components/media/ActionBar'
import {
  getMovie,
  getMovieShowtimes,
  movieTo,
  getMovieMedia,
  getMovieOverview,
  getMovieParentsGuide,
  getMovieBackdrop,
  getMovieReviews,
  getMovieTrivia,
  getMoviePodcastApi,
} from '@/lib/movies/api'
import { mediaImg } from '@/lib/shows/api'
import { fetchShowSoundtrack } from '@/lib/music/musicInfo'

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
            className="flex w-full items-center gap-3 rounded-control px-2 py-2 text-left transition-colors hover:bg-muted/40">
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
    staleTime: 60 * 60 * 1000,
  })
  const { data: trivia, isLoading: triviaLoading } = useQuery({
    queryKey: ['movie-trivia', title, year],
    queryFn: () => getMovieTrivia(title, year),
    staleTime: 60 * 60 * 1000,
  })
  // Enrichments stream into their own sections (streaming comes with the core lookup).
  const { data: media, isLoading: mediaLoading } = useQuery({
    queryKey: ['movie-media', title, year],
    queryFn: () => getMovieMedia(title, year),
    staleTime: 60 * 60 * 1000,
  })
  const { data: overview, isLoading: overviewLoading } = useQuery({
    queryKey: ['movie-overview', title, year],
    queryFn: () => getMovieOverview(title, year),
    staleTime: 60 * 60 * 1000,
  })
  const { data: parentsGuide } = useQuery({
    queryKey: ['movie-parents-guide', title, year],
    queryFn: () => getMovieParentsGuide(title, year),
    staleTime: 60 * 60 * 1000,
  })
  const { data: podcastData } = useQuery({
    queryKey: ['movie-podcast', title],
    queryFn: () => getMoviePodcastApi(title),
    staleTime: 5 * 60 * 1000,
  })
  // Local-showtimes probe (Fandango, household ZIP resolved server-side). This decides whether
  // the movie is REALLY playing nearby. JustWatch's CINEMA flag misses titles Fandango has.
  const { data: localShowtimes } = useQuery({
    queryKey: ['movie-showtimes-auto', title],
    queryFn: () => getMovieShowtimes(title, ''),
    staleTime: 30 * 60 * 1000,
  })

  usePublishUIContext({
    label: 'Movies',
    description: bundle ? `User is viewing the movie "${bundle.details.title}".` : 'User is opening a movie.',
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Spinner size="lg" />
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
  // In theaters = JustWatch cinema offers OR actual local showtimes found near the user.
  const inTheatersNow = bundle.inTheaters || !!localShowtimes

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
      {inTheatersNow && (
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
          <Spinner /> Finding trailers…
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
      <RequestButton title={d.title} year={d.year} type="movie" />
      {bundle.imdbId && <ActionIcon icon={Star} href={`https://www.imdb.com/title/${bundle.imdbId}/`} title="IMDb" />}
      {d.justwatchUrl && <ActionIcon icon={ExternalLink} href={d.justwatchUrl} title="JustWatch" />}
    </ActionBar>
  )

  return (
    <div className="relative z-10 space-y-6 pb-16">
      <DetailHero
        poster={bundle.details.poster}
        title={bundle.details.title}
        meta={[bundle.details.year, bundle.details.runtimeMinutes ? `${bundle.details.runtimeMinutes} min` : null, bundle.directors.length ? `Dir. ${bundle.directors.join(', ')}` : null].filter(Boolean).join(' \u00b7 ')}
        badges={<>
          <RatingBadge rating={bundle.details.ageCertification} />
          {inTheatersNow && <Badge className="border-0 bg-brand/15 text-brand">In Theaters</Badge>}
          <ScoresRow scoring={bundle.scoring} />
        </>}
        summary={bundle.details.summary}
        actions={actions}
        FallbackIcon={Clapperboard}
      />

      <MediaTabs
        // In-theater movies open on Watch & Showtimes (the reason you'd open the page);
        // everything else opens on About. A manual tab pick always wins.
        active={tab ?? (inTheatersNow ? 'watch' : 'about')}
        onChange={setTab}
        tabs={[
          { key: 'about', label: 'About', node: aboutNode },
          { key: 'watch', label: inTheatersNow ? 'Watch & Showtimes' : 'Where to Watch', node: watchNode },
          { key: 'videos', label: 'Media', node: videosNode },
          ...(bundle.cast.length ? [{
            key: 'cast',
            label: 'Cast',
            node: (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {bundle.cast.map((c, i) => (
                  <div key={`${c.name}-${i}`} className="flex items-center gap-3 rounded-card border border-border/50 bg-card/40 p-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand">
                      <Users className="size-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{c.name}</p>
                      {c.character && <p className="truncate text-xs text-muted-foreground">{c.character}</p>}
                    </div>
                  </div>
                ))}
              </div>
            ),
          }] : []),
          { key: 'reviews', label: 'Reviews', node: <ReviewsSection reviews={reviews} loading={reviewsLoading} /> },
          {
            key: 'podcast',
            label: 'Podcast',
            node: <MoviePodcastSection title={d.title} year={d.year} overview={overview?.text ?? d.summary} />,
          },
        ]}
      />

      {bundle.similarTitles.length > 0 && (
        <section className="px-1">
          <SectionHeading>More Like This</SectionHeading>
          <div className="flex gap-3 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {bundle.similarTitles.filter((s) => s.objectType === 'MOVIE').map((s, i) => (
              <TitleCard key={`${s.title}-${i}`} item={{
                to: movieTo({ title: s.title, year: s.year }),
                title: s.title,
                subtitle: s.year ? String(s.year) : null,
                poster: s.posterUrl,
              }} />
            ))}
          </div>
        </section>
      )}
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

  // No PageShell: MediaLayout owns the dark cinema backdrop. ArtAccentScope retints
  // --brand across the whole detail page (hero glow, action bar, tab underlines) to the
  // palette of the artwork on screen.
  const art = betterBackdrop ?? core?.backdrop ?? null
  return (
    <ArtAccentScope art={art ? mediaImg(art) : null} className="relative min-h-full">
      <Backdrop url={art} />
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
    </ArtAccentScope>
  )
}
