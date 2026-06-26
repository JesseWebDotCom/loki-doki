// Shared weather primitives — WMO code → icon/description/gradient mapping plus
// a small fetch helper with a cross-route cache. Used by the full Weather page
// and the live weather card on the Home screen so the two never drift.

// ─── Types ────────────────────────────────────────────────────────────────────

export type HeroGradient =
  | 'clear-day' | 'clear-night' | 'partly-cloudy' | 'cloudy'
  | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm'

export interface WmoInfo { icon: string; desc: string; gradient: HeroGradient }
export interface WmoInfoResolved extends WmoInfo { live?: boolean }

export interface NWSObservation {
  textDescription: string
  precipitation: number | null  // mm last hour
  timestamp: string | null
}

export interface WeatherData {
  location: string
  temperature_unit: 'fahrenheit' | 'celsius'
  observation?: NWSObservation
  weather: {
    current: {
      temperature_2m: number
      apparent_temperature: number
      relative_humidity_2m: number
      precipitation: number
      weather_code: number
      wind_speed_10m: number
      wind_direction_10m: number
      uv_index: number
      visibility: number
      is_day: number
    }
    hourly: {
      time: string[]
      temperature_2m: number[]
      weather_code: number[]
      precipitation_probability: number[]
      wind_speed_10m: number[]
      uv_index: number[]
      is_day: number[]
    }
    daily: {
      time: string[]
      temperature_2m_max: number[]
      temperature_2m_min: number[]
      precipitation_sum: number[]
      weather_code: number[]
      precipitation_probability_max: number[]
      sunrise: string[]
      sunset: string[]
    }
    timezone: string
    timezone_abbreviation: string
  }
}

// ─── WMO codes ────────────────────────────────────────────────────────────────

export const WMO_TABLE: Record<number, WmoInfo> = {
  0:  { icon: 'day',          desc: 'Clear sky',             gradient: 'clear-day'    },
  1:  { icon: 'day',          desc: 'Mainly clear',          gradient: 'clear-day'    },
  2:  { icon: 'cloudy-day-1', desc: 'Partly cloudy',         gradient: 'partly-cloudy'},
  3:  { icon: 'cloudy',       desc: 'Overcast',              gradient: 'cloudy'       },
  45: { icon: 'cloudy',       desc: 'Fog',                   gradient: 'fog'          },
  48: { icon: 'cloudy',       desc: 'Icy fog',               gradient: 'fog'          },
  51: { icon: 'rainy-1',      desc: 'Light drizzle',         gradient: 'drizzle'      },
  53: { icon: 'rainy-2',      desc: 'Drizzle',               gradient: 'drizzle'      },
  55: { icon: 'rainy-3',      desc: 'Heavy drizzle',         gradient: 'rain'         },
  56: { icon: 'rainy-4',      desc: 'Freezing drizzle',      gradient: 'rain'         },
  57: { icon: 'rainy-5',      desc: 'Heavy freezing drizzle',gradient: 'rain'         },
  61: { icon: 'rainy-4',      desc: 'Light rain',            gradient: 'rain'         },
  63: { icon: 'rainy-5',      desc: 'Rain',                  gradient: 'rain'         },
  65: { icon: 'rainy-6',      desc: 'Heavy rain',            gradient: 'rain'         },
  66: { icon: 'rainy-5',      desc: 'Freezing rain',         gradient: 'rain'         },
  67: { icon: 'rainy-6',      desc: 'Heavy freezing rain',   gradient: 'rain'         },
  71: { icon: 'snowy-1',      desc: 'Light snow',            gradient: 'snow'         },
  73: { icon: 'snowy-3',      desc: 'Snow',                  gradient: 'snow'         },
  75: { icon: 'snowy-5',      desc: 'Heavy snow',            gradient: 'snow'         },
  77: { icon: 'snowy-4',      desc: 'Snow grains',           gradient: 'snow'         },
  80: { icon: 'rainy-3',      desc: 'Light showers',         gradient: 'rain'         },
  81: { icon: 'rainy-5',      desc: 'Showers',               gradient: 'rain'         },
  82: { icon: 'rainy-7',      desc: 'Heavy showers',         gradient: 'rain'         },
  85: { icon: 'snowy-2',      desc: 'Snow showers',          gradient: 'snow'         },
  86: { icon: 'snowy-6',      desc: 'Heavy snow showers',    gradient: 'snow'         },
  95: { icon: 'thunder',      desc: 'Thunderstorm',          gradient: 'storm'        },
  96: { icon: 'thunder',      desc: 'Thunderstorm + hail',   gradient: 'storm'        },
  99: { icon: 'thunder',      desc: 'Heavy thunderstorm',    gradient: 'storm'        },
}

