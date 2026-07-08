// Compact musical controls for the top player: BPM (tempo, pitch-preserved), Key (transpose),
// a reset-to-original, and a minimal metronome (a toggle that opens a small popover for
// subdivision / volume / pan). Tempo + key are driven by the engine's SoundTouch insert.
import { Minus, Plus, RotateCcw, Timer } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { Subdivision } from '@/lib/music/metronome'

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
function transposeKey(label: string | null, semi: number): string {
  if (!label) return '-'
  const m = label.match(/^([A-G]#?)(.*)$/)
  const idx = m ? NOTES.indexOf(m[1]) : -1
  if (idx < 0) return label
  return NOTES[(idx + semi + 120) % 12] + (m![2] || '')
}

function Stepper({ label, value, onDec, onInc, dim }: {
  label: string; value: string; onDec: () => void; onInc: () => void; dim?: boolean
}) {
  return (
    <div className="flex items-center rounded-full bg-muted/70 px-0.5">
      <Button variant="ghost" size="icon-sm" className="size-6" onClick={onDec} aria-label={`${label} down`}><Minus className="size-3" /></Button>
      <div className="min-w-[3.25rem] px-1 text-center leading-none">
        <div className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">{label}</div>
        <div className={cn('text-xs font-semibold tabular-nums', dim ? 'text-muted-foreground' : 'text-foreground')}>{value}</div>
      </div>
      <Button variant="ghost" size="icon-sm" className="size-6" onClick={onInc} aria-label={`${label} up`}><Plus className="size-3" /></Button>
    </div>
  )
}

const SUBS: Subdivision[] = [0.5, 1, 2]

export interface StudioControlsProps {
  bpm: number | null
  tempoRatio: number
  onTempoRatio: (r: number) => void
  semitones: number
  onSemitones: (n: number) => void
  keyLabel: string | null
  onReset: () => void
  metroOn: boolean
  onMetroToggle: (on: boolean) => void
  metroVol: number
  onMetroVol: (v: number) => void
  metroPan: number
  onMetroPan: (p: number) => void
  subdivision: Subdivision
  onSubdivision: (s: Subdivision) => void
}

export function StudioControls(p: StudioControlsProps) {
  const displayBpm = p.bpm ? Math.round(p.bpm * p.tempoRatio) : null
  const modified = p.tempoRatio !== 1 || p.semitones !== 0
  const stepBpm = (delta: number) => { if (!p.bpm) return; const next = (displayBpm ?? p.bpm) + delta; p.onTempoRatio(Math.max(0.5, Math.min(2, next / p.bpm))) }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {p.bpm != null && (
        <Stepper label="BPM" value={String(displayBpm)} dim={p.tempoRatio !== 1 ? false : true}
          onDec={() => stepBpm(-1)} onInc={() => stepBpm(1)} />
      )}
      <Stepper label="Key" value={transposeKey(p.keyLabel, p.semitones)} dim={p.semitones === 0}
        onDec={() => p.onSemitones(Math.max(-12, p.semitones - 1))} onInc={() => p.onSemitones(Math.min(12, p.semitones + 1))} />

      {modified && (
        <Button variant="ghost" size="icon-sm" className="size-7" onClick={p.onReset} aria-label="Reset key & tempo to original">
          <RotateCcw className="size-3.5" />
        </Button>
      )}

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Metronome"
            className={cn('size-7 rounded-full', p.metroOn && 'bg-brand/15 text-brand hover:bg-brand/20')}>
            <Timer className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-56 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-foreground">Metronome</span>
            <Button variant={p.metroOn ? 'default' : 'secondary'} size="sm" onClick={() => p.onMetroToggle(!p.metroOn)}>
              {p.metroOn ? 'On' : 'Off'}
            </Button>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">Subdivision</span>
            <div className="grid grid-cols-3 gap-1">
              {SUBS.map((s) => (
                <Button key={s} variant={p.subdivision === s ? 'default' : 'secondary'} size="sm" onClick={() => p.onSubdivision(s)}>
                  {s === 0.5 ? '0.5x' : s === 1 ? '1x' : '2x'}
                </Button>
              ))}
            </div>
          </div>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Volume</span>
            <input type="range" min={0} max={1} step={0.01} value={p.metroVol} onChange={(e) => p.onMetroVol(Number(e.target.value))} className="h-1 w-full cursor-pointer accent-primary" />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">L &amp; R</span>
            <input type="range" min={-1} max={1} step={0.01} value={p.metroPan} onChange={(e) => p.onMetroPan(Number(e.target.value))} className="h-1 w-full cursor-pointer accent-primary" />
          </label>
        </PopoverContent>
      </Popover>
    </div>
  )
}
