// The household rundown: today's and tomorrow's calendar events as a two-column
// broadcast schedule, with member names, times, and calendar colors.

import { useQuery } from '@tanstack/react-query'
import { CalendarDays } from 'lucide-react'
import type { TvScreenProps } from './index'
import { ScreenFrame, StatusPanel, clockLabel, getJson, isFeatureOff, retryUnlessOff, toMs, useTick } from './shared'

interface CalendarEvent {
  id: string
  summary: string | null
  location: string | null
  startsAt: number | string
  endsAt: number | string
  allDay: boolean
  member: string
  colorHex: string | null
  calendarName: string
}

interface EventsResponse { events: CalendarEvent[] }

function EventRow({ ev }: { ev: CalendarEvent }) {
  const start = toMs(ev.startsAt)
  return (
    <div className="flex items-center gap-4 border-b border-border/40 py-4 last:border-b-0">
      <span
        aria-hidden
        className="size-3 shrink-0 rounded-full"
        style={ev.colorHex ? { backgroundColor: ev.colorHex } : undefined}
      />
      <span className="w-28 shrink-0 text-lg font-semibold tabular-nums text-muted-foreground">
        {ev.allDay || start == null ? 'All day' : clockLabel(start)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xl font-semibold">{ev.summary ?? 'Busy'}</p>
        <p className="truncate text-base text-muted-foreground">
          {ev.member}
          <span className="mx-2">|</span>
          {ev.calendarName}
          {ev.location ? <span className="ml-2 hidden xl:inline">at {ev.location}</span> : null}
        </p>
      </div>
    </div>
  )
}

function DayColumn({ heading, dateMs, events }: { heading: string; dateMs: number; events: CalendarEvent[] }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-sheet border border-border/50 bg-card/40 px-7 py-6">
      <div className="flex items-baseline gap-3 border-b border-border/60 pb-4">
        <span className="text-2xl font-bold tracking-tight">{heading}</span>
        <span className="text-lg text-muted-foreground">
          {new Date(dateMs).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {events.length === 0 ? (
          <p className="pt-8 text-xl text-muted-foreground">Nothing scheduled</p>
        ) : (
          events.slice(0, 8).map((ev) => <EventRow key={ev.id} ev={ev} />)
        )}
      </div>
    </div>
  )
}

export function CalendarScreen({ channel, title, subtitle }: TvScreenProps) {
  const now = useTick(60_000)
  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)
  const from = dayStart.getTime()
  const tomorrowStart = from + 86_400_000
  const to = from + 2 * 86_400_000

  const events = useQuery({
    queryKey: ['dokitv', 'calendar', from],
    queryFn: () => getJson<EventsResponse>(`/api/icloud/calendar/events?from=${from}&to=${to}`),
    refetchInterval: 5 * 60_000,
    retry: retryUnlessOff,
  })

  if (events.isError && isFeatureOff(events.error)) {
    return (
      <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel channel={channel} icon={CalendarDays} headline="Calendar is not connected" note="An admin can connect iCloud calendars to put the family schedule on air" />
      </ScreenFrame>
    )
  }
  if (events.isError) {
    return (
      <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel channel={channel} icon={CalendarDays} headline="The schedule is unavailable" note="We could not load calendar events" />
      </ScreenFrame>
    )
  }
  if (events.isPending) {
    return (
      <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel channel={channel} icon={CalendarDays} headline="Loading the rundown" note="Waiting for data" />
      </ScreenFrame>
    )
  }

  const all = events.data.events
  const today = all.filter((ev) => (toMs(ev.startsAt) ?? 0) < tomorrowStart)
  const tomorrow = all.filter((ev) => (toMs(ev.startsAt) ?? 0) >= tomorrowStart)

  return (
    <ScreenFrame
      channel={channel}
      title={title}
      subtitle={subtitle}
      right={<span className="text-lg font-semibold tabular-nums text-muted-foreground">{clockLabel(now)}</span>}
    >
      <div className="flex h-full flex-col gap-6 xl:flex-row">
        <DayColumn heading="Today" dateMs={from} events={today} />
        <DayColumn heading="Tomorrow" dateMs={tomorrowStart} events={tomorrow} />
      </div>
    </ScreenFrame>
  )
}
