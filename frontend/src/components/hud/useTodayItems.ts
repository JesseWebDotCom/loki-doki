import { useCallback, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlarmClock, CalendarDays, PartyPopper, MapPin, Timer } from 'lucide-react'
import { useTimeApp } from '@/context/TimeAlarmContext'
import { useAuth } from '@/context/AuthContext'
import { useUserPreferences, patchUserPreferencesCache } from '@/hooks/useUserPreferences'
import { formatCountdown } from '@/lib/time/format'

// "Today" data for the island's Home and Calendar pages: holidays (whole-year
// fetch, module-cached, filtered client-side), nearby community events, running
// timers and today's enabled alarms (both free from the already-polled time
// context). Nearby events are third-party listings (Patch/web), NOT the user's
// own schedule, so items carry a kind and the island labels them "Nearby".

export interface HolidayItem {
  date: string // YYYY-MM-DD
  name: string
}

export interface TodayItem {
  key: string
  icon: typeof Timer
  label: string
  sublabel?: string
  /** 'own' = the user's schedule (alarms, timers, holidays); 'nearby' = scraped town listings. */
  kind: 'own' | 'nearby'
}

// Per-user toggle for the scraped town listings on the island (Settings page).
// Absent means on; the island hides them while preferences are still loading so
// a switched-off feed never flashes in.
export const NEARBY_EVENTS_PREF_KEY = 'island.showNearbyEvents'

export function useNearbyEventsPref() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const prefsQuery = useUserPreferences()
  const loading = prefsQuery.data === undefined && !prefsQuery.isError
  const show = !loading && (prefsQuery.data ?? {})[NEARBY_EVENTS_PREF_KEY] !== false

  const setShow = useCallback((next: boolean) => {
    const userId = user?.id
    if (!userId) return
    patchUserPreferencesCache(queryClient, userId, { [NEARBY_EVENTS_PREF_KEY]: next })
    void fetch(`/api/users/${userId}/preferences`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [NEARBY_EVENTS_PREF_KEY]: next }),
    })
  }, [user?.id, queryClient])

  return { show, setShow, loading }
}

let holidaysCache: { year: number; holidays: HolidayItem[] } | null = null
let holidaysInflight: Promise<HolidayItem[]> | null = null

function fetchHolidays(year: number): Promise<HolidayItem[]> {
  if (holidaysCache?.year === year) return Promise.resolve(holidaysCache.holidays)
  holidaysInflight ??= fetch(`/api/holidays?country=US&year=${year}`, { credentials: 'include' })
    .then((r) => (r.ok ? r.json() : { holidays: [] }))
    .then((d: { holidays?: { date: string; localName?: string; name?: string }[] }) => {
      const holidays = (d.holidays ?? []).map((h) => ({ date: h.date, name: h.localName || h.name || 'Holiday' }))
      holidaysCache = { year, holidays }
      return holidays
    })
    .catch(() => [] as HolidayItem[])
    .finally(() => { holidaysInflight = null })
  return holidaysInflight
}

export function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function parseLocalDate(iso: string): Date {
  const [y, m, day] = iso.split('-').map(Number)
  return new Date(y!, (m ?? 1) - 1, day ?? 1)
}

