import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, ListTodo, MapPin, Settings2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { PageContainer } from '@/components/shared/PageContainer'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'
import { useAuth } from '@/context/AuthContext'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { listICloudEvents, listICloudBirthdays, type ICloudBirthday, type ICloudEvent } from '@/lib/icloud/api'

// The household Calendar app: the family's synced iCloud calendars merged into one
// month/week/day view with per-member color accents. Read-only in Phase 1 (event
// creation arrives with iCloud Phase 2); data comes from the local sync window
// (7 days back, 60 ahead), so far-future months are honestly empty rather than
// silently fetched.

type ViewKey = 'month' | 'week' | 'day'

const DAY_MS = 86_400_000
const FALLBACK_COLOR = 'var(--muted-foreground)'

function startOfDay(d: Date): Date { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
function startOfWeek(d: Date): Date { const x = startOfDay(d); x.setDate(x.getDate() - x.getDay()); return x }
function startOfMonth(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), 1) }
function localKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function sameDay(a: Date, b: Date): boolean { return localKey(a) === localKey(b) }

// design-ok(hex-in-tsx): member colors on this page come from iCloud calendar data
// (hex strings); birthdays need one fixed accent from the same species.
const BIRTHDAY_COLOR = '#f472b6'

/** Birthdays render as all-day pseudo-events so every view handles them for free. */
function birthdayAsEvent(b: ICloudBirthday): ICloudEvent {
  const start = new Date(`${b.date}T00:00:00`)
  return {
    id: `bday-${b.date}-${b.contactName}`,
    summary: `${b.contactName}'s birthday${b.turnsAge ? ` (${b.turnsAge})` : ''}`,
    location: null,
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + DAY_MS).toISOString(),
    allDay: true,
    userId: '',
    member: b.member,
    colorHex: BIRTHDAY_COLOR,
    calendarName: 'Birthdays',
  }
}

interface DayEvents { date: Date; events: ICloudEvent[] }

function eventsByDay(events: ICloudEvent[], from: Date, days: number): DayEvents[] {
  const buckets = new Map<string, ICloudEvent[]>()
  for (const e of events) {
    const start = new Date(e.startsAt)
    const end = new Date(e.endsAt)
    // Multi-day events land in every day they touch inside the range.
    for (let d = startOfDay(start); d < end; d = new Date(d.getTime() + DAY_MS)) {
      const key = localKey(d)
      const list = buckets.get(key) ?? []
      list.push(e)
      buckets.set(key, list)
    }
  }
  return Array.from({ length: days }, (_, i) => {
    const date = new Date(from.getTime() + i * DAY_MS)
    const list = (buckets.get(localKey(date)) ?? [])
      .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startsAt.localeCompare(b.startsAt))
    return { date, events: list }
  })
}

function timeLabel(e: ICloudEvent): string {
  if (e.allDay) return 'All day'
  return new Date(e.startsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function MemberLegend({ events }: { events: ICloudEvent[] }) {
  const members = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of events) if (!m.has(e.member)) m.set(e.member, e.colorHex ?? FALLBACK_COLOR)
    return [...m.entries()]
  }, [events])
  if (members.length < 2) return null
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      {members.map(([name, color]) => (
        <span key={name} className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ backgroundColor: color }} />
          {name}
        </span>
      ))}
    </div>
  )
}

