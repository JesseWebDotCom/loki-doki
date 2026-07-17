// Podcast Replay: the year in podcasts, the music Replay's sibling. Minutes are real
// listening progress from watch state, not episode durations. Admins also get a
// household-combined section at the bottom.

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Clock3, Home, Mic, Timer, Trophy } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { Spinner } from '@/components/ui/spinner'
import { ShowCover } from '@/components/podcast/ShowCover'
import { getPodcastReplay } from '@/lib/podcast/portabilityApi'

function fmtHours(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function StatTile({ icon: Icon, value, label }: { icon: typeof Clock3; value: string; label: string }) {
  return (
    <div className="flex flex-1 flex-col items-center gap-1 rounded-card border border-border/50 bg-card p-5">
      <Icon className="size-5 text-brand" />
      <span className="text-3xl font-extrabold tabular-nums tracking-tight">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

export function PodcastReplayPage() {
  const thisYear = new Date().getFullYear()
  const [year, setYear] = useState(thisYear)
  const { data, isLoading } = useQuery({
    queryKey: ['podcast-replay', year],
    queryFn: () => getPodcastReplay(year),
    staleTime: 30 * 60 * 1000,
  })

  const maxShow = Math.max(1, ...(data?.topShows.map(s => s.minutes) ?? [1]))

  return (
    <PageContainer width="narrow" className="py-6 pb-24">
      <PageHeader plain title="Replay" subtitle="Your year in podcasts, from real listening." />

      <div className="mb-5 flex gap-1.5">
        {[thisYear, thisYear - 1, thisYear - 2].map(y => (
          <button key={y} onClick={() => setYear(y)}
            className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition ${
              year === y ? 'bg-brand text-brand-foreground' : 'bg-foreground/8 hover:bg-foreground/15'
            }`}>
            {y}
          </button>
        ))}
      </div>

      {isLoading && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner size="sm" /> Adding it up…</p>}

      {data && data.episodes === 0 && (
        <p className="mt-4 text-sm text-muted-foreground">No podcast listening in {year} yet. Go find a show worth remembering.</p>
      )}

      {data && data.episodes > 0 && (
        <>
          <div className="flex flex-col gap-3 sm:flex-row">
            <StatTile icon={Clock3} value={fmtHours(data.minutes)} label="listened" />
            <StatTile icon={Mic} value={data.episodes.toLocaleString()} label="episodes" />
            <StatTile icon={Trophy} value={String(data.showCount)} label={data.showCount === 1 ? 'show' : 'shows'} />
          </div>

          {data.timeSavedSec > 0 && (
            <p className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground">
              <Timer className="size-4 text-brand" />
              Trim silence has saved you <span className="font-medium text-foreground">{fmtHours(Math.round(data.timeSavedSec / 60))}</span> of dead air, all time.
            </p>
          )}

          <section className="mt-8">
            <SectionHeader title="Top shows" />
            <div className="mt-3 grid gap-1">
              {data.topShows.map((s, i) => (
                <Link key={s.showId} to={`/podcasts/show/${s.showId}`}
                  className="flex items-center gap-3 rounded-card px-2 py-1.5 transition hover:bg-accent/40">
                  <span className="w-6 shrink-0 text-right text-sm font-semibold tabular-nums text-muted-foreground/60">{i + 1}</span>
                  <ShowCover showId={s.showId} title={s.name} size={44} rounded="rounded-control" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{s.name}</span>
                    <span className="mt-1 block h-1.5 w-full max-w-40 overflow-hidden rounded-full bg-foreground/8">
                      <span className="block h-full rounded-full bg-brand/70" style={{ width: `${Math.max(2, (s.minutes / maxShow) * 100)}%` }} />
                    </span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{s.episodes} ep</span>
                  <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground/70">{fmtHours(s.minutes)}</span>
                </Link>
              ))}
            </div>
          </section>

          {data.longestListen && (
            <p className="mt-8 text-sm text-muted-foreground">
              Your longest listen was <span className="font-medium text-foreground">{data.longestListen.title}</span> from{' '}
              <Link to={`/podcasts/show/${data.longestListen.showId}`} className="font-medium text-foreground hover:underline">
                {data.longestListen.showName}
              </Link>
              , at {fmtHours(data.longestListen.minutes)}.
            </p>
          )}

          {/* Household roll-up: admins only (the backend gates this too). */}
          {data.household && (
            <section className="mt-10 rounded-sheet border border-border bg-card p-5">
              <SectionHeader title="The whole household" lead={<Home className="size-4 text-brand" />} />
              <p className="mt-0.5 text-xs text-muted-foreground">Visible to admins only.</p>

              <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                <StatTile icon={Clock3} value={fmtHours(data.household.minutes)} label="listened together" />
                <StatTile icon={Mic} value={data.household.episodes.toLocaleString()} label="episodes" />
              </div>

              {data.household.byUser.length > 0 && (
                <div className="mt-5">
                  <p className="text-sm font-bold">Who listened most</p>
                  <div className="mt-2 grid gap-1">
                    {data.household.byUser.map(u => (
                      <div key={u.firstName} className="flex items-center gap-3 px-2 py-1 text-sm">
                        <span className="min-w-0 flex-1 truncate font-medium">{u.firstName}</span>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{u.episodes} ep</span>
                        <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground/70">{fmtHours(u.minutes)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {data.household.topShows.length > 0 && (
                <div className="mt-5">
                  <p className="text-sm font-bold">Household favorites</p>
                  <div className="mt-2 grid gap-1">
                    {data.household.topShows.map(s => (
                      <Link key={s.showId} to={`/podcasts/show/${s.showId}`}
                        className="flex items-center gap-3 rounded-card px-2 py-1 text-sm transition hover:bg-accent/40">
                        <span className="min-w-0 flex-1 truncate">{s.name}</span>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmtHours(s.minutes)}</span>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          <p className="mt-8 text-xs text-muted-foreground">
            Counted from how far you actually got in each episode. An episode counts once, in the year you last
            listened to it.
          </p>
        </>
      )}
    </PageContainer>
  )
}
