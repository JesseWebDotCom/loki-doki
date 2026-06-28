// Ambient "home screen" display config for screen devices (Tab5, Show, tablet
// Pods). The /display route renders this full-screen; Admin → Devices → "Home
// screen" customizes it. Persisted per-user via the standard preferences API so a
// device inherits whatever its bound user configured — no new backend surface.

export type ClockStyle = 'digital' | 'flip'

export interface HomeDisplayConfig {
  /** Show the big clock in the center. */
  clock: boolean
  /** 'digital' = clean LCD numerals · 'flip' = split-flap flip-clock cards. */
  clockStyle: ClockStyle
  /** Tick a seconds field alongside hours:minutes. */
  showSeconds: boolean
  /** 24-hour time (hides AM/PM). */
  hour24: boolean
  /** Show the weekday + date under the clock. */
  date: boolean
  /** Animated weather icon + temperature, upper-right (mirrors the home header). */
  weather: boolean
  /** Animated weather background (rain/snow/stars/sun — same engine as home). */
  weatherBackground: boolean
}

export const DEFAULT_HOME_DISPLAY: HomeDisplayConfig = {
  clock: true,
  clockStyle: 'digital',
  showSeconds: false,
  hour24: false,
  date: true,
  weather: true,
  weatherBackground: true,
}

export const HOME_DISPLAY_PREF_KEY = 'home.display'

/** Coerce arbitrary stored JSON back into a valid config (forward/backward safe). */
export function sanitizeHomeDisplay(raw: unknown): HomeDisplayConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
  return {
    clock: bool(r.clock, DEFAULT_HOME_DISPLAY.clock),
    clockStyle: r.clockStyle === 'flip' ? 'flip' : 'digital',
    showSeconds: bool(r.showSeconds, DEFAULT_HOME_DISPLAY.showSeconds),
    hour24: bool(r.hour24, DEFAULT_HOME_DISPLAY.hour24),
    date: bool(r.date, DEFAULT_HOME_DISPLAY.date),
    weather: bool(r.weather, DEFAULT_HOME_DISPLAY.weather),
    weatherBackground: bool(r.weatherBackground, DEFAULT_HOME_DISPLAY.weatherBackground),
  }
}

export async function loadHomeDisplay(userId: string): Promise<HomeDisplayConfig> {
  try {
    const r = await fetch(`/api/users/${userId}/preferences`, { credentials: 'include' })
    if (!r.ok) return DEFAULT_HOME_DISPLAY
    const data = (await r.json()) as Record<string, unknown>
    return sanitizeHomeDisplay(data[HOME_DISPLAY_PREF_KEY])
  } catch {
    return DEFAULT_HOME_DISPLAY
  }
}

export async function saveHomeDisplay(userId: string, cfg: HomeDisplayConfig): Promise<void> {
  await fetch(`/api/users/${userId}/preferences`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [HOME_DISPLAY_PREF_KEY]: cfg }),
  })
}

/** Split a Date into the display fields the clock components need. */
export function clockParts(d: Date, cfg: Pick<HomeDisplayConfig, 'hour24'>) {
  let h = d.getHours()
  const ampm = h >= 12 ? 'PM' : 'AM'
  if (!cfg.hour24) {
    h = h % 12
    if (h === 0) h = 12
  }
  return {
    hh: String(h).padStart(2, '0'),
    mm: String(d.getMinutes()).padStart(2, '0'),
    ss: String(d.getSeconds()).padStart(2, '0'),
    ampm: cfg.hour24 ? '' : ampm,
  }
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export function dateLabel(d: Date): string {
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`
}
