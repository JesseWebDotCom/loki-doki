// Speed changer (playbackRate). `compact` renders just a tight [-] 1.00x [+] control for the
// transport row; the full form also shows the detected key read-only. True key TRANSPOSE
// (pitch without tempo) needs a pitch-shifter worklet and is a documented follow-up.
import { Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface Props {
  rate: number
  onRate: (r: number) => void
  keyLabel: string | null
  compact?: boolean
}

export function PitchSpeed({ rate, onRate, keyLabel, compact }: Props) {
  const dec = () => onRate(Math.max(0.5, Math.round((rate - 0.05) * 100) / 100))
  const inc = () => onRate(Math.min(1.5, Math.round((rate + 0.05) * 100) / 100))

  if (compact) {
    return (
      <div className="flex items-center gap-0.5">
        <Button variant="ghost" size="icon-sm" onClick={dec} aria-label="Slower"><Minus className="size-3.5" /></Button>
        <span className="min-w-11 text-center text-xs font-semibold tabular-nums text-foreground">{rate.toFixed(2)}x</span>
        <Button variant="ghost" size="icon-sm" onClick={inc} aria-label="Faster"><Plus className="size-3.5" /></Button>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-start justify-around gap-4">
      <div className="flex flex-col items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Key</span>
        <span className="flex h-8 items-center text-sm font-semibold text-foreground">{keyLabel ?? '-'}</span>
      </div>
      <div className="flex flex-col items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Speed</span>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="icon-sm" aria-label="Slower" onClick={dec}><Minus className="size-4" /></Button>
          <span className="min-w-16 text-center text-sm font-semibold tabular-nums text-foreground">{rate.toFixed(2)}x</span>
          <Button variant="secondary" size="icon-sm" aria-label="Faster" onClick={inc}><Plus className="size-4" /></Button>
        </div>
      </div>
    </div>
  )
}
