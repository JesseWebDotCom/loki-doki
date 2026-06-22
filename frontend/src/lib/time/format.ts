// Formatting helpers for the Time app (world clock, timers, stopwatch).

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function pad(n: number, w = 2): string { return String(n).padStart(w, '0') }

/** YYYY-MM-DD as seen in a given IANA zone (local zone when tz omitted). */
function ymdInZone(d: Date, tz?: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

export interface ZoneParts {
  time: string        // "9:41"
  ampm: string        // "AM" | "PM"
  offset: string      // "GMT-5"
  dayLabel: string    // "" | "Tomorrow" | "Yesterday"
}

export function zoneParts(now: Date, tz: string): ZoneParts {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const time = `${get('hour')}:${get('minute')}`
  const ampm = get('dayPeriod')
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
    .formatToParts(now).find((p) => p.type === 'timeZoneName')?.value ?? ''

  const diff = (Date.parse(ymdInZone(now, tz)) - Date.parse(ymdInZone(now))) / 86_400_000
  const dayLabel = diff >= 1 ? 'Tomorrow' : diff <= -1 ? 'Yesterday' : ''
  return { time, ampm, offset, dayLabel }
}

/** Stopwatch display: mm:ss.cc (or h:mm:ss.cc past an hour). */
export function formatStopwatch(ms: number): string {
  const cs = Math.floor((ms % 1000) / 10)
  const totalSec = Math.floor(ms / 1000)
  const s = totalSec % 60
  const m = Math.floor(totalSec / 60) % 60
  const h = Math.floor(totalSec / 3600)
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}.${pad(cs)}` : `${pad(m)}:${pad(s)}.${pad(cs)}`
}

/** Countdown display: h:mm:ss (or mm:ss under an hour). */
export function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000))
  const s = totalSec % 60
  const m = Math.floor(totalSec / 60) % 60
  const h = Math.floor(totalSec / 3600)
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** Human label for a duration in seconds: "25 min", "1h 30m", "45s". */
export function formatDurationLabel(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const out: string[] = []
  if (h) out.push(`${h}h`)
  if (m) out.push(`${m}m`)
  if (s && !h) out.push(`${s}s`)
  return out.join(' ') || '0s'
}

export function splitDuration(sec: number): { h: number; m: number; s: number } {
  return { h: Math.floor(sec / 3600), m: Math.floor((sec % 3600) / 60), s: sec % 60 }
}

/** Summary of an alarm's repeat days. */
export function repeatLabel(days: number[]): string {
  if (days.length === 0) return 'Once'
  if (days.length === 7) return 'Every day'
  const set = new Set(days)
  const weekdays = [1, 2, 3, 4, 5]
  const weekend = [0, 6]
  if (weekdays.every((d) => set.has(d)) && days.length === 5) return 'Weekdays'
  if (weekend.every((d) => set.has(d)) && days.length === 2) return 'Weekends'
  return [...days].sort((a, b) => a - b).map((d) => WEEKDAYS[d]).join(', ')
}

export { WEEKDAYS }
