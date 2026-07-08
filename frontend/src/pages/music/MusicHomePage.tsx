import { useQuery } from '@tanstack/react-query'
import { Radio, Download } from 'lucide-react'
import { artUrlForRef } from '@/lib/music/trackRef'
import { PageHeader } from '@/components/shared/PageHeader'
import { PageContainer } from '@/components/shared/PageContainer'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { StationCard } from '@/components/music/StationCard'
import { useRadio } from '@/context/RadioContext'
import { useMusicModeOptional } from '@/components/music/MusicLayout'
import { useOfflineStations, useOfflineSongs } from '@/lib/music/useOffline'
import { listStations, getHistory, type Station } from '@/lib/music/catalogApi'

function StationGrid({ stations }: { stations: Station[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {stations.map(s => <StationCard key={s.id} station={s} />)}
    </div>
  )
}

/** Offline home: station-first, only what's downloaded - no prebuilt catalog. */
function OfflineHome() {
  const radio = useRadio()
  const { data: stationData } = useOfflineStations()
  const { data: offlineData } = useOfflineSongs()
  const { data: hist } = useQuery({ queryKey: ['music-history'], queryFn: () => getHistory(20) })
  const stations = stationData?.stations ?? []
  const readyIds = new Set((offlineData?.offline ?? []).filter(t => t.status === 'ready').map(t => t.videoId))
  const recent = (hist?.history ?? []).filter(h => readyIds.has(h.videoId)).slice(0, 12)

  return (
    <PageContainer width="wide" className="pb-10">
      <PageHeader eyebrow="Music · Offline" title="Listen offline"
        subtitle="Your downloaded stations and songs, no internet needed." />

      {recent.length > 0 && (
        <section className="mt-2">
          <SectionHeader title="Continue listening" />
          <div className="flex gap-3 overflow-x-auto pb-2 no-scrollbar">
            {recent.map(h => (
              <button key={h.id} onClick={() => radio.playTrack({ videoId: h.videoId, title: h.title, author: h.artist })}
                className="flex w-40 shrink-0 flex-col gap-2 rounded-card border border-border/60 bg-card p-2.5 text-left transition hover:border-brand/40">
                <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-control bg-gradient-to-br from-brand/30 to-brand/10">
                  <Radio className="absolute size-7 text-brand/60" />
                  <img src={artUrlForRef(h.videoId) ?? undefined} alt="" className="relative size-full object-cover" loading="lazy"
                    onError={e => { e.currentTarget.style.visibility = 'hidden' }} />
                </div>
                <div><p className="truncate text-xs font-semibold">{h.title}</p>{h.artist && <p className="truncate text-[11px] text-muted-foreground">{h.artist}</p>}</div>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="mt-6">
        <SectionHeader title="Your offline stations" to="/music/stations" />
        {stations.length > 0 ? <StationGrid stations={stations} /> : (
          <div className="mt-6 flex flex-col items-center gap-2 text-center text-sm text-muted-foreground">
            <Download className="size-8 opacity-40" />
            <p>No offline stations yet. Open a station and hit <span className="font-medium text-foreground">Save offline</span> to play it without internet.</p>
          </div>
        )}
      </section>
    </PageContainer>
  )
}

export function MusicHomePage() {
  const radio = useRadio()
  const offline = useMusicModeOptional() === 'offline'
  const { data: buckets } = useQuery({ queryKey: ['music-stations'], queryFn: listStations, enabled: !offline })
  const { data: hist } = useQuery({ queryKey: ['music-history'], queryFn: () => getHistory(12), enabled: !offline })

  const recent = hist?.history ?? []

  if (offline) return <OfflineHome />

  return (
    <PageContainer width="wide" className="pb-10">
      <PageHeader plain title="Listen" />

      {recent.length > 0 && (
        <section className="mt-2">
          <SectionHeader title="Continue listening" />
          <div className="flex gap-3 overflow-x-auto pb-2 no-scrollbar">
            {recent.map(h => (
              <button key={h.id}
                onClick={() => radio.playTrack({ videoId: h.videoId, title: h.title, author: h.artist })}
                className="flex w-40 shrink-0 flex-col gap-2 rounded-card border border-border/60 bg-card p-2.5 text-left transition hover:border-brand/40">
                <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-control bg-gradient-to-br from-brand/30 to-brand/10">
                  <Radio className="absolute size-7 text-brand/60" />
                  <img src={artUrlForRef(h.videoId) ?? undefined} alt=""
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
    </PageContainer>
  )
}