function EventRow({ event, expanded, onToggle }: { event: ICloudEvent; expanded: boolean; onToggle: () => void }) {
  return (
    // design-ok(hand-styled-button): full-width tappable agenda row with a member color rail, not a Button variant
    <button onClick={onToggle}
      className="w-full rounded-control border-l-2 py-1.5 pl-3 pr-2 text-left transition-colors hover:bg-foreground/5"
      style={{ borderLeftColor: event.colorHex ?? FALLBACK_COLOR }}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/90">
          {event.summary ?? 'Event'}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{timeLabel(event)}</span>
      </div>
      <div className="text-xs text-muted-foreground">{event.member}</div>
      {expanded && (
        <div className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
          {!event.allDay && (
            <div>
              {new Date(event.startsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
              {' to '}
              {new Date(event.endsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
            </div>
          )}
          {event.location && (
            <div className="flex items-center gap-1"><MapPin className="size-3" />{event.location}</div>
          )}
          <div>{event.calendarName} calendar</div>
        </div>
      )}
    </button>
  )
}

function DayAgenda({ day, emptyText }: { day: DayEvents; emptyText: string }) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  if (day.events.length === 0) return <p className="py-2 text-sm text-muted-foreground">{emptyText}</p>
  return (
    <div className="space-y-1">
      {day.events.map((e) => (
        <EventRow key={e.id} event={e} expanded={expandedId === e.id}
          onToggle={() => setExpandedId(expandedId === e.id ? null : e.id)} />
      ))}
    </div>
  )
}

function MonthView({ anchor, events, selected, onSelect }: {
  anchor: Date
  events: ICloudEvent[]
  selected: Date
  onSelect: (d: Date) => void
}) {
  const monthStart = startOfMonth(anchor)
  const gridStart = startOfWeek(monthStart)
  const days = eventsByDay(events, gridStart, 42)
  const today = new Date()

  const selectedDay = days.find((d) => sameDay(d.date, selected))
    ?? { date: selected, events: [] }

  return (
    <div className="space-y-5">
      <div>
        <div className="grid grid-cols-7 text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <span key={d} className="py-1">{d}</span>)}
        </div>
        <div className="grid grid-cols-7">
          {days.map(({ date, events: dayEvents }) => {
            const inMonth = date.getMonth() === anchor.getMonth()
            const isToday = sameDay(date, today)
            const isSelected = sameDay(date, selected)
            return (
              // design-ok(hand-styled-button): month grid day cell, same treatment as the Time app's tab pills
              <button key={date.getTime()} onClick={() => onSelect(date)}
                className={cn(
                  'flex min-h-[72px] flex-col items-stretch gap-1 border-t border-border/30 p-1.5 text-left transition-colors sm:min-h-[84px]',
                  !inMonth && 'opacity-40',
                  isSelected ? 'bg-foreground/8' : 'hover:bg-foreground/4',
                )}>
                <span className={cn(
                  'self-start rounded-full px-1.5 text-xs tabular-nums leading-5',
                  isToday ? 'bg-brand font-bold text-brand-foreground' : 'text-foreground/70',
                )}>
                  {date.getDate()}
                </span>
                <span className="hidden flex-col gap-0.5 sm:flex">
                  {dayEvents.slice(0, 3).map((e) => (
                    <span key={e.id} className="flex items-center gap-1 truncate text-[11px] leading-4 text-foreground/80">
                      <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: e.colorHex ?? FALLBACK_COLOR }} />
                      <span className="truncate">{e.summary ?? 'Event'}</span>
                    </span>
                  ))}
                  {dayEvents.length > 3 && (
                    <span className="text-[10px] text-muted-foreground">+{dayEvents.length - 3} more</span>
                  )}
                </span>
                <span className="flex gap-0.5 sm:hidden">
                  {dayEvents.slice(0, 4).map((e) => (
                    <span key={e.id} className="size-1.5 rounded-full" style={{ backgroundColor: e.colorHex ?? FALLBACK_COLOR }} />
                  ))}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div>
        <h3 className="mb-1 text-sm font-semibold text-foreground/85">
          {selectedDay.date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
        </h3>
        <DayAgenda day={selectedDay} emptyText="Nothing scheduled." />
      </div>
    </div>
  )
}

function WeekView({ anchor, events }: { anchor: Date; events: ICloudEvent[] }) {
  const weekStart = startOfWeek(anchor)
  const days = eventsByDay(events, weekStart, 7)
  const today = new Date()
  return (
    <div className="space-y-4">
      {days.map((day) => (
        <div key={day.date.getTime()}>
          <h3 className={cn('mb-1 text-sm font-semibold',
            sameDay(day.date, today) ? 'text-brand' : 'text-foreground/85')}>
            {day.date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
          </h3>
          <DayAgenda day={day} emptyText="Nothing scheduled." />
        </div>
      ))}
    </div>
  )
}

export function CalendarPage() {
  useAppHeader({ query: '', setQuery: () => {}, searchable: false })
  const { user } = useAuth()
  const [view, setView] = useState<ViewKey>('month')
  const [anchor, setAnchor] = useState(() => new Date())
  const [selected, setSelected] = useState(() => new Date())
  const [events, setEvents] = useState<ICloudEvent[] | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'disabled' | 'error'>('loading')

  // One fetch covers all three views: the visible month grid padded a week each side.
  const range = useMemo(() => {
    const gridStart = startOfWeek(startOfMonth(anchor))
    const from = gridStart.getTime() - 7 * DAY_MS
    return { from, to: gridStart.getTime() + (42 + 7) * DAY_MS }
  }, [anchor])

  useEffect(() => {
    let cancelled = false
    setState((s) => (s === 'ready' ? s : 'loading'))
    Promise.all([
      listICloudEvents(range.from, range.to),
      listICloudBirthdays(range.from, range.to).catch(() => [] as ICloudBirthday[]),
    ])
      .then(([evts, birthdays]) => {
        if (cancelled) return
        setEvents([...evts, ...birthdays.map(birthdayAsEvent)])
        setState('ready')
      })
      .catch((e) => {
        if (cancelled) return
        setState(e instanceof Error && e.message === 'feature_disabled' ? 'disabled' : 'error')
      })
    return () => { cancelled = true }
  }, [range])

  function shift(dir: -1 | 1) {
    const next = new Date(anchor)
    if (view === 'month') next.setMonth(next.getMonth() + dir)
    else if (view === 'week') next.setDate(next.getDate() + 7 * dir)
    else next.setDate(next.getDate() + dir)
    setAnchor(next)
    setSelected(next)
  }

  const title = view === 'month'
    ? anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    : view === 'week'
      ? `Week of ${startOfWeek(anchor).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
      : anchor.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

  const dayEvents = events ? eventsByDay(events, startOfDay(anchor), 1)[0]! : null

  return (
    <PageShell>
      <PageContainer width="narrow" className="py-2 pb-8">
        <PageHeader subtitle="The family's iCloud calendars, together." />

        {state === 'disabled' ? (
          <div className="rounded-card border border-border/40 p-6 text-sm text-muted-foreground">
            <p className="mb-2 font-medium text-foreground/85">iCloud Calendar is turned off.</p>
            <p>
              {user?.role === 'admin'
                ? <>Turn it on in <Link to="/admin/features" className="underline underline-offset-2">Admin → Features</Link> and connect Apple Accounts under Integrations → Apple iCloud.</>
                : 'Ask a household admin to turn on iCloud Calendar in Admin.'}
            </p>
          </div>
        ) : state === 'error' ? (
          <p className="py-8 text-sm text-muted-foreground">Could not load the calendar. Try again in a moment.</p>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex rounded-full bg-foreground/8 p-1">
                {(['month', 'week', 'day'] as const).map((key) => (
                  // design-ok(hand-styled-button): segmented view switcher, mirrors TimePage's tab pills
                  <button key={key} onClick={() => setView(key)}
                    className={cn('rounded-full px-3 py-1.5 text-sm font-semibold capitalize transition-colors',
                      view === key ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                    {key}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" onClick={() => shift(-1)} aria-label="Previous"><ChevronLeft className="size-4" /></Button>
                <Button variant="ghost" size="sm" onClick={() => { const now = new Date(); setAnchor(now); setSelected(now) }}>Today</Button>
                <Button variant="ghost" size="icon" onClick={() => shift(1)} aria-label="Next"><ChevronRight className="size-4" /></Button>
              </div>
            </div>

            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">{title}</h2>
              {events && <MemberLegend events={events} />}
            </div>

            {state === 'loading' || !events ? (
              <div className="flex justify-center py-16"><Spinner /></div>
            ) : events.length === 0 ? (
              <div className="rounded-card border border-border/40 p-6 text-sm text-muted-foreground">
                <p className="mb-1 flex items-center gap-2 font-medium text-foreground/85">
                  <CalendarDays className="size-4" />No events synced yet
                </p>
                <p>
                  {user?.role === 'admin'
                    ? <>Connect family Apple Accounts under <Link to="/admin/integrations/apple-icloud" className="underline underline-offset-2">Integrations → Apple iCloud</Link>. Events sync 7 days back and 60 days ahead.</>
                    : 'Once Apple Accounts are connected, family events show up here.'}
                </p>
              </div>
            ) : view === 'month' ? (
              <MonthView anchor={anchor} events={events} selected={selected}
                onSelect={(d) => { setSelected(d); setAnchor(d) }} />
            ) : view === 'week' ? (
              <WeekView anchor={anchor} events={events} />
            ) : dayEvents ? (
              <DayAgenda day={dayEvents} emptyText="Nothing scheduled today." />
            ) : null}

            <p className="mt-8 flex items-center gap-1.5 text-xs text-muted-foreground/70">
              <ListTodo className="size-3.5" />
              Read-only for now: events created on iPhones appear here within about five minutes.
              {user?.role === 'admin' && (
                <Link to="/admin/integrations/apple-icloud" className="ml-1 inline-flex items-center gap-1 underline underline-offset-2">
                  <Settings2 className="size-3" />Manage
                </Link>
              )}
            </p>
          </>
        )}
      </PageContainer>
    </PageShell>
  )
}
