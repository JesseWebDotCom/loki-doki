import { useQuery } from '@tanstack/react-query'
import { Radio } from 'lucide-react'
import { proxyImg } from '@/lib/img'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { StationCard } from '@/components/music/StationCard'
import { useRadio } from '@/context/RadioContext'
import { listStations, getHistory, type Station } from '@/lib/music/catalogApi'

function StationGrid({ stations }: { stations: Station[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {stations.map(s => <StationCard key={s.id} station={s} />)}
    </div>
  )
}

export function MusicHomePage() {
  const radio = useRadio()
  const { data: buckets } = useQuery({ queryKey: ['music-stations'], queryFn: listStations })
  const { data: hist } = useQuery({ queryKey: ['music-history'], queryFn: () => getHistory(12) })

  const recent = hist?.history ?? []

  return (
    <div className="px-5 pt-6">
      <PageHeader variant="plain" className="!px-0 !pt-0 !pb-5" eyebrow="Music" title="Listen" subtitle="AI stations, your library, and the whole catalog." />

      {recent.length > 0 && (
        <section className="mt-2">
          <SectionHeader title="Continue listening" />
          <div className="flex gap-3 overflow-x-auto pb-2 no-scrollbar">
            {recent.map(h => (
              <button key={h.id}
                onClick={() => radio.playTrack({ videoId: h.videoId, title: h.title, author: h.artist })}
                className="flex w-40 shrink-0 flex-col gap-2 rounded-xl border border-border/60 bg-card p-2.5 text-left transition hover:border-brand/40">
                <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-brand/30 to-brand/10">
                  <Radio className="absolute size-7 text-brand/60" />
                  <img src={proxyImg(`https://i.ytimg.com/vi/${h.videoId}/mqdefault.jpg`)} alt=""
                    className="relative size-full object-cover" loading="lazy"
                    onError={e => { e.currentTarget.style.visibility = 'hidden' }} />
                </div>
                <div>
                  <p className="truncate text-xs font-semibold">{h.title}</p>
                  {h.artist && <p className="truncate text-[11px] text-muted-foreground">{h.artist}</p>}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="mt-6">
        <SectionHeader title="Featured stations" to="/music/stations" />
        <StationGrid stations={(buckets?.builtin ?? []).slice(0, 8)} />
      </section>

      {(buckets?.shared.length ?? 0) > 0 && (
        <section className="mt-8">
          <SectionHeader title="Shared by your family" to="/music/stations" />
          <StationGrid stations={buckets!.shared} />
        </section>
      )}

      {(buckets?.mine.length ?? 0) > 0 && (
        <section className="mt-8 mb-4">
          <SectionHeader title="Your stations" to="/music/stations" />
          <StationGrid stations={buckets!.mine} />
        </section>
      )}
    </div>
  )
}
