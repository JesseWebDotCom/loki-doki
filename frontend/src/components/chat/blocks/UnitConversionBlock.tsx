import { ArrowRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { UnitConversionBlockData } from './types'

export function UnitConversionBlock({ data }: { data: UnitConversionBlockData }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/50 bg-card px-4 py-3 text-sm">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono font-semibold text-[15px]">
          {data.value} <span className="text-muted-foreground text-sm font-normal">{data.fromUnit}</span>
        </span>
        <ArrowRight className="size-3.5 text-muted-foreground shrink-0" />
        <span className="font-mono font-semibold text-[15px]">
          {data.resultStr} <span className="text-muted-foreground text-sm font-normal">{data.toUnit}</span>
        </span>
      </div>
      {data.category && (
        <Badge variant="secondary" className="ml-auto shrink-0 text-[10px] capitalize">
          {data.category}
        </Badge>
      )}
    </div>
  )
}
