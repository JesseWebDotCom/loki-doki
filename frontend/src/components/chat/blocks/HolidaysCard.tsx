import { CalendarDays } from 'lucide-react'
import { Card } from '@/components/ui/card'
import type { HolidaysBlockData, HolidayItem } from './types'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function parts(iso: string): { month: string; day: string } {
  const [, m, d] = iso.split('-').map(Number)
  return { month: MONTHS[(m ?? 1) - 1] ?? '', day: String(d ?? '') }
}

function HolidayRow({ h }: { h: HolidayItem }) {
  const { month, day } = parts(h.date)
  return (
    <div className="flex items-center gap-3 rounded-control px-2 py-1.5">
      <div className="flex flex-col items-center justify-center w-10 shrink-0 rounded-control bg-muted/70 py-1">
        <span className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">{month}</span>
        <span className="text-[14px] font-semibold leading-none">{day}</span>
      </div>
      <div className="min-w-0">
        <p className="truncate text-[12px] font-medium">{h.name}</p>
        <p className="text-[11px] text-muted-foreground">{h.weekday}</p>
      </div>
    </div>
  )
}

export function HolidaysCard({ data }: { data: HolidaysBlockData }) {
  if (data.mode === 'lookup' && data.holiday) {
    const h = data.holiday
    const { month, day } = parts(h.date)
    return (
      <Card variant="surface" className="text-sm">
        <div className="flex items-center gap-4 px-4 py-4">
          <div className="flex flex-col items-center justify-center w-16 shrink-0 rounded-card bg-primary/10 py-2">
            <span className="text-[10px] font-medium uppercase tracking-wide text-primary">{month}</span>
            <span className="text-2xl font-bold leading-none text-primary">{day}</span>
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-[14px] leading-snug">{h.name}</p>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{h.weekday} · {data.year} · {data.country}</p>
          </div>
        </div>
      </Card>
    )
  }

  const list = data.holidays ?? []
  if (!list.length) return null
  return (
    <Card variant="surface" className="text-sm">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border/30">
        <CalendarDays className="size-4 text-muted-foreground" />
        <p className="text-[12px] font-medium">
          Public holidays · {data.country} {data.year}
          {data.partial && <span className="text-muted-foreground"> (offline - fixed dates only)</span>}
        </p>
      </div>
      <div className="px-2 py-2 grid grid-cols-1 sm:grid-cols-2 gap-0.5">
        {list.slice(0, 16).map((h, i) => <HolidayRow key={`${h.date}-${i}`} h={h} />)}
      </div>
      {list.length > 16 && (
        <p className="px-4 py-2 text-[11px] text-muted-foreground border-t border-border/30">+ {list.length - 16} more</p>
      )}
    </Card>
  )
}