export function formatMonDay(iso: string): string {
  return parseLocalDate(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function diffDays(iso: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((parseLocalDate(iso).getTime() - today.getTime()) / 86_400_000)
}

// One synced-calendar occurrence (household view; iCloud plan M3). Times are epoch ms.
export interface CalendarEventItem {
  id: string
  summary: string | null
  startsAt: number
  endsAt: number
  allDay: boolean
  member: string
  colorHex: string | null
}

function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function formatEventTime(e: CalendarEventItem): string {
  return e.allDay ? 'All day' : new Date(e.startsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function useTodayItems(): {
  items: TodayItem[]
  holidays: HolidayItem[]
  eventDates: Set<string>
  upcomingEvents: CalendarEventItem[]
} {
  const { running, alarms } = useTimeApp()
  const { show: showNearby } = useNearbyEventsPref()
  const [holidays, setHolidays] = useState<HolidayItem[]>([])
  const [localEvents, setLocalEvents] = useState<{ title: string; detail?: string }[]>([])
  const [calEvents, setCalEvents] = useState<CalendarEventItem[]>([])

  useEffect(() => {
    let cancelled = false
    void fetchHolidays(new Date().getFullYear()).then((h) => { if (!cancelled) setHolidays(h) })
    return () => { cancelled = true }
  }, [])

  // Synced family calendar: whole current month (grid dots) extended a week past
  // today (Upcoming column). 403 (feature off) or offline quietly yields nothing.
  useEffect(() => {
    let cancelled = false
    const now = new Date()
    const from = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    const to = Math.max(new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime(), now.getTime() + 7 * 86_400_000)
    fetch(`/api/icloud/calendar/events?from=${from}&to=${to}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { events: [] }))
      .then((d: { events?: (Omit<CalendarEventItem, 'startsAt' | 'endsAt'> & { startsAt: string; endsAt: string })[] }) => {
        if (cancelled) return
        setCalEvents((d.events ?? []).map((e) => ({
          ...e, startsAt: new Date(e.startsAt).getTime(), endsAt: new Date(e.endsAt).getTime(),
        })))
      })
      .catch(() => { /* offline or gated off */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!showNearby) { setLocalEvents([]); return }
    let cancelled = false
    fetch('/api/local-events', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { events: [] }))
      .then((d: { events?: { text: string; title?: string; detail?: string }[] }) => {
        if (cancelled) return
        setLocalEvents((d.events ?? []).slice(0, 3).map((e) => ({ title: e.title ?? e.text, ...(e.detail ? { detail: e.detail } : {}) })))
      })
      .catch(() => { /* offline */ })
    return () => { cancelled = true }
  }, [showNearby])

  const iso = todayIso()
  const weekday = new Date().getDay()
  const todayEnd = new Date(new Date().setHours(23, 59, 59, 999)).getTime()
  const todaysEvents = calEvents.filter((e) => localIso(new Date(e.startsAt)) === iso || (e.startsAt < Date.now() && e.endsAt > Date.now()))

  const items: TodayItem[] = [
    ...holidays.filter((h) => h.date === iso).map((h) => ({
      key: `hol-${h.date}-${h.name}`, icon: PartyPopper, label: h.name, sublabel: 'Holiday', kind: 'own' as const,
    })),
    ...todaysEvents.map((e) => ({
      key: `cal-${e.id}`, icon: CalendarDays,
      label: e.summary ?? 'Event',
      sublabel: `${formatEventTime(e)} · ${e.member}`,
      kind: 'own' as const,
    })),
    ...running.map((t) => ({
      key: `timer-${t.id}`, icon: Timer,
      label: t.label || 'Timer',
      sublabel: t.paused ? 'Paused' : `${formatCountdown(Math.max(0, t.endsAt - Date.now()))} left`,
      kind: 'own' as const,
    })),
    ...alarms
      .filter((a) => a.enabled && (a.repeatDays.length === 0 || a.repeatDays.includes(weekday)))
      .map((a) => ({
        key: `alarm-${a.id}`, icon: AlarmClock,
        label: a.label || 'Alarm',
        sublabel: `${String(a.hour).padStart(2, '0')}:${String(a.minute).padStart(2, '0')}`,
        kind: 'own' as const,
      })),
    ...localEvents.map((e, i) => ({
      key: `evt-${i}`, icon: MapPin, label: e.title, ...(e.detail ? { sublabel: e.detail } : {}), kind: 'nearby' as const,
    })),
  ]

  const eventDates = new Set(calEvents.map((e) => localIso(new Date(e.startsAt))))
  const upcomingEvents = calEvents
    .filter((e) => e.startsAt > todayEnd)
    .slice(0, 8)

  return { items, holidays, eventDates, upcomingEvents }
}
