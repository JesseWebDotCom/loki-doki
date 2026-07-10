import { useEffect, useState } from 'react'
import { AlarmClock, PartyPopper, MapPin, Timer } from 'lucide-react'
import { useTimeApp } from '@/context/TimeAlarmContext'
import { formatCountdown } from '@/lib/time/format'

// "Today" data for the island's Home and Calendar pages: holidays (whole-year
// fetch, module-cached, filtered client-side), local events, running timers and
// today's enabled alarms (both free from the already-polled time context).

export interface HolidayItem {
  date: string // YYYY-MM-DD
  name: string
}

export interface TodayItem {
  key: string
  icon: typeof Timer
  label: string
  sublabel?: string
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

export function useTodayItems(): { items: TodayItem[]; holidays: HolidayItem[] } {
  const { running, alarms } = useTimeApp()
  const [holidays, setHolidays] = useState<HolidayItem[]>([])
  const [localEvents, setLocalEvents] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    void fetchHolidays(new Date().getFullYear()).then((h) => { if (!cancelled) setHolidays(h) })
    fetch('/api/local-events', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { events: [] }))
      .then((d: { events?: { text: string }[] }) => {
        if (!cancelled) setLocalEvents((d.events ?? []).slice(0, 3).map((e) => e.text))
      })
      .catch(() => { /* offline */ })
    return () => { cancelled = true }
  }, [])

  const iso = todayIso()
  const weekday = new Date().getDay()

  const items: TodayItem[] = [
    ...holidays.filter((h) => h.date === iso).map((h) => ({
      key: `hol-${h.date}-${h.name}`, icon: PartyPopper, label: h.name, sublabel: 'Holiday',
    })),
    ...running.map((t) => ({
      key: `timer-${t.id}`, icon: Timer,
      label: t.label || 'Timer',
      sublabel: t.paused ? 'Paused' : `${formatCountdown(Math.max(0, t.endsAt - Date.now()))} left`,
    })),
    ...alarms
      .filter((a) => a.enabled && (a.repeatDays.length === 0 || a.repeatDays.includes(weekday)))
      .map((a) => ({
        key: `alarm-${a.id}`, icon: AlarmClock,
        label: a.label || 'Alarm',
        sublabel: `${String(a.hour).padStart(2, '0')}:${String(a.minute).padStart(2, '0')}`,
      })),
    ...localEvents.map((text, i) => ({ key: `evt-${i}`, icon: MapPin, label: text })),
  ]

  return { items, holidays }
}
