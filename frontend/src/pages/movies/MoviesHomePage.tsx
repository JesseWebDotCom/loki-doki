import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Clapperboard, Search, Bookmark, Headphones, Monitor } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { MediaBillboard, type BillboardItem } from '@/components/media/MediaBillboard'
import { Spinner } from '@/components/ui/spinner'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { MediaShelfRow, TitleCard, type PosterItem } from '@/components/media/TitleCard'
import { getMoviesHome, searchMovies, movieTo, type MovieSummary } from '@/lib/movies/api'
import { getWatchlist } from '@/lib/library/api'
import { PlexShelves } from '@/pages/shows/ShowsHomePage'
import { InTheatersSection } from '@/components/media/InTheatersSection'
import { MyRequestsSection } from '@/components/media/MediaIntegrations'
import { SuggestedTitlesShelf } from '@/components/media/SuggestedTitlesShelf'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { getAppByPath } from '@/lib/appCategories'

// App identity (icon/gradient) comes from the app registry - the single source of truth.
const MOVIES_APP = getAppByPath('/movies')

function toPoster(m: MovieSummary): PosterItem {
  return {
    to: movieTo(m),
    title: m.title,
    subtitle: [m.genre, m.year].filter(Boolean).join(' · ') || null,
    poster: m.poster,
  }
}

function SearchGrid({ q }: { q: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['movies-search', q],
    queryFn: () => searchMovies(q),
    staleTime: 5 * 60 * 1000,
  })
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner size="lg" />
      </div>
    )
  }
  if (!data || !data.length) {
    return (
      <div className="flex flex-col items-center gap-2 py-24 text-center text-muted-foreground">
        <Clapperboard className="size-10 opacity-20" />
        <p className="text-sm">No movies found for &ldquo;{q}&rdquo;.</p>
      </div>
    )
  }
  return (
    <div className="grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-4 xl:grid-cols-6">
      {data.map((m, i) => (
        <TitleCard key={`${m.title}-${i}`} item={toPoster(m)} fluid />
      ))}
    </div>
  )
}

function HomeShelves() {
  const { data: shelves, isLoading } = useQuery({
    queryKey: ['movies-home'],
    queryFn: getMoviesHome,
    staleTime: 30 * 60 * 1000,
  })
  const { data: watchlist } = useQuery({ queryKey: ['watchlist', 'movie'], queryFn: () => getWatchlist('movie'), staleTime: 60 * 1000 })

  const watchlistPosters: PosterItem[] = (watchlist ?? []).map((w) => ({
    to: `/movies/${encodeURIComponent(w.refId)}`,
    title: w.title,
    subtitle: w.subtitle,
    poster: w.posterUrl,
  }))

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner size="lg" />
      </div>
    )
  }

  const hasContent = (shelves && shelves.length) || watchlistPosters.length
  if (!hasContent) {
    return (
      <EmptyAppState
        icon={Clapperboard}
        gradient={MOVIES_APP?.gradient}
        title="Movies, watchlists & where to stream"
        tagline="Search any film, see where to stream it, build your watchlist, and let AI produce a deep-dive audio analysis - everything in one place."
        features={[
          { icon: Search, title: 'Search any title', desc: 'Millions of films with posters, ratings, and genre info.' },
          { icon: Monitor, title: 'Where to stream', desc: 'JustWatch integration shows every streaming option for your region.' },
          { icon: Bookmark, title: 'Watchlist', desc: 'Save movies to your queue before you\'re ready to commit.' },
          { icon: Headphones, title: 'AI movie deep-dive', desc: 'Your companion produces a cinematic audio analysis of any film.' },
        ]}
      />
    )
  }

  // Billboard: the top of the first discover shelf, upgraded to widescreen backdrops.
  const featured = shelves?.[0]
  const billboard: BillboardItem[] = (featured?.items ?? []).slice(0, 5).map((m) => ({
    kind: 'movie',
    year: m.year ?? null,
    to: movieTo(m),
    title: m.title,
    subtitle: [m.genre, m.year].filter(Boolean).join(' · ') || null,
    poster: m.poster,
  }))

  return (
    <div className="space-y-8">
      {billboard.length > 0 && <MediaBillboard items={billboard} eyebrow={featured?.title ?? 'Featured'} />}
      <InTheatersSection />
      {watchlistPosters.length > 0 && <MediaShelfRow title="Your Watchlist" items={watchlistPosters} />}
      <MyRequestsSection mediaType="movie" />
      <SuggestedTitlesShelf kind="movie" />
      <PlexShelves type="movie" />
      {shelves?.map((shelf) => (
        <MediaShelfRow key={shelf.key} title={shelf.title} items={shelf.items.map(toPoster)} />
      ))}
    </div>
  )
}

export function MoviesHomePage() {
  // Search is URL-driven (?q=): MediaLayout owns the breadcrumb search box and routes here.
  const [params] = useSearchParams()
  const q = params.get('q')?.trim() ?? ''
  usePublishUIContext({
    label: 'Movies',
    description: q ? `User is searching movies for "${q}".` : 'User is browsing the Movies home page.',
  })

  // No PageShell/PageHeader: MediaLayout owns the dark cinema backdrop + left rail, the
  // breadcrumb carries the app identity, and the billboard is the page's focal point.
  return (
    <PageContainer width="wide" className="pb-12 pt-5">
      {q ? <SearchGrid q={q} /> : <HomeShelves />}
    </PageContainer>
  )
}
