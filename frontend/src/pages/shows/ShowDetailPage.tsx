import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink, Film, Loader2, Mic, Play, Star, Tv, Music, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { PageShell } from '@/components/shared/PageShell'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useYoutubePlayback } from '@/context/YoutubePlaybackContext'
import { cn } from '@/lib/cn'
import { Backdrop } from '@/components/media/Backdrop'
import { MediaTabs } from '@/components/media/MediaTabs'
import { ActionBar, ActionButton, ActionIcon } from '@/components/media/ActionBar'
import { SectionHeading } from '@/components/media/TitleCard'
import {
  CastRow,
  ParentsGuideSection,
  ReviewsSection,
  SoundtrackAlbums,
  StreamingChips,
  TriviaSection,
  VideoRow,
} from '@/components/media/sections'
import { EpisodeList } from '@/components/media/EpisodeList'
import { WatchlistButton } from '@/components/media/WatchlistButton'
import { PlexBadge } from '@/components/media/PlexBadge'
import { ShowPodcastSection } from '@/components/media/PodcastSection'
import { getShowWatched, toggleEpisodeWatched } from '@/lib/library/api'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getShow,
  getShowStreaming,
  getShowMedia,
  getShowOverview,
  getShowParentsGuide,
  getShowBackdrop,
  getShowReviews,
  getShowTrivia,
  mediaImg,
  type ShowCore,
} from '@/lib/shows/api'
import { fetchShowSoundtrack } from '@/lib/music/musicInfo'

const SHOWS_GRADIENT = 'linear-gradient(135deg,#0c4a6e,#0284c7)'

function statusClass(status: string | null): string {
  if (status === 'Running') return 'bg-emerald-600/20 text-emerald-300'
  if (status === 'Ended') return 'bg-foreground/10 text-muted-foreground'
  return 'bg-foreground/10 text-muted-foreground'
}

