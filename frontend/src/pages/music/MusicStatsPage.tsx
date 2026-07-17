// All-time stats: the whole listening history in aggregate (music and podcasts), with
// per-year and per-month breakdowns and searchable top lists. Everything is SQL
// aggregation server-side, so this stays fast as history grows.

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Clock3, Disc3, Mic, Play, Users } from 'lucide-react'
import { cn } from '@/lib/cn'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { AppTabBar, type AppTab } from '@/components/shared/AppTabBar'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { SongArt } from '@/components/music/SongArt'
import { ArtistAvatar } from '@/components/music/MediaArt'
import { useRadio } from '@/context/RadioContext'
import { getMusicStatsOverview, getTopArtists, getTopTracks } from '@/lib/music/portabilityApi'
import { getPodcastStats } from '@/lib/podcast/portabilityApi'

const MONTH_LABELS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']

type StatsTab = 'music' | 'podcasts'
const TABS: AppTab<StatsTab>[] = [
  { id: 'music', label: 'Music', icon: Disc3 },
  { id: 'podcasts', label: 'Podcasts', icon: Mic },
]

function fmtHours(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  return h >= 1000 ? `${h.toLocaleString()}h` : `${h}h ${minutes % 60}m`
}

function StatTile({ icon: Icon, value, label }: { icon: typeof Clock3; value: string; label: string }) {
  return (
    <div className="flex flex-1 flex-col items-center gap-1 rounded-card bg-white/[0.05] p-5 ring-1 ring-inset ring-white/[0.06]">
      <Icon className="size-5 text-brand" />
      <span className="text-2xl font-extrabold tabular-nums tracking-tight">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

/** Horizontal bar row - the shared shape for the per-year and per-month breakdowns. */
function BarRow({ label, value, max, caption, onClick, active }: {
  label: string; value: number; max: number; caption: string; onClick?: () => void; active?: boolean
}) {
  const Wrapper = onClick ? 'button' : 'div'
  return (
    <Wrapper
      {...(onClick ? { onClick, type: 'button' as const } : {})}
      className={cn(
        'flex w-full items-center gap-3 rounded-control px-2 py-1.5 text-left transition',
        onClick && 'hover:bg-white/[0.06]',
        active && 'bg-white/[0.08]',
      )}
    >
      <span className="w-10 shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">{label}</span>
      <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/8">
        <span className="block h-full rounded-full bg-brand/80" style={{ width: `${max > 0 ? Math.max(2, (value / max) * 100) : 0}%` }} />
      </span>
      <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{caption}</span>
    </Wrapper>
  )
}

// ── Music ───────────────────────────────────────────────────────────────────────────

function MusicStats() {
  const radio = useRadio()
  const [year, setYear] = useState<number | null>(null)   // null = all time
  const [rawQuery, setRawQuery] = useState('')
  const [query, setQuery] = useState('')
  const [listKind, setListKind] = useState<'tracks' | 'artists'>('tracks')

  // Debounce the search so a fast typist doesn't fire a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(rawQuery.trim()), 250)
    return () => clearTimeout(t)
  }, [rawQuery])

  const { data: overview, isLoading } = useQuery({
    queryKey: ['music-stats-overview', year],
    queryFn: () => getMusicStatsOverview(year ?? undefined),
    staleTime: 5 * 60 * 1000,
  })
  const { data: tracks = [], isFetching: tracksLoading } = useQuery({
    queryKey: ['music-stats-top-tracks', query, year],
    queryFn: () => getTopTracks({ q: query, year, limit: 50 }),
    enabled: listKind === 'tracks',
    staleTime: 60 * 1000,
  })
  const { data: artists = [], isFetching: artistsLoading } = useQuery({
    queryKey: ['music-stats-top-artists', query, year],
    queryFn: () => getTopArtists({ q: query, year, limit: 50 }),
    enabled: listKind === 'artists',
    staleTime: 60 * 1000,
  })

  const maxYear = Math.max(1, ...(overview?.years.map(y => y.minutes) ?? [1]))
  const maxMonth = Math.max(1, ...(overview?.months.map(m => m.minutes) ?? [1]))
  const loading = listKind === 'tracks' ? tracksLoading : artistsLoading

  if (isLoading) {
    return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner size="sm" /> Adding it up…</p>
  }
  if (!overview || overview.totals.plays === 0) {
    return <p className="text-sm text-muted-foreground">No listening history yet. Play something and come back.</p>
  }

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row">
        <StatTile icon={Clock3} value={fmtHours(overview.totals.minutes)} label="listened, all time" />
        <StatTile icon={Play} value={overview.totals.plays.toLocaleString()} label="songs played" />
        <StatTile icon={Disc3} value={overview.totals.distinctTracks.toLocaleString()} label="different songs" />
        <StatTile icon={Users} value={overview.totals.distinctArtists.toLocaleString()} label="different artists" />
      </div>

      {overview.totals.firstPlayAtMs && (
        <p className="mt-3 text-xs text-muted-foreground">
          Listening since {new Date(overview.totals.firstPlayAtMs).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}.
        </p>
      )}

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-2">
        <section>
          <SectionHeader title="By year" />
          <p className="mt-0.5 text-xs text-muted-foreground">Tap a year to filter everything below.</p>
          <div className="mt-3 grid gap-0.5">
            <BarRow label="All" value={maxYear} max={maxYear} caption={fmtHours(overview.totals.minutes)}
              onClick={() => setYear(null)} active={year === null} />
            {[...overview.years].reverse().map(y => (
              <BarRow key={y.year} label={String(y.year)} value={y.minutes} max={maxYear} caption={fmtHours(y.minutes)}
                onClick={() => setYear(y.year)} active={year === y.year} />
            ))}
          </div>
        </section>

        <section>
          <SectionHeader title={`By month, ${overview.monthsYear}`} />
          <div className="mt-3 flex h-32 items-end gap-1 rounded-card bg-white/[0.04] p-3 ring-1 ring-inset ring-white/[0.06]">
            {overview.months.map(m => (
              <div key={m.month} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                <div className="w-full rounded-[2px] bg-brand/80 transition-all"
                  style={{ height: `${Math.max(2, (m.minutes / maxMonth) * 100)}%`, opacity: m.minutes ? 1 : 0.15 }}
                  title={`${MONTH_LABELS[m.month - 1]}: ${fmtHours(m.minutes)}, ${m.plays} plays`} />
                <span className="text-[8px] leading-none text-muted-foreground">{MONTH_LABELS[m.month - 1]}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="mt-8">
        <SectionHeader title={year ? `Top in ${year}` : 'Top all time'} />
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex h-9 shrink-0 items-center rounded-full border border-border bg-background p-0.5 text-xs font-semibold">
            {(['tracks', 'artists'] as const).map(k => (
              <button key={k} type="button" onClick={() => setListKind(k)}
                className={cn('rounded-full px-3 py-1.5 capitalize transition-colors',
                  listKind === k ? 'bg-brand text-brand-foreground' : 'text-muted-foreground hover:text-foreground')}>
                {k}
              </button>
            ))}
          </div>
          <Input value={rawQuery} onChange={e => setRawQuery(e.target.value)}
            placeholder={listKind === 'tracks' ? 'Search songs and artists…' : 'Search artists…'} className="sm:max-w-xs" />
          {loading && <Spinner size="sm" />}
        </div>

        <div className="mt-3 grid gap-1">
          {listKind === 'tracks' && tracks.map((t, i) => (
            <button key={t.videoId} onClick={() => radio.playTrack({ videoId: t.videoId, title: t.title, author: t.artist })}
              className="group flex items-center gap-3 rounded-card px-2 py-1.5 text-left transition hover:bg-white/[0.06]">
              <span className="w-6 shrink-0 text-right text-sm font-semibold tabular-nums text-muted-foreground/60">{i + 1}</span>
              <SongArt trackRef={t.videoId} title={t.title} artist={t.artist} className="size-11" rounded="rounded-control" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{t.title}</p>
                <p className="truncate text-xs text-muted-foreground">{t.artist}</p>
              </div>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{t.plays}×</span>
              <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground/70">{fmtHours(t.minutes)}</span>
              <Play className="mr-1 size-4 shrink-0 fill-current opacity-0 transition group-hover:opacity-100" />
            </button>
          ))}

          {listKind === 'artists' && artists.map((a, i) => (
            <div key={a.artist} className="flex items-center gap-3 rounded-card px-2 py-1.5">
              <span className="w-6 shrink-0 text-right text-sm font-semibold tabular-nums text-muted-foreground/60">{i + 1}</span>
              <ArtistAvatar name={a.artist} className="size-11 rounded-full" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{a.artist}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{a.plays} plays</span>
              <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground/70">{fmtHours(a.minutes)}</span>
            </div>
          ))}

          {!loading && (listKind === 'tracks' ? tracks : artists).length === 0 && (
            <p className="px-2 py-4 text-sm text-muted-foreground">
              {query ? 'Nothing matches that search.' : 'Nothing here yet.'}
            </p>
          )}
        </div>
      </section>
    </>
  )
}

// ── Podcasts ────────────────────────────────────────────────────────────────────────

function PodcastStats() {
  const { data, isLoading } = useQuery({ queryKey: ['podcast-stats'], queryFn: getPodcastStats, staleTime: 5 * 60 * 1000 })

  const maxYear = Math.max(1, ...(data?.years.map(y => y.minutes) ?? [1]))
  const maxShow = useMemo(() => Math.max(1, ...(data?.topShows.map(s => s.minutes) ?? [1])), [data])

  if (isLoading) {
    return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner size="sm" /> Adding it up…</p>
  }
  if (!data || data.totals.episodes === 0) {
    return <p className="text-sm text-muted-foreground">No podcast listening yet. Play an episode and come back.</p>
  }

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row">
        <StatTile icon={Clock3} value={fmtHours(data.totals.minutes)} label="listened, all time" />
        <StatTile icon={Play} value={data.totals.episodes.toLocaleString()} label="episodes" />
        <StatTile icon={Mic} value={data.totals.shows.toLocaleString()} label="shows" />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-2">
        <section>
          <SectionHeader title="By year" />
          <div className="mt-3 grid gap-0.5">
            {[...data.years].reverse().map(y => (
              <BarRow key={y.year} label={String(y.year)} value={y.minutes} max={maxYear} caption={fmtHours(y.minutes)} />
            ))}
          </div>
        </section>

        <section>
          <SectionHeader title="Top shows" />
          <div className="mt-3 grid gap-1">
            {data.topShows.map((s, i) => (
              <Link key={s.showId} to={`/podcasts/show/${s.showId}`}
                className="flex items-center gap-3 rounded-card px-2 py-1.5 transition hover:bg-white/[0.06]">
                <span className="w-6 shrink-0 text-right text-sm font-semibold tabular-nums text-muted-foreground/60">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{s.name}</span>
                  <span className="block h-1.5 w-full max-w-40 overflow-hidden rounded-full bg-foreground/8">
                    <span className="block h-full rounded-full bg-brand/70" style={{ width: `${Math.max(2, (s.minutes / maxShow) * 100)}%` }} />
                  </span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{s.episodes} ep</span>
                <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground/70">{fmtHours(s.minutes)}</span>
              </Link>
            ))}
          </div>
        </section>
      </div>

      <p className="mt-6 text-xs text-muted-foreground">
        Podcast numbers come from how far you actually got in each episode. An episode counts once, in the year you
        last listened to it.
      </p>
    </>
  )
}

export function MusicStatsPage() {
  const [tab, setTab] = useState<StatsTab>('music')
  return (
    <PageContainer width="wide" className="pb-10">
      <PageHeader plain title="Stats" subtitle="Everything you have listened to, added up." />
      <AppTabBar tabs={TABS} value={tab} onChange={setTab} className="mb-5" />
      {tab === 'music' ? <MusicStats /> : <PodcastStats />}
    </PageContainer>
  )
}
