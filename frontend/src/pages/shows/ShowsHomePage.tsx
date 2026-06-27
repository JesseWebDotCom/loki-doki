import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Tv, Search, BookOpen, Bookmark, Headphones } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { MediaShelfRow, TitleCard, type PosterItem } from '@/components/media/TitleCard'
import { showsHomeQueryOptions, searchShowsApi, type ShowSummary } from '@/lib/shows/api'
import { getContinueWatching, getWatchlist } from '@/lib/library/api'
import { usePlexConfigured, plexRailQueryOptions } from '@/lib/plex/hooks'
import { PlexNowPlaying } from '@/components/media/PlexNowPlaying'
import { EmptyAppState } from '@/components/shared/EmptyAppState'

const SHOWS_GRADIENT = 'linear-gradient(135deg,#0c4a6e,#0284c7)'

function toPoster(s: ShowSummary): PosterItem {
  return {
    to: `/shows/${s.id}`,
    title: s.name,
    subtitle: [s.network, s.year].filter(Boolean).join(' · ') || null,
    poster: s.poster,
    rating: s.rating,
  }
}

function SearchGrid({ q }: { q: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['shows-search', q],
    queryFn: () => searchShowsApi(q),
    staleTime: 5 * 60 * 1000,
  })
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (!data || !data.length) {
    return (
      <div className="flex flex-col items-center gap-2 py-24 text-center text-muted-foreground">
        <Tv className="size-10 opacity-20" />
        <p className="text-sm">No shows found for &ldquo;{q}&rdquo;.</p>
      </div>
    )
  }
  return (
    <div className="grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-4 xl:grid-cols-6">
      {data.map((s) => (
        <TitleCard key={s.id} item={toPoster(s)} fluid />
      ))}
    </div>
  )
}

function PersonalShelves() {
  const { data: continueItems } = useQuery({ queryKey: ['continue-watching'], queryFn: getContinueWatching, staleTime: 60 * 1000 })
  const { data: watchlist } = useQuery({ queryKey: ['watchlist', 'show'], queryFn: () => getWatchlist('show'), staleTime: 60 * 1000 })

  const continuePosters: PosterItem[] = (continueItems ?? []).map((c) => ({
    to: `/shows/${c.tvmazeId}`,
    title: c.title,
    subtitle: c.nextEpisode
      ? `Next: S${c.nextEpisode.season}${c.nextEpisode.number != null ? `E${c.nextEpisode.number}` : ''}`
      : 'All caught up',
    poster: c.posterUrl,
  }))
  const watchlistPosters: PosterItem[] = (watchlist ?? []).map((w) => ({
    to: `/shows/${w.refId}`,
    title: w.title,
    subtitle: w.subtitle,
    poster: w.posterUrl,
  }))

  return (
    <>
      {continuePosters.length > 0 && <MediaShelfRow title="Continue Watching" items={continuePosters} />}
      {watchlistPosters.length > 0 && <MediaShelfRow title="Your Watchlist" items={watchlistPosters} />}
    </>
  )
}

// Rails surfaced straight from the user's Plex server. The connect prompt lives in the sticky
// PlexConnectBanner at the top of the page, not here.
function PlexShelves({ type }: { type: 'show' | 'movie' }) {
  const configured = usePlexConfigured()
  const { data: ondeck } = useQuery(plexRailQueryOptions('ondeck', type, configured))
  const { data: recent } = useQuery(plexRailQueryOptions('recent', type, configured))
  const { data: hubs } = useQuery(plexRailQueryOptions('hubs', type, configured))

  if (!configured) return null
  return (
    <>
      <PlexNowPlaying />
      {!!ondeck?.length && <MediaShelfRow title="Continue on Plex" items={ondeck} />}
      {!!recent?.length && <MediaShelfRow title="Recently Added to Plex" items={recent} />}
      {!!hubs?.length && <MediaShelfRow title="Recommended on Plex" items={hubs} />}
    </>
  )
}

export { PlexShelves }

function HomeShelves() {
  const { data: shelves, isLoading } = useQuery(showsHomeQueryOptions())

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (!shelves || !shelves.length) {
    return (
      <EmptyAppState
        icon={Tv}
        gradient={SHOWS_GRADIENT}
        title="Every TV show, tracked in one place"
        tagline="Search 250,000+ series from TVMaze, add them to your watchlist, and let AI turn any episode into a podcast — no subscription required."
        features={[
          { icon: Search, title: 'Search any series', desc: 'Titles, cast, genres — across every network and streaming service.' },
          { icon: BookOpen, title: 'Track your progress', desc: 'Continue Watching keeps you one tap from your next episode.' },
          { icon: Bookmark, title: 'Watchlist', desc: 'Queue up shows before you start — never lose a recommendation.' },
          { icon: Headphones, title: 'AI episode podcasts', desc: 'Your companion produces a full audio recap for any episode.' },
        ]}
      />
    )
  }
  return (
    <div className="space-y-8">
      <PersonalShelves />
      <PlexShelves type="show" />
      {shelves.map((shelf) => (
        <MediaShelfRow key={shelf.key} title={shelf.title} items={shelf.items.map(toPoster)} />
      ))}
    </div>
  )
}

export function ShowsHomePage() {
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  usePublishUIContext({
    label: 'Shows',
    description: submitted ? `User is searching shows for "${submitted}".` : 'User is browsing the Shows home page.',
  })

  const onSubmit = useCallback(() => setSubmitted(query.trim()), [query])
  useAppHeader({
    query,
    setQuery,
    onSubmit,
    placeholder: 'Search shows…',
    externalHref: 'https://www.tvmaze.com',
    settingsHref: '/admin/features?tool=tvshows',
  })

  return (
    <PageShell gradient={SHOWS_GRADIENT} GhostIcon={Tv}>
      <div className="px-5 pb-12 pt-5">{submitted ? <SearchGrid q={submitted} /> : <HomeShelves />}</div>
    </PageShell>
  )
}
