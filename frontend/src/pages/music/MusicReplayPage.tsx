// Replay: the year-in-review recap (Spotify-Wrapped-style) computed from real listening
// history. Minutes come from the progress beacon (how far songs actually played), the
// clock shows WHEN the household listens, and everything is playable in place.

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Play, Clock3, Disc3, TrendingUp } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { Spinner } from '@/components/ui/spinner'
import { SongArt } from '@/components/music/SongArt'
import { ArtistAvatar } from '@/components/music/MediaArt'
import { useRadio } from '@/context/RadioContext'
import { getReplay } from '@/lib/music/catalogApi'

const HOUR_LABELS = ['12a', '', '', '3a', '', '', '6a', '', '', '9a', '', '', '12p', '', '', '3p', '', '', '6p', '', '', '9p', '', '']

function StatTile({ icon: Icon, value, label }: { icon: typeof Clock3; value: string; label: string }) {
  return (
    <div className="flex flex-1 flex-col items-center gap-1 rounded-card bg-white/[0.05] p-5 ring-1 ring-inset ring-white/[0.06]">
      <Icon className="size-5 text-brand" />
      <span className="text-3xl font-extrabold tabular-nums tracking-tight">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

export function MusicReplayPage() {
  const radio = useRadio()
  const thisYear = new Date().getFullYear()
  const [year, setYear] = useState(thisYear)
  const { data, isLoading } = useQuery({ queryKey: ['music-replay', year], queryFn: () => getReplay(year), staleTime: 30 * 60 * 1000 })

  const maxClock = Math.max(1, ...(data?.clock ?? [1]))
  const hours = data ? `${Math.floor(data.totalMinutes / 60)}h ${data.totalMinutes % 60}m` : ''

  return (
    <PageContainer width="wide" className="pb-10">
      <PageHeader plain title="Replay" subtitle="Your year in music, from real listening." />

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

      {data && data.totalPlays === 0 && (
        <p className="mt-4 text-sm text-muted-foreground">No listening in {year} yet - go play something worth remembering.</p>
      )}

      {data && data.totalPlays > 0 && (
        <>
          <div className="flex flex-col gap-3 sm:flex-row">
            <StatTile icon={Clock3} value={hours} label="listened" />
            <StatTile icon={Disc3} value={data.totalPlays.toLocaleString()} label="songs played" />
            <StatTile icon={TrendingUp} value={String(data.topArtists.length ? data.topArtists[0]!.artist : 'n/a')} label="top artist" />
          </div>

          <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-2">
            <section>
              <SectionHeader title="Top songs" />
              <div className="mt-3 grid gap-1">
                {data.topSongs.map((t, i) => (
                  <button key={t.videoId} onClick={() => radio.playTrack({ videoId: t.videoId, title: t.title, author: t.artist })}
                    className="group flex items-center gap-3 rounded-card px-2 py-1.5 text-left transition hover:bg-white/[0.06]">
                    <span className="w-6 shrink-0 text-right text-sm font-semibold tabular-nums text-muted-foreground/60">{i + 1}</span>
                    <SongArt trackRef={t.videoId} title={t.title} artist={t.artist} className="size-11" rounded="rounded-control" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{t.title}</p>
                      <p className="truncate text-xs text-muted-foreground">{t.artist}</p>
                    </div>
                    <span className="mr-1 shrink-0 text-xs tabular-nums text-muted-foreground">{t.plays}×</span>
                    <Play className="mr-1 size-4 shrink-0 fill-current opacity-0 transition group-hover:opacity-100" />
                  </button>
                ))}
              </div>
            </section>

            <div className="space-y-8">
              <section>
                <SectionHeader title="Top artists" />
                <div className="mt-3 grid gap-1">
                  {data.topArtists.slice(0, 6).map((a, i) => (
                    <div key={a.artist} className="flex items-center gap-3 rounded-card px-2 py-1.5">
                      <span className="w-6 shrink-0 text-right text-sm font-semibold tabular-nums text-muted-foreground/60">{i + 1}</span>
                      <ArtistAvatar name={a.artist} className="size-11 rounded-full" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{a.artist}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{a.plays} plays</span>
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <SectionHeader title="Your listening clock" />
                <div className="mt-3 flex h-28 items-end gap-1 rounded-card bg-white/[0.04] p-3 ring-1 ring-inset ring-white/[0.06]">
                  {data.clock.map((n, h) => (
                    <div key={h} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                      <div className="w-full rounded-[2px] bg-brand/80 transition-all"
                        style={{ height: `${Math.max(2, (n / maxClock) * 100)}%`, opacity: n ? 1 : 0.15 }}
                        title={`${n} plays`} />
                      <span className="text-[8px] leading-none text-muted-foreground">{HOUR_LABELS[h]}</span>
                    </div>
                  ))}
                </div>
              </section>

              {data.firstPlay && (
                <p className="text-sm text-muted-foreground">
                  The year started with <span className="font-medium text-foreground">{data.firstPlay.title}</span>
                  {data.firstPlay.artist ? <> by <span className="font-medium text-foreground">{data.firstPlay.artist}</span></> : null}
                  {' '}on {new Date(data.firstPlay.atMs).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}.
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </PageContainer>
  )
}
