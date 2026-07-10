// Sonic Adventure (Plexamp): pick a starting song and a destination song from the
// ANALYZED library, and the similarity engine charts a path of tracks that gradually
// transitions from one sound to the other. Both endpoints need sonic analysis, so the
// pickers search music_track_features - not the whole catalog - and the dialog shows a
// coverage gate while the library is still being analyzed.

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowDown, Compass, Music2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/cn'
import { useRadio } from '@/context/RadioContext'
import { adventureStatus, adventureSearch, adventureStationDj, type AdventureTrack } from '@/lib/music/catalogApi'

function SongPick({ label, value, onChange }: {
  label: string
  value: AdventureTrack | null
  onChange: (t: AdventureTrack | null) => void
}) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<AdventureTrack[]>([])
  useEffect(() => {
    if (!q.trim() || value) { setResults([]); return }
    let alive = true
    const t = setTimeout(() => { adventureSearch(q).then(r => { if (alive) setResults(r) }).catch(() => {}) }, 200)
    return () => { alive = false; clearTimeout(t) }
  }, [q, value])

  if (value) {
    return (
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
        <button type="button" onClick={() => { onChange(null); setQ('') }}
          className="flex w-full items-center gap-2.5 rounded-control border border-border/60 bg-foreground/[0.04] px-3 py-2 text-left transition hover:bg-foreground/[0.08]"
          title="Change song">
          <Music2 className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{value.title ?? value.ref}</span>
            {value.artist && <span className="block truncate text-xs text-muted-foreground">{value.artist}</span>}
          </span>
        </button>
      </div>
    )
  }
  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search your analyzed library…" />
      {results.length > 0 && (
        <div className="mt-1 max-h-44 overflow-y-auto rounded-control border border-border/60">
          {results.map(r => (
            <button key={r.ref} type="button" onClick={() => onChange(r)}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-foreground/[0.06]">
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{r.title ?? r.ref}</span>
                {r.artist && <span className="block truncate text-xs text-muted-foreground">{r.artist}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function SonicAdventureDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const radio = useRadio()
  const navigate = useNavigate()
  const [from, setFrom] = useState<AdventureTrack | null>(null)
  const [to, setTo] = useState<AdventureTrack | null>(null)
  const { data: status } = useQuery({ queryKey: ['adventure-status'], queryFn: adventureStatus, enabled: open, staleTime: 60_000 })
  const analyzed = status?.analyzed ?? null
  const gated = analyzed != null && analyzed < 10

  const go = () => {
    if (!from || !to) return
    if (from.ref === to.ref) { toast.error('Pick two different songs'); return }
    radio.start(adventureStationDj(from, to))
    onOpenChange(false)
    navigate('/music/now-playing')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Compass className="size-5" /> Sonic Adventure</DialogTitle>
          <DialogDescription>
            Chart a course from one song to another — every stop along the way sounds a little
            more like the destination.
          </DialogDescription>
        </DialogHeader>

        {gated ? (
          <p className="rounded-control bg-foreground/[0.05] p-3 text-sm text-muted-foreground">
            Sonic Adventure travels through your <span className="font-medium text-foreground">analyzed</span> library,
            and only {analyzed} {analyzed === 1 ? 'track is' : 'tracks are'} analyzed so far. Keep listening and saving
            music — analysis runs in the background and this unlocks on its own.
          </p>
        ) : (
          <div className="space-y-3">
            <SongPick label="Start" value={from} onChange={setFrom} />
            <div className="flex justify-center text-muted-foreground/60"><ArrowDown className="size-4" /></div>
            <SongPick label="Destination" value={to} onChange={setTo} />
          </div>
        )}

        <div className={cn('flex justify-end', gated && 'hidden')}>
          <Button onClick={go} disabled={!from || !to}>
            <Compass className="size-4" /> Start the adventure
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