const NIGHT_ICON_MAP: Record<string, string> = {
  'rainy-1': 'rainy-4',
  'rainy-2': 'rainy-5',
  'rainy-3': 'rainy-6',
  'snowy-1': 'snowy-4',
  'snowy-2': 'snowy-5',
  'snowy-3': 'snowy-5',
}

export function wmoInfo(code: number, isDay = true): WmoInfo {
  const entry = WMO_TABLE[code] ?? { icon: 'day', desc: 'Unknown', gradient: 'partly-cloudy' as HeroGradient }
  if (!isDay && (code === 0 || code === 1)) return { ...entry, icon: 'night', gradient: 'clear-night' }
  if (!isDay && code === 2) return { ...entry, icon: 'cloudy-night-1', gradient: 'partly-cloudy' }
  if (!isDay && NIGHT_ICON_MAP[entry.icon]) return { ...entry, icon: NIGHT_ICON_MAP[entry.icon] }
  return entry
}

export function weatherIconSrc(icon: string): string {
  return `/weather-icons/animated/${icon}.svg`
}

/**
 * Resolves the effective WMO display info, overriding the Open-Meteo model
 * with a live NWS observation when the model misses active precipitation.
 */
export function resolveWmoInfo(modelCode: number, isDay: boolean, obs?: NWSObservation): WmoInfoResolved {
  const model = wmoInfo(modelCode, isDay)
  if (!obs || modelCode >= 51) return model  // model already shows precip or no observation

  const mm = obs.precipitation ?? 0
  const d = obs.textDescription.toLowerCase()
  const hasPrecip = mm > 0.2 || /rain|drizzle|shower|snow|sleet|hail|freezing|thunder/.test(d)
  if (!hasPrecip) return model

  // Map observed description → closest WMO entry
  let entry: WmoInfo
  if (/thunder/.test(d))                    entry = WMO_TABLE[95]
  else if (/heavy (rain|shower)/.test(d))   entry = WMO_TABLE[65]
  else if (/rain shower|shower/.test(d))    entry = WMO_TABLE[80]
  else if (/freezing (rain|drizzle)/.test(d)) entry = WMO_TABLE[66]
  else if (/drizzle/.test(d))               entry = WMO_TABLE[51]
  else if (/rain/.test(d))                  entry = WMO_TABLE[61]
  else if (/heavy snow/.test(d))            entry = WMO_TABLE[75]
  else if (/snow shower/.test(d))           entry = WMO_TABLE[85]
  else if (/snow/.test(d))                  entry = WMO_TABLE[71]
  else if (/sleet/.test(d))                 entry = WMO_TABLE[66]
  else                                       entry = WMO_TABLE[61]  // fallback: light rain

  // Use observation's own text if it's more descriptive than the WMO default
  const desc = obs.textDescription.length > 1
    ? obs.textDescription.replace(/\b\w/g, c => c.toUpperCase())
    : entry.desc

  return { ...entry, desc, live: true }
}

// ─── Hero gradients ───────────────────────────────────────────────────────────

export const HERO_GRADIENT: Record<HeroGradient, string> = {
  'clear-day':     'linear-gradient(180deg,#7dd3fc 0%,#3b82f6 55%,#1d4ed8 100%)',
  'clear-night':   'linear-gradient(180deg,#0f0e2a 0%,#0d1b3e 50%,#020617 100%)',
  'partly-cloudy': 'linear-gradient(180deg,#bfdbfe 0%,#60a5fa 45%,#3b82f6 100%)',
  'cloudy':        'linear-gradient(180deg,#64748b 0%,#475569 55%,#334155 100%)',
  'fog':           'linear-gradient(180deg,#94a3b8 0%,#a1a1aa 55%,#6b7280 100%)',
  'drizzle':       'linear-gradient(180deg,#64748b 0%,#1d4ed8 55%,#1e293b 100%)',
  'rain':          'linear-gradient(180deg,#475569 0%,#1e3a8a 55%,#0f172a 100%)',
  'snow':          'linear-gradient(180deg,#e2e8f0 0%,#bfdbfe 55%,#cbd5e1 100%)',
  'storm':         'linear-gradient(180deg,#334155 0%,#4c1d95 55%,#020617 100%)',
}

