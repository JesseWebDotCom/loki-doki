// Smart-metronome control panel (matches Moises' panel): on/off, volume, L&R pan,
// subdivision, and a BPM readout with an Italian tempo term. The actual click scheduling
// lives in lib/music/metronome.ts, locked to the analysed beat grid.
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import type { Subdivision } from '@/lib/music/metronome'

interface Props {
  enabled: boolean
  onToggle: (on: boolean) => void
  volume: number
  onVolume: (v: number) => void
  pan: number
  onPan: (p: number) => void
  subdivision: Subdivision
  onSubdivision: (s: Subdivision) => void
  bpm: number | null
}

const SUBS: Subdivision[] = [0.5, 1, 2]

export function SmartMetronome(p: Props) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-foreground">Smart Metronome</span>
        <Button
          variant={p.enabled ? 'default' : 'secondary'} size="sm"
          onClick={() => p.onToggle(!p.enabled)}
          aria-pressed={p.enabled}
        >{p.enabled ? 'On' : 'Off'}</Button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <label className="space-y-1.5">
          <span className="text-xs text-muted-foreground">Volume</span>
          <input type="range" min={0} max={1} step={0.01} value={p.volume}
            onChange={(e) => p.onVolume(Number(e.target.value))}
            aria-label="Metronome volume" className="h-1 w-full cursor-pointer accent-primary" />
        </label>
        <label className="space-y-1.5">
          <span className="text-xs text-muted-foreground">L &amp; R</span>
          <input type="range" min={-1} max={1} step={0.01} value={p.pan}
            onChange={(e) => p.onPan(Number(e.target.value))}
            aria-label="Metronome pan" className="h-1 w-full cursor-pointer accent-primary" />
        </label>
      </div>

      <div className="space-y-1.5">
        <span className="text-xs text-muted-foreground">Subdivision</span>
        <div className="grid grid-cols-3 gap-2">
          {SUBS.map((s) => (
            <Button key={s} variant={p.subdivision === s ? 'default' : 'secondary'} size="sm"
              onClick={() => p.onSubdivision(s)} aria-pressed={p.subdivision === s}>
              {s === 0.5 ? '0.5x' : s === 1 ? '1x' : '2x'}
            </Button>
          ))}
        </div>
      </div>

      {p.bpm != null && (
        <div className="flex flex-col items-center gap-1 pt-1">
          <span className="text-xs text-muted-foreground">BPM</span>
          <div className={cn('flex size-14 items-center justify-center rounded-full text-lg font-bold tabular-nums',
            'bg-brand/15 text-brand')}>
            {Math.round(p.bpm)}
          </div>
        </div>
      )}
    </div>
  )
}
