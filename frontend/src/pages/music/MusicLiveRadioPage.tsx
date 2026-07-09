import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Play, Search, Plus, Trash2, CircleDot, Square, Link2 } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { PageContainer } from '@/components/shared/PageContainer'
import { Spinner } from '@/components/ui/spinner'
import { StatusDot } from '@/components/shared/StatusDot'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { LiveStationCard, LiveStationFavicon, stationTagLine } from '@/components/music/LiveStationCard'
import { useLiveRadio } from '@/context/LiveRadioContext'
import { cn } from '@/lib/cn'
import {
  searchLiveStations, fetchLiveGenres, fetchLiveLibrary, addLiveStation, addManualStation,
  removeLiveStation, startRecording, listRecordings, stopRecording,
  type LiveSearchStation, type LiveLibraryStation, type LiveRecording,
} from '@/lib/music/liveRadioApi'

const RECORD_PRESETS = [15, 30, 60, 120] as const

const fmtRemaining = (sec: number) => {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The recording still being captured for a station, if any. */
const activeRecFor = (recs: LiveRecording[], stationId: string) =>
  recs.find(r => r.stationId === stationId && (r.status === 'pending' || r.status === 'recording'))

function SavedStationCard({ st, rec, now }: { st: LiveLibraryStation; rec: LiveRecording | undefined; now: number }) {
  const live = useLiveRadio()
  const qc = useQueryClient()
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const playing = live.active && live.station?.id === st.id
  const meta = [st.codec, st.bitrate ? `${st.bitrate} kbps` : null].filter(Boolean).join(' · ')
  const remainingSec = rec ? rec.requestedSec - (now - new Date(rec.createdAt).getTime()) / 1000 : 0

  const record = async (minutes: number) => {
    try {
      await startRecording(st.id, minutes)
      await qc.invalidateQueries({ queryKey: ['live-radio-recordings'] })
      toast.success('Recording started')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not start recording') }
  }
  const stopRec = async () => {
    if (!rec) return
    try {
      await stopRecording(rec.id)
      await qc.invalidateQueries({ queryKey: ['live-radio-recordings'] })
      toast.success('Recording saved')
    } catch { toast.error('Could not stop recording') }
  }
  const remove = async () => {
    try {
      await removeLiveStation(st.id)
      await qc.invalidateQueries({ queryKey: ['live-radio-library'] })
      toast.success('Station removed')
    } catch { toast.error('Could not remove station') }
  }

  return (
    // design-ok(glass-on-plain-bg): elevated tile on the Music app's true-black surface
    <div className="flex items-center gap-3 rounded-card bg-white/[0.04] p-3 ring-1 ring-inset ring-white/[0.06] transition hover:bg-white/[0.07]">
      <LiveStationFavicon favicon={st.favicon} className="size-14 rounded-card" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{st.name}</p>
        <p className="truncate text-xs text-muted-foreground">{stationTagLine(st.tags, st.country) || (st.source === 'manual' ? 'Custom stream' : st.language ?? '')}</p>
        <p className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground/70">
          {meta}
          {rec && (
            <span className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-1.5 py-0.5 font-medium text-destructive">
              <StatusDot status="error" pulse />
              REC {fmtRemaining(remainingSec)}
            </span>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button onClick={() => live.playLive({ id: st.id, name: st.name, favicon: st.favicon })}
          className={cn(
            'grid size-9 place-items-center rounded-full bg-foreground text-background transition hover:opacity-90',
            playing && 'ring-2 ring-warning',
          )}
          aria-label={`Play ${st.name}`}>
          <Play className="ml-0.5 size-4 fill-current" />
        </button>
        {rec ? (
          <button onClick={() => setConfirmStop(true)}
            className="grid size-9 place-items-center rounded-full text-destructive transition hover:bg-destructive/10"
            aria-label="Stop recording" title="Stop recording">
            <Square className="size-4 fill-current" />
          </button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground"
                aria-label="Record" title="Record">
                <CircleDot className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {RECORD_PRESETS.map(m => (
                <DropdownMenuItem key={m} onClick={() => void record(m)}>Record {m} min</DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <button onClick={() => setConfirmRemove(true)}
          className="grid size-9 place-items-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-destructive"
          aria-label="Remove station">
          <Trash2 className="size-4" />
        </button>
      </div>
      <ConfirmDialog open={confirmRemove} onOpenChange={setConfirmRemove} title="Remove station?"
        description={`“${st.name}” will be removed from your stations. Recordings are kept.`}
        destructive confirmLabel="Remove" onConfirm={() => void remove()} />
      <ConfirmDialog open={confirmStop} onOpenChange={setConfirmStop} title="Stop and keep recording?"
        description="The recording ends now and everything captured so far is saved."
        confirmLabel="Stop and keep" onConfirm={() => void stopRec()} />
    </div>
  )
}

function AddByUrlDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setName(''); setUrl('') } }, [open])
  const add = async () => {
    const n = name.trim(), u = url.trim()
    if (!n || !u) return
    setBusy(true)
    try {
      await addManualStation({ name: n, streamUrl: u })
      await qc.invalidateQueries({ queryKey: ['live-radio-library'] })
      toast.success('Station added')
      onOpenChange(false)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not add station') }
    finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Add station by URL</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Input value={name} autoFocus placeholder="Station name" onChange={e => setName(e.target.value)} />
          <Input value={url} placeholder="Stream URL (http://…)" onChange={e => setUrl(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void add() }} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={add} disabled={busy || !name.trim() || !url.trim()}>
            {busy ? <Spinner className="text-current" /> : <Plus className="size-4" />} Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function MusicLiveRadioPage() {
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const q = params.get('q')?.trim() ?? ''
  const [term, setTerm] = useState(q)
  const [genre, setGenre] = useState('')
  const [countryInput, setCountryInput] = useState('')
  const [country, setCountry] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [addingId, setAddingId] = useState<string | null>(null)

  // Debounce the search box into ?q= (deep-linkable) and the country box into the query.
  useEffect(() => { setTerm(q) }, [q])
  useEffect(() => {
    const t = setTimeout(() => {
      setParams(p => { const v = term.trim(); if (v) p.set('q', v); else p.delete('q'); return p }, { replace: true })
    }, 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term])
  useEffect(() => {
    const t = setTimeout(() => setCountry(countryInput.trim()), 400)
    return () => clearTimeout(t)
  }, [countryInput])

  const { data: library } = useQuery({ queryKey: ['live-radio-library'], queryFn: fetchLiveLibrary })
  const { data: genres } = useQuery({ queryKey: ['live-radio-genres'], queryFn: fetchLiveGenres })
  const { data: recordings } = useQuery({
    queryKey: ['live-radio-recordings'], queryFn: listRecordings,
    refetchInterval: (query) =>
      (query.state.data ?? []).some(r => r.status === 'pending' || r.status === 'recording') ? 5000 : false,
  })
  const hasSearch = !!(q || genre || country)
  // No filters → radio-browser's top-voted stations worldwide, so the page starts with a
  // browsable list instead of an empty search box.
  const { data: results, isLoading: searching } = useQuery({
    queryKey: ['live-radio-search', q, genre, country],
    queryFn: () => searchLiveStations({ name: q || undefined, genre: genre || undefined, country: country || undefined, limit: 30 }),
  })

  const saved = library ?? []
  const recs = recordings ?? []
  const savedUuids = useMemo(() => new Set(saved.map(s => s.stationUuid).filter(Boolean)), [saved])

  // 1-second tick for the "remaining time" readout on active recording badges.
  const anyRecording = recs.some(r => r.status === 'pending' || r.status === 'recording')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!anyRecording) return
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [anyRecording])

  const add = async (s: LiveSearchStation) => {
    setAddingId(s.id)
    try {
      await addLiveStation(s)
      await qc.invalidateQueries({ queryKey: ['live-radio-library'] })
      toast.success(`Added “${s.name}”`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not add station') }
    finally { setAddingId(null) }
  }

  return (
    <PageContainer width="wide" className="pb-10">
      <PageHeader plain title="Live Radio"
        subtitle="Real stations, streaming live from around the world."
        actions={<Button onClick={() => setAddOpen(true)}><Link2 className="size-4" /> Add by URL</Button>} />

      {/* Your stations */}
      {saved.length > 0 && (
        <section className="mb-8">
          <SectionHeader title="Your stations" />
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {saved.map(st => <SavedStationCard key={st.id} st={st} rec={activeRecFor(recs, st.id)} now={now} />)}
          </div>
        </section>
      )}

      {/* Search */}
      <section className="mb-8">
        <SectionHeader title="Find stations" />
        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={term} onChange={e => setTerm(e.target.value)} placeholder="Search stations by name…" className="pl-9" />
          </div>
          <Input value={countryInput} onChange={e => setCountryInput(e.target.value)} placeholder="Country" className="sm:w-44" />
        </div>
        {(genres?.length ?? 0) > 0 && (
          <ChipRow className="mt-3">
            {genres!.map(g => (
              <Chip key={g.id} label={g.label} active={genre === g.id}
                onClick={() => setGenre(cur => cur === g.id ? '' : g.id)} />
            ))}
          </ChipRow>
        )}

        <div className="mt-4">
          {!hasSearch && (
            <p className="mb-3 text-overline text-muted-foreground">Popular stations</p>
          )}
          {searching && <p className="text-sm text-muted-foreground">Searching…</p>}
          {!searching && (results?.length ?? 0) === 0 && (
            <p className="text-sm text-muted-foreground">
              {hasSearch
                ? 'No stations found. Try a different name, genre, or country.'
                : 'Could not reach the station directory. Check your connection and try again.'}
            </p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(results ?? []).map(s => (
              <LiveStationCard key={s.id} s={s} onAdd={s => void add(s)}
                adding={addingId === s.id} added={savedUuids.has(s.id)} />
            ))}
          </div>
        </div>
      </section>

      <AddByUrlDialog open={addOpen} onOpenChange={setAddOpen} />
    </PageContainer>
  )
}