function Hero({ bundle, actions }: { bundle: ShowCore; actions?: React.ReactNode }) {
  const d = bundle.details
  const [ok, setOk] = useState(true)
  return (
    <div className="flex flex-col gap-5 sm:flex-row">
      <div className="mx-auto w-[160px] shrink-0 sm:mx-0">
        <div className="aspect-[2/3] overflow-hidden rounded-xl bg-muted shadow-lg ring-1 ring-border/40">
          {d.poster && ok ? (
            <img src={mediaImg(d.poster)} alt={d.name} className="size-full object-cover" onError={() => setOk(false)} />
          ) : (
            <div className="flex size-full items-center justify-center">
              <Tv className="size-8 text-muted-foreground/40" />
            </div>
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div>
          <h1 className="text-2xl font-bold leading-tight sm:text-3xl">{d.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {[d.network, d.year, d.runtime ? `${d.runtime} min` : null].filter(Boolean).join(' · ')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {d.status && <Badge className={cn('border-0', statusClass(d.status))}>{d.status}</Badge>}
          {d.rating != null && d.rating > 0 && (
            <span className="inline-flex items-center gap-1 text-sm font-medium text-amber-400">
              <Star className="size-3.5 fill-amber-400" />
              {d.rating.toFixed(1)}
            </span>
          )}
          {d.genres.map((g) => (
            <Badge key={g} variant="outline" className="font-normal">
              {g}
            </Badge>
          ))}
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
  const m = Math.floor(s / 60); const sec = String(s % 60).padStart(2, '0')
  return `${m}:${sec}`
}

function SoundtrackSection({ showName }: { showName: string }) {
  const navigate = useNavigate()
  const { data, isLoading } = useQuery({
    queryKey: ['show-soundtrack', showName],
    queryFn: () => fetchShowSoundtrack(showName),
    staleTime: 60 * 60 * 1000,
  })

  if (isLoading) {
    return (
      <Section title="Soundtrack">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      </Section>
    )
  }

  if (!data?.songs.length) return null

  return (
    <Section title="Soundtrack">
      <div className="space-y-1">
        {data.songs.map((song, i) => (
          <button
            key={i}
            type="button"
            onClick={() => navigate(`/music/browse?q=${encodeURIComponent(song.title)}`)}
            className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/40"
          >
            <span className="w-5 shrink-0 text-right text-xs text-muted-foreground">{i + 1}</span>
            <Music className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm">{song.title}</span>
            <div className="flex shrink-0 items-center gap-2">
              {song.durationMs && <span className="text-xs text-muted-foreground">{fmtMs(song.durationMs)}</span>}
              <Search className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
          </button>
        ))}
      </div>
      {data.sourceTitle && data.sourceTitle !== showName && (
        <p className="mt-2 text-xs text-muted-foreground">Source: {data.sourceTitle} · MusicBrainz</p>
      )}
    </Section>
  )
}

function DetailBody({ id }: { id: string }) {
  const [tab, setTab] = useState<string | null>(null)
  const { playExpanded } = useYoutubePlayback()
  const { data: bundle, isLoading, isError } = useQuery({
    queryKey: ['show', id],
    queryFn: () => getShow(id),
    staleTime: 15 * 60 * 1000,
  })
  // Lazy, LLM-backed sections — load after the bundle so they never block the page.
  const { data: reviews, isLoading: reviewsLoading } = useQuery({
    queryKey: ['show-reviews', id],
    queryFn: () => getShowReviews(id),
    enabled: !!bundle,
    staleTime: 60 * 60 * 1000,
  })
  const { data: trivia, isLoading: triviaLoading } = useQuery({
    queryKey: ['show-trivia', id],
    queryFn: () => getShowTrivia(id),
    enabled: !!bundle,
    staleTime: 60 * 60 * 1000,
  })
  // Each enrichment streams into its own section so nothing blocks the core TVMaze data.
  const { data: streaming, isLoading: streamingLoading } = useQuery({
    queryKey: ['show-streaming', id],
    queryFn: () => getShowStreaming(id),
    enabled: !!bundle,
    staleTime: 30 * 60 * 1000,
  })
  const { data: media, isLoading: mediaLoading } = useQuery({
    queryKey: ['show-media', id],
    queryFn: () => getShowMedia(id),
    enabled: !!bundle,
    staleTime: 60 * 60 * 1000,
  })
  const { data: overview, isLoading: overviewLoading } = useQuery({
    queryKey: ['show-overview', id],
    queryFn: () => getShowOverview(id),
    enabled: !!bundle,
    staleTime: 60 * 60 * 1000,
  })
  const { data: parentsGuide } = useQuery({
    queryKey: ['show-parents-guide', id],
    queryFn: () => getShowParentsGuide(id),
    enabled: !!bundle,
    staleTime: 60 * 60 * 1000,
  })

  const numericId = Number(id)
  const qc = useQueryClient()
  const { data: watchedIds } = useQuery({
    queryKey: ['show-watched', id],
    queryFn: () => getShowWatched(numericId),
    enabled: !!bundle,
    staleTime: 60 * 1000,
  })
  const watched = new Set(watchedIds ?? [])
  const toggleWatched = useMutation({
    mutationFn: (ep: { id: number; season: number; number: number | null }) =>
      toggleEpisodeWatched(numericId, ep.id, { season: ep.season, number: ep.number }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['show-watched', id] })
      void qc.invalidateQueries({ queryKey: ['continue-watching'] })
    },
  })

  usePublishUIContext({
    label: 'Shows',
    description: bundle ? `User is viewing the show "${bundle.details.name}".` : 'User is opening a show.',
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
        <Tv className="size-10 opacity-20" />
        <p className="text-sm">Couldn&rsquo;t load this show.</p>
      </div>
    )
  }

  const trailerVideos = media ? [media.trailer, ...media.clips].filter((v): v is NonNullable<typeof v> => !!v) : []
  const d = bundle.details
  const imdbUrl = d.externals.imdb ? `https://www.imdb.com/title/${d.externals.imdb}/` : null

  const watchNode = streamingLoading ? (
    <p className="text-sm text-muted-foreground">Finding where to stream…</p>
  ) : (
    <StreamingChips
      providers={streaming?.providers ?? []}
      theaters={streaming?.theaters}
      justwatchUrl={streaming?.justwatchUrl}
      webProviders={streaming?.webProviders}
    />
  )

  const videosNode = (
    <div className="space-y-8">
      {mediaLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Finding trailers…
        </div>
      ) : trailerVideos.length > 0 ? (
        <VideoRow title="Trailers & clips" videos={trailerVideos} />
      ) : (
        <p className="text-sm text-muted-foreground">No videos found.</p>
      )}
      {media && media.music.length > 0 && <VideoRow title="Theme & soundtrack" videos={media.music} />}
      {media && media.soundtrackAlbums.length > 0 && <SoundtrackAlbums albums={media.soundtrackAlbums} />}
      <SoundtrackSection showName={d.name} />
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
        mediaType="show"
        refId={id}
        title={d.name}
        posterUrl={d.poster}
        subtitle={[d.network, d.year].filter(Boolean).join(' · ') || null}
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
      <ActionButton icon={Mic} label="Podcast" onClick={() => setTab('podcast')} />
      <PlexBadge
        type="show"
        title={d.name}
        year={d.year ? Number(d.year) : null}
        imdb={d.externals.imdb}
        tvdb={d.externals.thetvdb}
      />
      {d.officialSite && <ActionIcon icon={ExternalLink} href={d.officialSite} title="Official site" />}
      {imdbUrl && <ActionIcon icon={Star} href={imdbUrl} title="IMDb" />}
      {d.url && <ActionIcon icon={Film} href={d.url} title="TVMaze" />}
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
          { key: 'watch', label: 'Where to Watch', node: watchNode },
          {
            key: 'episodes',
            label: 'Episodes',
            count: bundle.episodeCount,
            node: (
              <EpisodeList
                seasons={bundle.seasons}
                watched={watched}
                onToggle={(epId) => {
                  const ep = bundle.seasons.flatMap((s) => s.episodes).find((e) => e.id === epId)
                  if (ep) toggleWatched.mutate({ id: ep.id, season: ep.season, number: ep.number })
                }}
              />
            ),
          },
          { key: 'videos', label: 'Media', node: videosNode },
          { key: 'reviews', label: 'Reviews', node: <ReviewsSection reviews={reviews} loading={reviewsLoading} /> },
          bundle.cast.length > 0 && { key: 'cast', label: 'Cast', node: <CastRow cast={bundle.cast} /> },
          { key: 'podcast', label: 'Podcast', node: <ShowPodcastSection showId={numericId} /> },
        ]}
      />
    </div>
  )
}

export function ShowDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()

  // Core gives an instant poster-based wallpaper; the backdrop endpoint sharpens it to a
  // landscape still once it resolves.
  const { data: core } = useQuery({ queryKey: ['show', id], queryFn: () => getShow(id), staleTime: 15 * 60 * 1000 })
  const { data: betterBackdrop } = useQuery({
    queryKey: ['show-backdrop', id],
    queryFn: () => getShowBackdrop(id),
    enabled: !!core,
    staleTime: 60 * 60 * 1000,
  })

  return (
    <PageShell gradient={SHOWS_GRADIENT} GhostIcon={Tv}>
      <Backdrop url={betterBackdrop ?? core?.backdrop} />
      <div className="relative px-5 pb-12 pt-4">
        <button
          type="button"
          onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/shows'))}
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Back
        </button>
        <DetailBody id={id} />
      </div>
    </PageShell>
  )
}