export const NIGHT_GRADIENT: Partial<Record<HeroGradient, string>> = {
  'partly-cloudy': 'linear-gradient(180deg,#0f172a 0%,#1e3a5f 50%,#020617 100%)',
  'cloudy':        'linear-gradient(180deg,#111827 0%,#1e293b 55%,#030712 100%)',
  'fog':           'linear-gradient(180deg,#111827 0%,#1e293b 50%,#0f172a 100%)',
  'drizzle':       'linear-gradient(180deg,#1e293b 0%,#0f172a 45%,#020617 100%)',
  'rain':          'linear-gradient(180deg,#0f172a 0%,#0c1833 50%,#020617 100%)',
  'snow':          'linear-gradient(180deg,#1e293b 0%,#0f172a 55%,#060620 100%)',
  'storm':         'linear-gradient(180deg,#050510 0%,#1a0840 55%,#000000 100%)',
}

export function heroBackground(gradient: HeroGradient, isDay: boolean): string {
  return (!isDay && NIGHT_GRADIENT[gradient]) ? NIGHT_GRADIENT[gradient]! : HERO_GRADIENT[gradient]
}

// Light-on-dark vs dark-on-light: snow gradients are pale and need dark text.
export const SNOW_TEXT = 'text-slate-800'
export function heroTextClass(gradient: HeroGradient, isDay = true): string {
  if (!isDay) return 'text-white'
  return gradient === 'snow' || gradient === 'fog' ? SNOW_TEXT : 'text-white'
}

// ─── Moon phase ───────────────────────────────────────────────────────────────

const NEW_MOON_EPOCH_MS = 947182440000
const SYNODIC_MS = 29.53059 * 24 * 60 * 60 * 1000

export function currentMoonPhase(): number {
  const elapsed = Date.now() - NEW_MOON_EPOCH_MS
  return ((elapsed % SYNODIC_MS) + SYNODIC_MS) % SYNODIC_MS / SYNODIC_MS
}

export interface MoonPhaseResult { name: string; emoji: string; illumination: number }

export function moonPhaseInfo(phase: number): MoonPhaseResult {
  const p = ((phase % 1) + 1) % 1
  const illumination = Math.round(((1 - Math.cos(2 * Math.PI * p)) / 2) * 100)
  if (p < 0.0625 || p >= 0.9375) return { name: 'New Moon',       emoji: '🌑', illumination }
  if (p < 0.1875)                return { name: 'Waxing Crescent', emoji: '🌒', illumination }
  if (p < 0.3125)                return { name: 'First Quarter',   emoji: '🌓', illumination }
  if (p < 0.4375)                return { name: 'Waxing Gibbous',  emoji: '🌔', illumination }
  if (p < 0.5625)                return { name: 'Full Moon',       emoji: '🌕', illumination }
  if (p < 0.6875)                return { name: 'Waning Gibbous',  emoji: '🌖', illumination }
  if (p < 0.8125)                return { name: 'Last Quarter',    emoji: '🌗', illumination }
  return                                { name: 'Waning Crescent', emoji: '🌘', illumination }
}

// ─── Weather alerts ────────────────────────────────────────────────────────────

export interface WeatherAlert {
  id: string
  event: string
  severity: 'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown'
  urgency: 'Immediate' | 'Expected' | 'Future' | 'Past' | 'Unknown'
  headline: string | null
  description: string | null
  instruction: string | null
  expires: string | null
  areaDesc: string
}

export type AlertSeverityLevel = 'extreme' | 'severe' | 'moderate' | 'minor'

export function alertSeverity(alert: WeatherAlert): AlertSeverityLevel {
  switch (alert.severity) {
    case 'Extreme': return 'extreme'
    case 'Severe':  return 'severe'
    case 'Moderate': return 'moderate'
    default: return 'minor'
  }
}

