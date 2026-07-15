// The Shows rail pages: On TV Tonight / Calendar / Top Rated / Genres / Continue / Watchlist.
// Thin full-page views over the shows API, rendered inside the MediaLayout cinema shell.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { CalendarDays, Radio, Tv } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { TitleCard, type PosterItem } from '@/components/media/TitleCard'
import {
  mediaImg, getOnTvToday, getTopRatedShows, getShowsForAge, getShowsCalendar, showsHomeQueryOptions,
  type ShowSummary, type ScheduleEntry,
} from '@/lib/shows/api'
import { getContinueWatching, getWatchlist } from '@/lib/library/api'
import { LibraryCalendarSection, MyRequestsSection } from '@/components/media/MediaIntegrations'

function toPoster(s: ShowSummary): PosterItem {
  return {
    to: `/shows/${s.id}`, title: s.name,
    subtitle: [s.network, s.year].filter(Boolean).join(' · ') || null,
    poster: s.poster, rating: s.rating,
  }
}

function Heading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-title">{title}</h2>
      {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
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

export function ShowsTopRatedPage() {
  usePublishUIContext({ label: 'Shows', description: 'User is browsing top-rated shows.' })
  const { data, isLoading } = useQuery({ queryKey: ['shows-top-rated'], queryFn: getTopRatedShows, staleTime: 30 * 60 * 1000 })
  return (
    <PageContainer width="wide" className="pb-12 pt-6">
      <Heading title="Top Rated" subtitle="The highest-rated series on IMDb, all time." />
      {isLoading ? <Loading /> : <Grid items={(data ?? []).map(toPoster)} empty="Nothing here right now." />}
    </PageContainer>
  )
}

export function ShowsGenresPage() {
  usePublishUIContext({ label: 'Shows', description: 'User is browsing show genres.' })
  const { data: shelves, isLoading } = useQuery(showsHomeQueryOptions())
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

export function ShowsContinuePage() {
  usePublishUIContext({ label: 'Shows', description: 'User is viewing Continue Watching.' })
  const { data, isLoading } = useQuery({ queryKey: ['continue-watching'], queryFn: getContinueWatching, staleTime: 60 * 1000 })
  const items: PosterItem[] = (data ?? []).map((c) => ({
    to: `/shows/${c.tvmazeId}`, title: c.title,
    subtitle: c.nextEpisode ? `Next: S${c.nextEpisode.season}${c.nextEpisode.number != null ? `E${c.nextEpisode.number}` : ''}` : 'All caught up',
    poster: c.posterUrl,
  }))
  return (
    <PageContainer width="wide" className="pb-12 pt-6">
      <Heading title="Continue Watching" />
      {isLoading ? <Loading /> : <Grid items={items} empty="Mark episodes watched on any show page and pick up here." />}
    </PageContainer>
  )
}

export function ShowsWatchlistPage() {
  usePublishUIContext({ label: 'Shows', description: 'User is viewing their show watchlist.' })
  const { data, isLoading } = useQuery({ queryKey: ['watchlist', 'show'], queryFn: () => getWatchlist('show'), staleTime: 60 * 1000 })
  const items: PosterItem[] = (data ?? []).map((w) => ({ to: `/shows/${w.refId}`, title: w.title, subtitle: w.subtitle, poster: w.posterUrl }))
  return (
    <PageContainer width="wide" className="pb-12 pt-6">
      <Heading title="Your Watchlist" />
      {isLoading ? <Loading /> : <Grid items={items} empty="Nothing saved yet. Add shows from any series page." />}
    </PageContainer>
  )
}

// ── On TV Tonight: the full day's schedule grouped by hour ───────────────────────────
export function ShowsOnTvPage() {
  usePublishUIContext({ label: 'Shows', description: 'User is browsing tonight’s TV schedule.' })
  const { data, isLoading } = useQuery({ queryKey: ['shows-on-tv'], queryFn: getOnTvToday, staleTime: 30 * 60 * 1000 })
  const entries = data?.entries ?? []
  const streaming = entries.filter((e) => e.streaming)
  const broadcast = entries.filter((e) => !e.streaming)
  const byTime = new Map<string, ScheduleEntry[]>()
  for (const e of broadcast) {
    const key = e.airtimeLabel ?? 'Anytime'
    byTime.set(key, [...(byTime.get(key) ?? []), e])
  }
  return (
    <PageContainer width="wide" className="pb-12 pt-6">
      <Heading title="On TV Tonight" subtitle="Broadcast and cable airings today, plus new streaming episodes." />
      {isLoading ? <Loading /> : entries.length === 0 ? (
        <p className="py-20 text-center text-sm text-muted-foreground">No schedule available right now.</p>
      ) : (
        <div className="space-y-10">
          {streaming.length > 0 && (
            <section>
              <h3 className="mb-3 inline-flex items-center gap-2 text-base font-semibold"><Radio className="size-4 text-brand" /> New on Streaming Today</h3>
              <Grid items={streaming.slice(0, 18).map((e) => toPoster(e.show))} empty="" />
            </section>
          )}
          {[...byTime.entries()].map(([time, list]) => (
            <section key={time}>
              <h3 className="mb-3 inline-flex items-center gap-2 text-base font-semibold"><Tv className="size-4 text-brand" /> {time}</h3>
              <Grid items={list.map((e) => ({
                ...toPoster(e.show),
                subtitle: [e.show.network, e.season != null && e.number != null ? `S${e.season}E${e.number}` : e.episode].filter(Boolean).join(' · ') || null,
              }))} empty="" />
            </section>
          ))}
        </div>
      )}
    </PageContainer>
  )
}

// ── Calendar: upcoming episodes for the shows you track ──────────────────────────────
export function ShowsCalendarPage() {
  usePublishUIContext({ label: 'Shows', description: 'User is viewing their shows calendar.' })
  const { data, isLoading } = useQuery({ queryKey: ['shows-calendar'], queryFn: getShowsCalendar, staleTime: 30 * 60 * 1000 })
  const entries = data ?? []
  return (
    <PageContainer width="wide" className="pb-12 pt-6">
      <Heading title="Calendar" subtitle="Upcoming episodes for shows on your watchlist." />
      {isLoading ? <Loading /> : entries.length === 0 ? (
        <p className="py-20 text-center text-sm text-muted-foreground">
          No upcoming episodes. Add shows to your watchlist to see their next air dates here.
        </p>
      ) : (
        <div className="space-y-2">
          {entries.map((e, i) => (
            <Link key={`${e.show.id}-${i}`} to={`/shows/${e.show.id}`}
              className="flex items-center gap-3 rounded-card border border-border/50 bg-card/40 p-3 transition-colors hover:border-brand/40">
              {e.show.poster ? (
                <img src={mediaImg(e.show.poster)} alt={e.show.name} loading="lazy" className="h-16 w-11 shrink-0 rounded-control object-cover ring-1 ring-border/40" />
              ) : (
                <div className="flex h-16 w-11 shrink-0 items-center justify-center rounded-control bg-muted"><Tv className="size-4 text-muted-foreground/40" /></div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{e.show.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {[e.season != null && e.number != null ? `S${e.season}E${e.number}` : null, e.name, e.show.network].filter(Boolean).join(' · ')}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="inline-flex items-center gap-1.5 text-sm font-medium"><CalendarDays className="size-4 text-brand" />{e.airdate ?? 'TBA'}</p>
                {e.airtime && <p className="text-xs text-muted-foreground">{e.airtime}</p>}
              </div>
            </Link>
          ))}
        </div>
      )}
      <MyRequestsSection mediaType="show" />
      <LibraryCalendarSection />
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

// Age-appropriate discovery: rating-filtered trending shows per age bucket (US TV ratings).
export function ShowsFamilyPage() {
  usePublishUIContext({ label: 'Shows', description: 'User is browsing family shows by age.' })
  const [age, setAge] = useState(savedAge)
  const { data, isLoading } = useQuery({
    queryKey: ['shows-for-age', age],
    queryFn: () => getShowsForAge(age),
    staleTime: 30 * 60 * 1000,
  })
  return (
    <PageContainer width="wide" className="pb-12 pt-6">
      <Heading title="Family" subtitle="Age-appropriate picks by US TV rating (TV-Y through TV-14). Always check the Parents Guide on the title page." />
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
