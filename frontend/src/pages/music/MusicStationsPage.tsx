import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Plus, Download } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { PageContainer } from '@/components/shared/PageContainer'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { Button } from '@/components/ui/button'
import { StationCard } from '@/components/music/StationCard'
import { StationEditorDialog } from '@/components/music/StationEditorDialog'
import { SonicAdventureDialog } from '@/components/music/SonicAdventureDialog'
import { useRadio } from '@/context/RadioContext'
import { useMusicMode } from '@/components/music/MusicLayout'
import { listStations, listOfflineStations, instantStationDj, personalStationDj, PERSONAL_STATIONS, type Station } from '@/lib/music/catalogApi'

function Grid({ stations }: { stations: Station[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {stations.map(s => <StationCard key={s.id} station={s} />)}
    </div>
  )
}

/** Offline mode: only the stations you've actually downloaded, with download/DJ readiness. */
function OfflineStations() {
  // Poll only while a station save is in progress (matches useOffline.ts) — not every 5s forever.
  const { data } = useQuery({ queryKey: ['music-offline-stations'], queryFn: listOfflineStations, refetchInterval: q => (q.state.data?.stations.some(s => s.offline.status === 'pending' || s.offline.status === 'partial') ? 4000 : false) })
  const stations = data?.stations ?? []
  return (
    <PageContainer width="wide" className="pb-10">
      <PageHeader plain title="Stations"
        subtitle="The stations you've saved for offline play." />
      {stations.length === 0 ? (
        <div className="mt-10 flex flex-col items-center gap-2 text-center text-sm text-muted-foreground">
          <Download className="size-8 opacity-40" />
          <p>No offline stations yet. Open a station and hit <span className="font-medium text-foreground">Save offline</span> to play it without internet.</p>
        </div>
      ) : (
        <Grid stations={stations} />
      )}
    </PageContainer>
  )
}

export function MusicStationsPage() {
  const radio = useRadio()
  const navigate = useNavigate()
  const { mode } = useMusicMode()
  const [params, setParams] = useSearchParams()
  const { data: buckets } = useQuery({ queryKey: ['music-stations'], queryFn: listStations, enabled: mode === 'online' })
  const [editorOpen, setEditorOpen] = useState(false)
  const [adventureOpen, setAdventureOpen] = useState(false)
  const [cat, setCat] = useState<string>('All')

  // Deep-link from the companion / search: ?instant=<query>&seedType=<artist|song|genre> starts
  // an ephemeral station immediately.
  const instant = params.get('instant')
  const instantSeed = (params.get('seedType') as 'artist' | 'song' | 'genre' | null) ?? 'genre'
  useEffect(() => {
    if (!instant) return
    radio.start(instantStationDj({ type: instantSeed, value: instant }))
    setParams(p => { p.delete('instant'); p.delete('seedType'); return p }, { replace: true })
    navigate('/music/now-playing')
  }, [instant, instantSeed, radio, setParams, navigate])

  const builtin = buckets?.builtin ?? []
  const order = buckets?.categories ?? []
  // Group built-ins by category, preserving the backend's category order.
  const grouped = useMemo(() => {
    const by = new Map<string, Station[]>()
    for (const s of builtin) {
      const c = s.category ?? 'More'
      if (!by.has(c)) by.set(c, [])
      by.get(c)!.push(s)
    }
    const cats = [...order.filter(c => by.has(c)), ...[...by.keys()].filter(c => !order.includes(c))]
    return cats.map(c => [c, by.get(c)!] as const)
  }, [builtin, order])

  if (mode === 'offline') return <OfflineStations />

  return (
    <PageContainer width="wide" className="pb-10">
      <PageHeader plain title="Stations" subtitle="Generative AI radio, built from a prompt."
        actions={<Button onClick={() => setEditorOpen(true)}><Plus className="size-4" /> New station</Button>} />

      {/* Personal stations (Plexamp): seeded by YOUR history + favorites, not a prompt. */}
      <section className="mt-2 mb-6">
        <SectionHeader title="Made for you" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <button type="button" onClick={() => setAdventureOpen(true)}
            className="flex items-center gap-3 rounded-card border border-border/60 bg-card p-4 text-left transition hover:bg-foreground/[0.04]">
            {/* design-ok(hex-in-tsx): station identity gradient, same contract as the personal cards */}
            <span className="grid size-11 shrink-0 place-items-center rounded-control text-xl"
              style={{ background: 'linear-gradient(135deg, #f43f5e, #be123c)' }}>
              🧭
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold">Sonic Adventure</span>
              <span className="block truncate text-xs text-muted-foreground">Chart a course from one song to another</span>
            </span>
          </button>
          {PERSONAL_STATIONS.map(p => (
            <button key={p.kind} type="button"
              onClick={() => { radio.start(personalStationDj(p.kind)); navigate('/music/now-playing') }}
              className="flex items-center gap-3 rounded-card border border-border/60 bg-card p-4 text-left transition hover:bg-foreground/[0.04]">
              <span className="grid size-11 shrink-0 place-items-center rounded-control text-xl"
                style={{ background: `linear-gradient(135deg, ${p.color}, ${p.colorDark})` }}>
                {p.emoji}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">{p.label}</span>
                <span className="block truncate text-xs text-muted-foreground">{p.description}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      {(buckets?.mine.length ?? 0) > 0 && (
        <section className="mt-2 mb-6"><SectionHeader title="Your stations" /><Grid stations={buckets!.mine} /></section>
      )}
      {(buckets?.shared.length ?? 0) > 0 && (
        <section className="mb-6"><SectionHeader title="Shared by your family" /><Grid stations={buckets!.shared} /></section>
      )}

      {/* Category browse */}
      <ChipRow className="mb-5">
        <Chip label="All" active={cat === 'All'} onClick={() => setCat('All')} />
        {grouped.map(([c]) => <Chip key={c} label={c} active={cat === c} onClick={() => setCat(c)} />)}
      </ChipRow>

      {cat === 'All' ? (
        grouped.map(([c, list]) => (
          <section key={c} className="mb-8"><SectionHeader title={c} /><Grid stations={list} /></section>
        ))
      ) : (
        <section className="mb-8"><Grid stations={grouped.find(([c]) => c === cat)?.[1] ?? []} /></section>
      )}

      <StationEditorDialog open={editorOpen} onOpenChange={setEditorOpen} station={null} />
      <SonicAdventureDialog open={adventureOpen} onOpenChange={setAdventureOpen} />
    </PageContainer>
  )
}