export function worstAlertSeverity(alerts: WeatherAlert[]): AlertSeverityLevel | null {
  if (!alerts.length) return null
  const order: AlertSeverityLevel[] = ['extreme', 'severe', 'moderate', 'minor']
  const levels = alerts.map(alertSeverity)
  return order.find(l => levels.includes(l)) ?? 'minor'
}

export type AdvisoryEffect = 'heat' | 'smoke' | 'wind' | 'freeze' | null

export function getAdvisoryEffect(alerts: WeatherAlert[]): AdvisoryEffect {
  for (const a of alerts) {
    const e = a.event.toLowerCase()
    if (/heat|excessive heat/.test(e)) return 'heat'
    if (/air quality|smoke|haze/.test(e)) return 'smoke'
  }
  for (const a of alerts) {
    const e = a.event.toLowerCase()
    if (/wind/.test(e)) return 'wind'
    if (/freeze|frost|ice storm|winter storm|blizzard/.test(e)) return 'freeze'
  }
  return null
}

export function advisoryHeroBackground(effect: AdvisoryEffect, isDay: boolean): string | null {
  if (effect === 'heat') return isDay
    ? 'linear-gradient(180deg,#92400e 0%,#b45309 28%,#d97706 58%,#78350f 100%)'
    : 'linear-gradient(180deg,#1c0a00 0%,#451a03 45%,#1c0a00 100%)'
  if (effect === 'smoke') return isDay
    ? 'linear-gradient(180deg,#44352a 0%,#6b5040 38%,#4a3728 75%,#2d1f14 100%)'
    : 'linear-gradient(180deg,#170f08 0%,#2a1f10 50%,#0f0a05 100%)'
  return null
}

// ─── Fetch helper (shared cross-route cache) ────────────────────────────────────

interface WeatherCache { data: WeatherData; locationKey: string; ts: number }
let _wxCache: WeatherCache | null = null
const WX_CACHE_TTL_MS = 5 * 60 * 1000

export interface WeatherFetchLocation {
  lat: number
  lng: number
  displayName: string
}

/**
 * Fetch full weather data for a location, served from a 5-minute module cache
 * shared across routes. Both the Weather page and the Home weather card hit this
 * so navigating between them never triggers a redundant request.
 */
export async function fetchWeatherData(
  location: WeatherFetchLocation,
  opts: { days?: number; unit?: 'fahrenheit' | 'celsius' } = {},
): Promise<WeatherData> {
  const { days = 7, unit = 'fahrenheit' } = opts
  if (_wxCache && _wxCache.locationKey === location.displayName && Date.now() - _wxCache.ts < WX_CACHE_TTL_MS) {
    return _wxCache.data
  }
  const params = new URLSearchParams({
    lat: String(location.lat),
    lng: String(location.lng),
    location: location.displayName,
    days: String(days),
    unit,
  })
  const res = await fetch(`/api/tools/weather/data?${params}`, { credentials: 'include' })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? 'Weather request failed')
  }
  const data = await res.json() as WeatherData
  _wxCache = { data, locationKey: location.displayName, ts: Date.now() }
  return data
}

interface AlertsCache { alerts: WeatherAlert[]; locationKey: string; ts: number }
let _alertsCache: AlertsCache | null = null

/**
 * Fetch active NWS weather alerts for a location (US only — returns [] for
 * non-US coordinates). Shares the same 5-minute cache TTL as weather data.
 */
export async function fetchWeatherAlerts(location: WeatherFetchLocation): Promise<WeatherAlert[]> {
  if (_alertsCache && _alertsCache.locationKey === location.displayName && Date.now() - _alertsCache.ts < WX_CACHE_TTL_MS) {
    return _alertsCache.alerts
  }
  try {
    const params = new URLSearchParams({ lat: String(location.lat), lng: String(location.lng) })
    const res = await fetch(`/api/tools/weather/alerts?${params}`, { credentials: 'include' })
    if (!res.ok) return []
    const body = await res.json() as { alerts: WeatherAlert[] }
    _alertsCache = { alerts: body.alerts, locationKey: location.displayName, ts: Date.now() }
    return body.alerts
  } catch {
    return []
  }
}
