import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Clapperboard, Loader2, Search, Bookmark, Headphones, Monitor } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useBreadcrumbSearch } from '@/context/BreadcrumbSearchContext'
import { MediaShelfRow, TitleCard, type PosterItem } from '@/components/media/TitleCard'
import { getMoviesHome, searchMovies, movieTo, type MovieSummary } from '@/lib/movies/api'
import { getWatchlist } from '@/lib/library/api'
import { EmptyAppState } from '@/components/shared/EmptyAppState'

const MOVIES_GRADIENT = 'linear-gradient(135deg,#1e1b4b,#6d28d9)'

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
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
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
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const hasContent = (shelves && shelves.length) || watchlistPosters.length
  if (!hasContent) {
    return (
      <EmptyAppState
        icon={Clapperboard}
        gradient={MOVIES_GRADIENT}
        title="Movies, watchlists & where to stream"
        tagline="Search any film, see where to stream it, build your watchlist, and let AI produce a deep-dive audio analysis — everything in one place."
        features={[
          { icon: Search, title: 'Search any title', desc: 'Millions of films with posters, ratings, and genre info.' },
          { icon: Monitor, title: 'Where to stream', desc: 'JustWatch integration shows every streaming option for your region.' },
          { icon: Bookmark, title: 'Watchlist', desc: 'Save movies to your queue before you\'re ready to commit.' },
          { icon: Headphones, title: 'AI movie deep-dive', desc: 'Your companion produces a cinematic audio analysis of any film.' },
        ]}
      />
    )
  }

  return (
    <div className="space-y-8">
      {watchlistPosters.length > 0 && <MediaShelfRow title="Your Watchlist" items={watchlistPosters} />}
      {shelves?.map((shelf) => (
        <MediaShelfRow key={shelf.key} title={shelf.title} items={shelf.items.map(toPoster)} />
      ))}
    </div>
  )
}

export function MoviesHomePage() {
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  usePublishUIContext({
    label: 'Movies',
    description: submitted ? `User is searching movies for "${submitted}".` : 'User is browsing the Movies home page.',
  })

  const onSubmit = useCallback(() => setSubmitted(query.trim()), [query])
  useBreadcrumbSearch({
    query,
    setQuery,
    onSubmit,
    placeholder: 'Search movies…',
    externalHref: 'https://www.justwatch.com',
    settingsHref: '/admin/features?tool=showtimes',
  })

  return (
    <PageShell gradient={MOVIES_GRADIENT} GhostIcon={Clapperboard}>
      <div className="px-5 pb-12 pt-5">{submitted ? <SearchGrid q={submitted} /> : <HomeShelves />}</div>
    </PageShell>
  )
}
