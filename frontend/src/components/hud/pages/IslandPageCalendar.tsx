import { cn } from '@/lib/cn'
import { useTodayItems, diffDays, formatMonDay, todayIso, formatEventTime, type CalendarEventItem } from '../useTodayItems'

// Calendar page of the island panel: month grid with holiday + family-event dots |
// today's items (incl. synced iCloud events) | upcoming events and holidays merged,
// mirroring SuperIsland's calendar layout.

function MonthGrid({ holidayDates, eventDates }: { holidayDates: Set<string>; eventDates: Set<string> }) {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth()
  const first = new Date(year, month, 1)
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const offset = first.getDay()
  const iso = (day: number) => `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`

  return (
    <div>
      <div className="mb-1 text-sm font-semibold text-white/85">
        {now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
      </div>
      <div className="grid grid-cols-7 gap-y-0.5 text-center">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
          <span key={i} className="text-[9px] text-white/35">{d}</span>
        ))}
        {Array.from({ length: offset }, (_, i) => <span key={`pad-${i}`} />)}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const day = i + 1
          const isToday = day === now.getDate()
          const hasHoliday = holidayDates.has(iso(day))
          const hasEvent = eventDates.has(iso(day))
          return (
            <div key={day} className="flex flex-col items-center">
              {/* design-ok(glass-on-plain-bg): today highlight inside the black island surface */}
              <span className={cn(
                'flex size-[18px] items-center justify-center rounded-full text-[10px]',
                isToday ? 'bg-white/20 font-semibold text-white' : 'text-white/65',
              )}>
                {day}
              </span>
              <span className="flex gap-[2px]">
                <span className={cn('size-[3px] rounded-full', hasHoliday ? 'bg-brand' : 'bg-transparent')} />
                <span className={cn('size-[3px] rounded-full', hasEvent ? 'bg-white/70' : 'bg-transparent')} />
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

type UpcomingRow =
  | { kind: 'holiday'; key: string; label: string; dateIso: string }
  | { kind: 'event'; key: string; label: string; dateIso: string; sublabel: string }

function upcomingDateIso(e: CalendarEventItem): string {
  const d = new Date(e.startsAt)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function IslandPageCalendar() {
  const { items, holidays, eventDates, upcomingEvents } = useTodayItems()
  const holidayDates = new Set(holidays.map((h) => h.date))

  // The holidays API can return the same holiday under multiple types; dedupe by
  // (date, label) so the merged column never repeats a row.
  const seen = new Set<string>()
  const upcoming: UpcomingRow[] = [
    ...holidays
      .filter((h) => h.date > todayIso())
      .map((h): UpcomingRow => ({ kind: 'holiday', key: `hol-${h.date}-${h.name}`, label: h.name, dateIso: h.date })),
    ...upcomingEvents
      .map((e): UpcomingRow => ({
        kind: 'event', key: `cal-${e.id}`, label: e.summary ?? 'Event',
        dateIso: upcomingDateIso(e), sublabel: `${formatEventTime(e)} · ${e.member}`,
      })),
  ]
    .filter((u) => { const k = `${u.dateIso}|${u.label}`; if (seen.has(k)) return false; seen.add(k); return true })
    .sort((a, b) => a.dateIso.localeCompare(b.dateIso))
    .slice(0, 5)

  return (
    <div className="grid h-full grid-cols-[1.2fr_1fr_1fr] gap-3">
      <MonthGrid holidayDates={holidayDates} eventDates={eventDates} />

      <div className="min-w-0">
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-sm font-semibold text-white/85">Today</span>
          <span className="text-[10px] text-white/40">{items.length} item{items.length === 1 ? '' : 's'}</span>
        </div>
        {items.length === 0 ? (
          <p className="text-xs text-white/40">Nothing scheduled</p>
        ) : (
          <div className="space-y-1.5">
            {items.slice(0, 6).map((it) => (
              <div key={it.key} className={cn('flex items-center gap-1.5 border-l-2 pl-2', it.kind === 'nearby' ? 'border-white/25' : 'border-brand/70')}>
                <span className="min-w-0 flex-1 truncate text-xs text-white/80">{it.label}</span>
                {it.kind === 'nearby' && (
                  // design-ok(glass-on-plain-bg): source chip inside the black island surface
                  <span className="shrink-0 rounded-full bg-white/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-white/45">Nearby</span>
                )}
                {it.sublabel && <span className="shrink-0 text-[10px] text-white/40">{it.sublabel}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="min-w-0">
        <div className="mb-1 text-sm font-semibold text-white/85">Upcoming</div>
        {upcoming.length === 0 ? (
          <p className="text-xs text-white/40">Nothing upcoming</p>
        ) : (
          <div className="space-y-1.5">
            {upcoming.map((u) => (
              <div key={u.key} className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-xs text-white/80">{u.label}</span>
                {u.kind === 'event' && (
                  <span className="shrink-0 text-[10px] text-white/40">{u.sublabel}</span>
                )}
                {/* design-ok(glass-on-plain-bg): days pill inside the black island surface */}
                <span className="shrink-0 rounded-full bg-white/10 px-1.5 py-0.5 text-[9px] text-white/60">
                  {diffDays(u.dateIso) === 0 ? 'Today' : diffDays(u.dateIso) === 1 ? 'Tomorrow' : formatMonDay(u.dateIso)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
