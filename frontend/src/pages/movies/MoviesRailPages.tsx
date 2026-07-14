// The Movies rail pages: In Theaters / New Releases / Top Rated / Genres / Watchlist.
// Thin full-page grids over the movies API, rendered inside the MediaLayout cinema shell
// (no PageShell/PageHeader: the layout owns chrome, these pages own a heading + grid).
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Clapperboard, Clock, MapPin, Pencil, Ticket } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { TitleCard, type PosterItem } from '@/components/media/TitleCard'
import { RatingBadge } from '@/components/media/RatingBadge'
import { mediaImg } from '@/lib/shows/api'
import { getWatchlist } from '@/lib/library/api'
import {
  getMoviesHome, getTopRatedMovies, getNewMovies, getMoviesForAge, getShowtimesNearMe, setMovieZip, movieTo,
  type MovieSummary, type ShowMovie,
} from '@/lib/movies/api'

function toPoster(m: MovieSummary): PosterItem {
  return { to: movieTo(m), title: m.title, subtitle: [m.genre, m.year].filter(Boolean).join(' · ') || null, poster: m.poster }
}

function Heading({ title, subtitle, right }: { title: string; subtitle?: string; right?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 className="text-title">{title}</h2>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {right}
    </div>
  )
}

function Grid({ items, empty }: { items: PosterItem[]; empty: string }) {
  if (!items.length) return <p className="py-20 text-center text-sm text-muted-foreground">{empty}</p>
  return (
    <div className="grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-4 xl:grid-cols-6">
      {items.map((it, i) => <TitleCard key={`${it.to}-${i}`} item={it} fluid />)}
    </div>
  )
}

function Loading() {
  return <div className="flex items-center justify-center py-24"><Spinner size="lg" /></div>
}

function ListPage({ label, queryKey, fetcher, subtitle }: {
  label: string; queryKey: string; fetcher: () => Promise<MovieSummary[]>; subtitle?: string
}) {
  usePublishUIContext({ label: 'Movies', description: `User is browsing ${label}.` })
  const { data, isLoading } = useQuery({ queryKey: [queryKey], queryFn: fetcher, staleTime: 30 * 60 * 1000 })
  return (
    <PageContainer width="wide" className="pb-12 pt-6">
      <Heading title={label} subtitle={subtitle} />
      {isLoading ? <Loading /> : <Grid items={(data ?? []).map(toPoster)} empty="Nothing here right now." />}
    </PageContainer>
  )
}

export function MoviesTopRatedPage() {
  return <ListPage label="Top Rated" queryKey="movies-top-rated" fetcher={getTopRatedMovies}
    subtitle="The highest-rated films on IMDb, all time." />
}

export function MoviesNewPage() {
  return <ListPage label="New Releases" queryKey="movies-new" fetcher={getNewMovies}
    subtitle="This year's releases, trending first." />
}

// ── Genres: the home shelves' genre rows, expanded to full grids ─────────────────────
export function MoviesGenresPage() {
  usePublishUIContext({ label: 'Movies', description: 'User is browsing movie genres.' })
  const { data: shelves, isLoading } = useQuery({ queryKey: ['movies-home'], queryFn: getMoviesHome, staleTime: 30 * 60 * 1000 })
  const genreShelves = (shelves ?? []).filter((s) => s.key.startsWith('genre:'))
  return (
    <PageContainer width="wide" className="pb-12 pt-6">
      <Heading title="Genres" />
      {isLoading ? <Loading /> : genreShelves.length === 0
        ? <p className="py-20 text-center text-sm text-muted-foreground">No genre lists available right now.</p>
        : genreShelves.map((shelf) => (
            <section key={shelf.key} className="mb-10">
              <h3 className="mb-3 text-base font-semibold">{shelf.title}</h3>
              <Grid items={shelf.items.map(toPoster)} empty="" />
            </section>
          ))}
    </PageContainer>
  )
}

// ── Watchlist ────────────────────────────────────────────────────────────────────────
export function MoviesWatchlistPage() {
  usePublishUIContext({ label: 'Movies', description: 'User is viewing their movie watchlist.' })
  const { data, isLoading } = useQuery({ queryKey: ['watchlist', 'movie'], queryFn: () => getWatchlist('movie'), staleTime: 60 * 1000 })
  const items: PosterItem[] = (data ?? []).map((w) => ({
    to: `/movies/${encodeURIComponent(w.refId)}`, title: w.title, subtitle: w.subtitle, poster: w.posterUrl,
  }))
  return (
    <PageContainer width="wide" className="pb-12 pt-6">
      <Heading title="Your Watchlist" />
      {isLoading ? <Loading /> : <Grid items={items} empty="Nothing saved yet. Add films from any movie page." />}
    </PageContainer>
  )
}

