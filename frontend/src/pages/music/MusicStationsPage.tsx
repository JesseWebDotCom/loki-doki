import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Plus, Download } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { Button } from '@/components/ui/button'
import { StationCard } from '@/components/music/StationCard'
import { StationEditorDialog } from '@/components/music/StationEditorDialog'
import { useRadio } from '@/context/RadioContext'
import { useMusicMode } from '@/components/music/MusicLayout'
import { listStations, listOfflineStations, instantStationDj, type Station } from '@/lib/music/catalogApi'

function Grid({ stations }: { stations: Station[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {stations.map(s => <StationCard key={s.id} station={s} />)}
    </div>
  )
}

/** Offline mode: only the stations you've actually downloaded, with download/DJ readiness. */
function OfflineStations() {
  const { data } = useQuery({ queryKey: ['music-offline-stations'], queryFn: listOfflineStations, refetchInterval: 5000 })
  const stations = data?.stations ?? []
  return (
    <div className="px-5 pt-6">
      <PageHeader variant="plain" className="!px-0 !pt-0 !pb-5" eyebrow="Music · Offline" title="Stations"
        subtitle="The stations you've saved for offline play." />
      {stations.length === 0 ? (
        <div className="mt-10 flex flex-col items-center gap-2 text-center text-sm text-muted-foreground">
          <Download className="size-8 opacity-40" />
          <p>No offline stations yet. Open a station and hit <span className="font-medium text-foreground">Save offline</span> to play it without internet.</p>
        </div>
      ) : (
        <Grid stations={stations} />
      )}
    </div>
  )
}

export function MusicStationsPage() {
  const radio = useRadio()
  const navigate = useNavigate()
  const { mode } = useMusicMode()
  const [params, setParams] = useSearchParams()
  const { data: buckets } = useQuery({ queryKey: ['music-stations'], queryFn: listStations, enabled: mode === 'online' })
  const [editorOpen, setEditorOpen] = useState(false)
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
    <div className="px-5 pt-6">
      <PageHeader variant="plain" className="!px-0 !pt-0 !pb-5" eyebrow="Music" title="Stations" subtitle="Generative AI radio, built from a prompt."
        actions={<Button onClick={() => setEditorOpen(true)}><Plus className="size-4" /> New station</Button>} />

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
    </div>
  )
}
