import { Calculator } from 'lucide-react'
import { Card } from '@/components/ui/card'
import type { CalcBlockData } from './types'

export function CalcResult({ data }: { data: CalcBlockData }) {
  return (
    <Card variant="surface" className="flex items-center gap-3 px-4 py-3 text-sm">
      <Calculator className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex items-baseline gap-2 min-w-0 flex-wrap">
        <span className="font-mono text-muted-foreground text-[13px] truncate">{data.expression}</span>
        <span className="text-muted-foreground">=</span>
        <span className="font-mono font-semibold text-[15px] text-foreground">{data.resultStr}</span>
      </div>
    </Card>
  )
}