// ── In Theaters: full showtimes grid near the household ZIP ──────────────────────────
function TheaterCard({ m }: { m: ShowMovie }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-card border border-border/50 bg-card/40">
      <Link to={movieTo({ title: m.title, year: null })} className="group flex gap-3 p-3">
        {m.poster_url ? (
          <img src={mediaImg(m.poster_url)} alt={m.title} loading="lazy" className="h-36 w-24 shrink-0 rounded-control object-cover ring-1 ring-border/40" />
        ) : (
          <div className="flex h-36 w-24 shrink-0 items-center justify-center rounded-control bg-muted">
            <Clapperboard className="size-6 text-muted-foreground/40" />
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="font-semibold leading-tight group-hover:text-brand">{m.title}</p>
          <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
            <RatingBadge rating={m.rating} />
            {m.runtime_minutes ? <span className="rounded-full border border-border px-2 py-0.5">{m.runtime_minutes} min</span> : null}
          </div>
          <div className="flex flex-wrap gap-1 pt-1">
            {m.times.slice(0, 6).map((t, i) => (
              <span key={i} className="inline-flex items-center gap-1 rounded-full bg-foreground/8 px-2 py-0.5 text-xs">
                <Clock className="size-3 text-muted-foreground" />{t}
              </span>
            ))}
            {m.times.length > 6 && <span className="text-xs text-muted-foreground">+{m.times.length - 6}</span>}
          </div>
        </div>
      </Link>
      <div className="flex items-center gap-3 border-t border-border/40 px-3 py-2 text-xs">
        {m.url && (
          <a href={m.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">
            <Ticket className="size-3.5" /> Tickets
          </a>
        )}
        {m.theater_groups.length > 0 && (
          <button onClick={() => setOpen((v) => !v)} className="ml-auto text-muted-foreground hover:text-foreground">
            {open ? 'Hide theaters' : `${m.theater_groups.length} theater${m.theater_groups.length !== 1 ? 's' : ''}`}
          </button>
        )}
      </div>
      {open && (
        <div className="space-y-2 border-t border-border/40 bg-black/20 p-3">
          {m.theater_groups.map((g, i) => (
            <div key={i}>
              <p className="text-xs font-semibold">{g.theater_name}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {g.times.map((t, j) => <span key={j} className="rounded-full bg-foreground/8 px-2 py-0.5 text-xs">{t}</span>)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function MoviesInTheatersPage() {
  usePublishUIContext({ label: 'Movies', description: 'User is browsing local movie showtimes.' })
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const { data, isLoading } = useQuery({ queryKey: ['movies-near-me'], queryFn: () => getShowtimesNearMe(), staleTime: 30 * 60 * 1000 })

  const saveZip = async () => {
    const z = draft.trim()
    if (!/^\d{5}$/.test(z)) return
    await setMovieZip(z)
    setEditing(false)
    await qc.invalidateQueries({ queryKey: ['movies-near-me'] })
  }
  const zipEditor = (
    <div className="flex items-center gap-1.5">
      <div className="relative">
        <MapPin className="absolute left-2 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={draft} onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, '').slice(0, 5))}
          onKeyDown={(e) => e.key === 'Enter' && void saveZip()} placeholder="ZIP code" inputMode="numeric" className="w-28 pl-7" />
      </div>
      <Button type="button" size="sm" variant="secondary" onClick={() => void saveZip()}>Save</Button>
    </div>
  )

  const zip = data?.zip ?? null
  const movies = data?.data?.movies ?? []
  return (
    <PageContainer width="wide" className="pb-12 pt-6">
      <Heading title="In Theaters" subtitle={zip ? `Showtimes near ${zip} today${data?.data ? ` · ${data.data.theater_count} theaters` : ''}` : undefined}
        right={zip && !editing
          ? <button onClick={() => { setDraft(zip); setEditing(true) }} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <MapPin className="size-3.5" /> {zip} <Pencil className="size-3" />
            </button>
          : (zip || editing) ? zipEditor : undefined} />
      {isLoading ? <Loading /> : !zip ? (
        <div className="flex flex-wrap items-center gap-3 rounded-card border border-border/50 bg-card/40 p-4">
          <span className="text-sm text-muted-foreground">Set your ZIP code to see what&rsquo;s playing nearby.</span>
          {zipEditor}
        </div>
      ) : movies.length === 0 ? (
        <p className="py-20 text-center text-sm text-muted-foreground">No showtimes found near {zip} today.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {movies.map((m, i) => <TheaterCard key={`${m.title}-${i}`} m={m} />)}
        </div>
      )}
    </PageContainer>
  )
}

// Shared age buckets for the Family pages ("find something for an 8 year old").
const AGE_BUCKETS = [
  { label: 'Little kids (2-6)', age: 5 },
  { label: 'Kids (7-9)', age: 8 },
  { label: 'Tweens (10-12)', age: 11 },
  { label: 'Teens (13+)', age: 14 },
]
const AGE_KEY = 'media.familyAge'
function savedAge(): number {
  const n = Number(localStorage.getItem(AGE_KEY))
  return AGE_BUCKETS.some((b) => b.age === n) ? n : 8
}

// Age-appropriate discovery: rating-filtered trending films per age bucket.
export function MoviesFamilyPage() {
  usePublishUIContext({ label: 'Movies', description: 'User is browsing family movies by age.' })
  const [age, setAge] = useState(savedAge)
  const { data, isLoading } = useQuery({
    queryKey: ['movies-for-age', age],
    queryFn: () => getMoviesForAge(age),
    staleTime: 30 * 60 * 1000,
  })
  return (
    <PageContainer width="wide" className="pb-12 pt-6">
      <Heading title="Family" subtitle="Age-appropriate picks by US rating (G, PG, PG-13). Always check the Parents Guide on the title page." />
      <div className="mb-6 flex flex-wrap gap-2">
        {AGE_BUCKETS.map((b) => (
          <Button key={b.age} type="button" size="sm" variant={age === b.age ? 'default' : 'secondary'}
            onClick={() => { setAge(b.age); try { localStorage.setItem(AGE_KEY, String(b.age)) } catch { /* quota */ } }}>
            {b.label}
          </Button>
        ))}
      </div>
      {isLoading ? <Loading /> : <Grid items={(data ?? []).map(toPoster)} empty="Nothing found for this age range right now." />}
    </PageContainer>
  )
}
