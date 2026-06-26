import { useEffect, useState } from 'react'
import { Cloud, Locate, MapPin, RefreshCw, Sunrise, Sunset, Sun, Wind, Droplets, Eye, ChevronRight, Loader2, TriangleAlert, ChevronDown } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { StickyAppBar } from '@/components/shared/StickyAppBar'
import { useUserLocation } from '@/hooks/useUserLocation'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { cn } from '@/lib/cn'
import {
  type HeroGradient,
  type WeatherData,
  type WeatherAlert,
  wmoInfo,
  resolveWmoInfo,
  weatherIconSrc,
  HERO_GRADIENT,
  SNOW_TEXT,
  heroBackground,
  currentMoonPhase,
  moonPhaseInfo,
  type MoonPhaseResult,
  alertSeverity,
  fetchWeatherAlerts,
  getAdvisoryEffect,
} from '@/lib/weather'
import { WeatherHeroBg } from '@/components/weather/WeatherHeroBg'
import { getWeatherCache, getWeatherCacheRaw, setWeatherCache } from '@/lib/weatherCache'

// ─── Advice chips ─────────────────────────────────────────────────────────────

function computeAdvice(
  feelsLikeF: number,
  precipChancePct: number,
  precipMm: number,
  uvIndex: number,
  isDay: boolean,
  weatherCode: number,
  hourlyPrecipPct: number[],
): string[] {
  const chips: string[] = []

  if (feelsLikeF < 28)       chips.push('🧣 Hat + gloves')
  if (feelsLikeF < 32)       chips.push('🧥 Heavy coat')
  else if (feelsLikeF < 60)  chips.push('🧥 Jacket')
  else if (feelsLikeF < 68)  chips.push('🧥 Light jacket')

  const maxPrecip = Math.max(precipChancePct, ...hourlyPrecipPct.slice(0, 12))
  if (maxPrecip >= 70)       chips.push('☂️ Rain gear')
  else if (maxPrecip >= 30)  chips.push('☂️ Umbrella')

  const precipIn = precipMm * 0.0394
  if (maxPrecip >= 50 || precipIn >= 0.1) chips.push('🥾 Boots')

  if (uvIndex >= 6) chips.push('🧴 Sunscreen')
  if (uvIndex >= 3 && isDay && [0, 1, 2].includes(weatherCode)) chips.push('🕶 Sunglasses')

  return chips
}

// ─── Minutecast ───────────────────────────────────────────────────────────────

function computeMinutecast(hourlyPrecipPct: number[], startIdx: number): string {
  const s = (i: number) => hourlyPrecipPct[startIdx + i] ?? 0
  const now = s(0), next = s(1), later = s(2)
  const wet = (v: number) => v >= 30
  if (wet(now) && wet(next) && wet(later)) return 'Rain likely for the next couple of hours.'
  if (wet(now) && !wet(next))              return 'Rain tapering off in the next hour.'
  if (!wet(now) && wet(next))              return 'Rain expected in about an hour.'
  if (!wet(now) && !wet(next) && wet(later)) return 'Rain possible in the next couple of hours.'
  return ''
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function round(n: number) { return Math.round(n) }
function kphToMph(k: number) { return Math.round(k * 0.621371) }

function compassDir(deg: number): string {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8]
}

function uvLabel(uv: number): string {
  if (uv <= 2)  return 'Low'
  if (uv <= 5)  return 'Moderate'
  if (uv <= 7)  return 'High'
  if (uv <= 10) return 'Very high'
  return 'Extreme'
}

function hourLabel(isoTime: string, tz: string): string {
  try {
    return new Date(isoTime).toLocaleTimeString('en-US', { hour: 'numeric', hour12: true, timeZone: tz })
  } catch {
    return isoTime.slice(11, 16)
  }
}

function fmtTime(iso: string, tz: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
  } catch {
    return iso
  }
}

function dayLabel(isoDate: string, tz: string): string {
  try {
    const d = new Date(isoDate + 'T12:00:00')
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz })
    if (isoDate === todayStr) return 'Today'
    const tom = new Date()
    tom.setDate(tom.getDate() + 1)
    if (isoDate === tom.toLocaleDateString('en-CA', { timeZone: tz })) return 'Tomorrow'
    return d.toLocaleDateString('en-US', { weekday: 'short' })
  } catch {
    return isoDate
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

// The cross-route weather cache lives in @/lib/weatherCache so the app prefetch warmer
// can fill it ahead of the user opening the app (instant first paint).

// ─── Alert banner ─────────────────────────────────────────────────────────────

const ALERT_STYLES = {
  extreme: { bg: 'bg-red-50 dark:bg-red-950/50',   border: 'border-red-300 dark:border-red-700',   icon: 'text-red-500',   text: 'text-red-800 dark:text-red-200',   pill: 'bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300' },
  severe:  { bg: 'bg-orange-50 dark:bg-orange-950/50', border: 'border-orange-300 dark:border-orange-700', icon: 'text-orange-500', text: 'text-orange-800 dark:text-orange-200', pill: 'bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300' },
  moderate:{ bg: 'bg-amber-50 dark:bg-amber-950/50',  border: 'border-amber-300 dark:border-amber-700',  icon: 'text-amber-500',  text: 'text-amber-800 dark:text-amber-200',  pill: 'bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300' },
  minor:   { bg: 'bg-yellow-50 dark:bg-yellow-950/40',border: 'border-yellow-300 dark:border-yellow-700', icon: 'text-yellow-600', text: 'text-yellow-800 dark:text-yellow-200', pill: 'bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300' },
}

function AlertBanner({ alert }: { alert: WeatherAlert }) {
  const [expanded, setExpanded] = useState(false)
  const level = alertSeverity(alert)
  const s = ALERT_STYLES[level]
  const expiresStr = alert.expires
    ? new Date(alert.expires).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : null

  return (
    <div className={cn('rounded-xl border px-4 py-3', s.bg, s.border)}>
      <button
        className="w-full flex items-start gap-2.5 text-left"
        onClick={() => setExpanded(e => !e)}
      >
        <TriangleAlert className={cn('size-4 shrink-0 mt-0.5', s.icon)} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cn('text-sm font-semibold', s.text)}>{alert.event}</span>
            {expiresStr && <span className={cn('text-[10px] font-medium rounded-full px-2 py-0.5', s.pill)}>Until {expiresStr}</span>}
          </div>
          {alert.headline && (
            <p className={cn('text-xs mt-0.5 leading-snug', s.text, 'opacity-80')}>{alert.headline}</p>
          )}
        </div>
        <ChevronDown className={cn('size-4 shrink-0 mt-0.5 transition-transform', s.icon, expanded && 'rotate-180')} />
      </button>
      {expanded && (alert.description || alert.instruction) && (
        <div className={cn('mt-2.5 pt-2.5 border-t space-y-2', s.border)}>
          {alert.description && (
            <p className={cn('text-xs leading-relaxed whitespace-pre-line', s.text, 'opacity-75')}>{alert.description}</p>
          )}
          {alert.instruction && (
            <p className={cn('text-xs leading-relaxed font-medium', s.text)}>{alert.instruction}</p>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────


type HourlyMetric = 'temp' | 'precip' | 'wind' | 'uv'
const METRIC_LABELS: Record<HourlyMetric, string> = { temp: 'Temp', precip: 'Precip', wind: 'Wind', uv: 'UV' }

// ─── Main page ────────────────────────────────────────────────────────────────

export function WeatherPage() {
  const { location, status: locStatus, detect } = useUserLocation()
  const [data, setData] = useState<WeatherData | null>(() => getWeatherCache()?.data ?? null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fresh = getWeatherCache()
  const [summary, setSummary] = useState<string | null>(() => fresh?.summary ?? null)
  const [alerts, setAlerts] = useState<WeatherAlert[]>([])
  const [metric, setMetric] = useState<HourlyMetric>('temp')
  const [expandedDay, setExpandedDay] = useState<number | null>(null)
  const [daySummaries, setDaySummaries] = useState<Map<number, string | null>>(() => fresh?.daySummaries ?? new Map())

  const unit: 'fahrenheit' | 'celsius' = 'fahrenheit'
  const ul = '°F'

  async function load() {
    if (!location) return
    const existing = getWeatherCache()
    if (existing && existing.locationKey === location.displayName) {
      const cached = existing
      setData(cached.data)
      if (cached.daySummaries) setDaySummaries(cached.daySummaries)
      const cachedAlerts = await fetchWeatherAlerts(location)
      setAlerts(cachedAlerts)
      // Banner summary not generated yet for this cache entry — generate it now.
      if (cached.summary == null) {
        void fetchSummary(cached.data, cachedAlerts)
      } else {
        setSummary(cached.summary)
      }
      return
    }
    setLoading(true)
    setError(null)
    if (!data) {
      setSummary(null)
      setDaySummaries(new Map())
    }
    try {
      const params = new URLSearchParams({ lat: String(location.lat), lng: String(location.lng), location: location.displayName, days: '7', unit })
      const [res, activeAlerts] = await Promise.all([
        fetch(`/api/tools/weather/data?${params}`, { credentials: 'include' }),
        fetchWeatherAlerts(location),
      ])
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? 'Weather request failed')
      }
      const d = await res.json() as WeatherData
      setWeatherCache({ data: d, locationKey: location.displayName, ts: Date.now() })
      setData(d)
      setAlerts(activeAlerts)
      setSummary(null)
      setDaySummaries(new Map())
      // Generate the top-banner summary first so it isn't competing with the 7
      // day-summaries for the single local model; trickle those in afterward.
      void fetchSummary(d, activeAlerts).finally(() => {
        for (let i = 0; i < d.weather.daily.time.length; i++) void fetchDaySummary(d, i)
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load weather')
    } finally {
      setLoading(false)
    }
  }

  async function fetchSummary(d: WeatherData, activeAlerts: WeatherAlert[]) {
    try {
      const cur = d.weather.current
      const daily = d.weather.daily
      const info = wmoInfo(cur.weather_code, !!cur.is_day)
      const hourlyPrecip = d.weather.hourly.precipitation_probability ?? []
      const now = Date.now()
      const startIdx = d.weather.hourly.time.findIndex((t) => new Date(t).getTime() >= now - 1800000)
      const advice = computeAdvice(cur.apparent_temperature, hourlyPrecip[startIdx] ?? 0, cur.precipitation, cur.uv_index ?? 0, !!cur.is_day, cur.weather_code, hourlyPrecip.slice(startIdx + 1))
      const res = await fetch('/api/tools/weather/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          location: d.location,
          temp: round(cur.temperature_2m),
          feelsLike: round(cur.apparent_temperature),
          condition: info.desc,
          high: round(daily.temperature_2m_max[0]),
          low: round(daily.temperature_2m_min[0]),
          humidity: cur.relative_humidity_2m,
          windMph: kphToMph(cur.wind_speed_10m),
          uvIndex: round(cur.uv_index ?? 0),
          advice,
          alerts: activeAlerts.map(a => a.event),
        }),
      })
      if (res.ok) {
        const { summary: s } = await res.json() as { summary: string | null }
        setSummary(s)
        const c = getWeatherCacheRaw()
        if (c && c.data === d) c.summary = s
      }
    } catch {
      // summary is optional
    }
  }

  async function fetchDaySummary(d: WeatherData, i: number) {
    if (daySummaries.has(i)) return
    setDaySummaries(prev => new Map([...prev, [i, null]]))
    try {
      const daily = d.weather.daily
      const label = dayLabel(daily.time[i], d.weather.timezone)
      const w = wmoInfo(daily.weather_code[i], true)
      const res = await fetch('/api/tools/weather/day-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          location: d.location,
          date: label,
          condition: w.desc,
          high: round(daily.temperature_2m_max[i]),
          low: round(daily.temperature_2m_min[i]),
          precipChance: daily.precipitation_probability_max?.[i] ?? 0,
        }),
      })
      if (res.ok) {
        const { summary: s } = await res.json() as { summary: string | null }
        setDaySummaries(prev => {
          const next = new Map([...prev, [i, s ?? '']])
          const c = getWeatherCacheRaw()
          if (c && c.data === d) c.daySummaries = next
          return next
        })
      }
    } catch {
      setDaySummaries(prev => new Map([...prev, [i, '']]))
    }
  }

  useEffect(() => {
    if (location) load()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location?.displayName])

  const cur = data?.weather.current
  const tz = data?.weather.timezone ?? location?.timezone ?? 'UTC'
  const isDay = cur ? !!cur.is_day : true
  const info = cur ? resolveWmoInfo(cur.weather_code, isDay, data?.observation) : null
  const gradient = info?.gradient ?? 'partly-cloudy'
  const moonPhase = currentMoonPhase()
  const moon = moonPhaseInfo(moonPhase)
  const isSnow = gradient === 'snow'
  const heroBg = heroBackground(gradient, isDay)
  const heroText = isSnow ? SNOW_TEXT : 'text-white'
  const advisoryEffect = getAdvisoryEffect(alerts)

  const weatherContextDesc = cur && data
    ? `User is viewing the Weather app for ${data.location}. Current: ${round(cur.temperature_2m)}°F (feels like ${round(cur.apparent_temperature)}°F), ${info?.desc ?? 'unknown'}. Today high ${round(data.weather.daily.temperature_2m_max[0])}°F, low ${round(data.weather.daily.temperature_2m_min[0])}°F. Humidity ${cur.relative_humidity_2m}%, wind ${kphToMph(cur.wind_speed_10m)} mph.`
    : 'User is viewing the Weather app (loading…).'
  usePublishUIContext({ label: data?.location ?? 'Weather', description: weatherContextDesc })

  // Hourly slots
  const hourlyData = data?.weather.hourly
  const hourlyStartIdx = (() => {
    if (!hourlyData) return 0
    const now = Date.now()
    const idx = hourlyData.time.findIndex((t) => new Date(t).getTime() >= now - 1800000)
    return idx >= 0 ? idx : 0
  })()

  const hourlySlots = (() => {
    if (!hourlyData) return []
    const slots: { label: string; icon: string; temp: number; precip: number; windMph: number; uv: number }[] = []
    for (let i = hourlyStartIdx; i < hourlyData.time.length && slots.length < 24; i++) {
      const isNowSlot = slots.length === 0 && cur
      const code = isNowSlot ? cur.weather_code : hourlyData.weather_code[i]
      const dayFlag = isNowSlot ? !!cur.is_day : !!(hourlyData.is_day?.[i] ?? isDay)
      const w = isNowSlot ? (info ?? wmoInfo(code, dayFlag)) : wmoInfo(code, dayFlag)
      slots.push({
        label: slots.length === 0 ? 'Now' : hourLabel(hourlyData.time[i], tz),
        icon: w.icon,
        temp: isNowSlot ? round(cur.temperature_2m) : round(hourlyData.temperature_2m[i]),
        precip: hourlyData.precipitation_probability[i] ?? 0,
        windMph: kphToMph(hourlyData.wind_speed_10m?.[i] ?? 0),
        uv: round(hourlyData.uv_index?.[i] ?? 0),
      })
    }
    return slots
  })()

  const advice = cur && hourlyData ? computeAdvice(
    cur.apparent_temperature,
    hourlyData.precipitation_probability[hourlyStartIdx] ?? 0,
    cur.precipitation,
    cur.uv_index ?? 0,
    isDay,
    cur.weather_code,
    hourlyData.precipitation_probability.slice(hourlyStartIdx + 1),
  ) : []

  const minutecast = hourlyData ? computeMinutecast(hourlyData.precipitation_probability, hourlyStartIdx) : ''

  return (
    <PageShell>
    <div className="min-h-full">
      <StickyAppBar
        name="Weather"
        gradient="linear-gradient(135deg,#FFB800,#F59E0B)"
        icon={Cloud}
        actions={[
          { icon: MapPin, label: 'Location' },
          { icon: RefreshCw, label: 'Refresh', onClick: load, iconClassName: loading ? 'animate-spin' : undefined },
        ]}
      />

      {/* No location */}
      {locStatus !== 'loading' && !location && (
        <div className="flex flex-col items-center justify-center gap-4 py-20 px-6 text-center">
          <MapPin className="size-10 text-muted-foreground/40" />
          <div>
            <p className="text-sm font-medium">No location set</p>
            <p className="text-xs text-muted-foreground mt-1">Set your location to see the weather forecast.</p>
          </div>
          <button onClick={detect} className="flex items-center gap-1.5 rounded-lg bg-foreground/10 hover:bg-foreground/15 px-4 py-2 text-sm font-medium transition-colors">
            <Locate className="size-4" />
            Detect my location
          </button>
          <p className="text-xs text-muted-foreground">or go to Settings → General to set a city</p>
        </div>
      )}

      {/* Loading skeleton */}
      {(locStatus === 'loading' || loading) && !data && (
        <div className="px-6 pt-12 pb-10 text-center animate-pulse" style={{ background: HERO_GRADIENT['partly-cloudy'] }}>
          <div className="h-4 w-40 bg-white/20 rounded mx-auto" />
          <div className="h-24 w-32 bg-white/20 rounded mx-auto mt-4" />
          <div className="h-6 w-28 bg-white/20 rounded mx-auto mt-2" />
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="mx-4 mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
      )}

      {/* Weather content */}
      {cur && info && (
        <>
          {/* ── Hero ── */}
          <div className="relative px-6 pt-5 pb-5 overflow-hidden" style={{ background: heroBg }}>
            <WeatherHeroBg gradient={gradient} isDay={isDay} advisory={advisoryEffect} />
            <div className={cn('relative z-10 flex items-center justify-between gap-8', heroText === SNOW_TEXT && SNOW_TEXT)}>
              {/* Center: all main info stacked */}
              <div className="flex-1 flex flex-col items-center text-center">
                <p className={cn('text-sm font-medium mb-2', isSnow ? 'text-slate-600' : 'text-white/70')}>{data!.location}</p>

                <div className="flex items-center gap-2 drop-shadow-lg" aria-hidden>
                  <div className="relative">
                    <img src={weatherIconSrc(info.icon)} className="size-52" alt="" />
                    {!isDay && (
                      <span
                        className="absolute -top-1 -right-2 text-3xl leading-none"
                        style={{ filter: 'drop-shadow(0 0 8px rgba(147,197,253,0.85))' }}
                      >
                        {moon.emoji}
                      </span>
                    )}
                  </div>
                  <p className={cn('font-bold leading-none', isSnow ? 'text-slate-800' : 'text-white')} style={{ fontSize: 80, lineHeight: 1 }}>
                    {round(cur.temperature_2m)}{ul}
                  </p>
                </div>

                <div className="flex items-center gap-2 mt-1">
                  <p className={cn('text-xl font-light', isSnow ? 'text-slate-700' : 'text-white/90')}>{info.desc}</p>
                  {info.live && (
                    <span className="text-[10px] font-semibold tracking-wide uppercase px-1.5 py-0.5 rounded-full bg-white/20 text-white/90">Live</span>
                  )}
                </div>
                <p className={cn('text-xs mt-1', isSnow ? 'text-slate-500' : 'text-white/60')}>
                  Feels like {round(cur.apparent_temperature)}{ul}
                  {' · '}H:{round(data!.weather.daily.temperature_2m_max[0])}{ul}
                  {' '}L:{round(data!.weather.daily.temperature_2m_min[0])}{ul}
                </p>

                {advice.length > 0 && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 justify-center mt-2.5">
                    {advice.map((chip) => {
                      const spaceIdx = chip.indexOf(' ')
                      const icon = spaceIdx > 0 ? chip.slice(0, spaceIdx) : chip
                      const label = spaceIdx > 0 ? chip.slice(spaceIdx + 1) : ''
                      return (
                        <div key={chip} className="flex items-center gap-1.5">
                          <span className="text-lg leading-none">{icon}</span>
                          <span className={cn('text-xs font-medium', isSnow ? 'text-slate-700' : 'text-white/85')}>{label}</span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Right: tiered stats */}
              <div className={cn('shrink-0', isSnow ? 'text-slate-700' : 'text-white')}>
                  {/* Main: sunrise, sunset, moon */}
                  <div className="space-y-2">
                    {data!.weather.daily.sunrise?.[0] && (
                      <div className="flex items-center gap-2">
                        <Sunrise className={cn('size-4 shrink-0', isSnow ? 'text-slate-500' : 'text-white/70')} />
                        <div>
                          <p className={cn('text-[10px] leading-none mb-0.5', isSnow ? 'text-slate-400' : 'text-white/50')}>Sunrise</p>
                          <p className="text-sm font-semibold tabular-nums">{fmtTime(data!.weather.daily.sunrise[0], tz)}</p>
                        </div>
                      </div>
                    )}
                    {data!.weather.daily.sunset?.[0] && (
                      <div className="flex items-center gap-2">
                        <Sunset className={cn('size-4 shrink-0', isSnow ? 'text-slate-500' : 'text-white/70')} />
                        <div>
                          <p className={cn('text-[10px] leading-none mb-0.5', isSnow ? 'text-slate-400' : 'text-white/50')}>Sunset</p>
                          <p className="text-sm font-semibold tabular-nums">{fmtTime(data!.weather.daily.sunset[0], tz)}</p>
                        </div>
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <span className="text-base shrink-0 leading-none">{moon.emoji}</span>
                      <div>
                        <p className={cn('text-[10px] leading-none mb-0.5', isSnow ? 'text-slate-400' : 'text-white/50')}>Moon</p>
                        <p className="text-sm font-semibold">{moon.name} · {moon.illumination}%</p>
                      </div>
                    </div>
                  </div>

                  {/* Moderate: wind, UV */}
                  <div className={cn('mt-3 pt-2.5 border-t space-y-1.5', isSnow ? 'border-slate-300' : 'border-white/20')}>
                    <div className="flex items-center gap-1.5">
                      <Wind className={cn('size-3.5 shrink-0', isSnow ? 'text-slate-400' : 'text-white/55')} />
                      <span className={cn('text-xs', isSnow ? 'text-slate-500' : 'text-white/55')}>Wind</span>
                      <span className="text-xs font-semibold ml-auto tabular-nums">
                        {kphToMph(cur.wind_speed_10m)} mph {cur.wind_direction_10m != null ? compassDir(cur.wind_direction_10m) : ''}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Sun className={cn('size-3.5 shrink-0', isSnow ? 'text-slate-400' : 'text-white/55')} />
                      <span className={cn('text-xs', isSnow ? 'text-slate-500' : 'text-white/55')}>UV</span>
                      <span className="text-xs font-semibold ml-auto">{uvLabel(cur.uv_index ?? 0)} · {round(cur.uv_index ?? 0)}</span>
                    </div>
                  </div>

                  {/* Sub: humidity, visibility */}
                  <div className={cn('mt-2 pt-2 border-t flex gap-4', isSnow ? 'border-slate-300' : 'border-white/10')}>
                    <div className="flex items-center gap-1">
                      <Droplets className={cn('size-3 shrink-0', isSnow ? 'text-slate-400' : 'text-white/40')} />
                      <span className={cn('text-xs', isSnow ? 'text-slate-400' : 'text-white/40')}>{cur.relative_humidity_2m}%</span>
                    </div>
                    {cur.visibility != null && (
                      <div className="flex items-center gap-1">
                        <Eye className={cn('size-3 shrink-0', isSnow ? 'text-slate-400' : 'text-white/40')} />
                        <span className={cn('text-xs', isSnow ? 'text-slate-400' : 'text-white/40')}>{(cur.visibility / 1609).toFixed(1)} mi</span>
                      </div>
                    )}
                  </div>
                </div>
            </div>
            {summary && (
              <p className={cn('relative z-10 mt-3 text-xs italic text-center', isSnow ? 'text-slate-600' : 'text-white/70')}>
                {summary}
              </p>
            )}
          </div>

          {/* ── Alerts ── */}
          {alerts.length > 0 && (
            <div className="mx-4 mt-3 space-y-2">
              {alerts.map(a => <AlertBanner key={a.id} alert={a} />)}
            </div>
          )}

          {/* ── Minutecast ── */}
          {minutecast && (
            <div className="mx-4 mt-3 rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 px-4 py-2.5 text-sm text-blue-800 dark:text-blue-200">
              🌧 {minutecast}
            </div>
          )}

          {/* ── Hourly strip ── */}
          {hourlySlots.length > 0 && (
            <div className="bg-card border border-border rounded-2xl mx-4 mt-3 px-4 pt-3 pb-1">
              <div className="flex gap-1 mb-3">
                {(Object.keys(METRIC_LABELS) as HourlyMetric[]).map((m) => (
                  <button key={m} onClick={() => setMetric(m)}
                    className={cn('rounded-full px-3 py-0.5 text-xs font-medium transition-colors', metric === m ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:bg-muted/80')}>
                    {METRIC_LABELS[m]}
                  </button>
                ))}
              </div>
              <div className="overflow-x-auto no-scrollbar flex gap-5 pb-3">
                {hourlySlots.map((item, i) => {
                  const val = metric === 'temp' ? `${item.temp}${ul}` : metric === 'precip' ? `${item.precip}%` : metric === 'wind' ? `${item.windMph}mph` : String(item.uv)
                  return (
                    <div key={i} className="flex flex-col items-center gap-1.5 shrink-0">
                      <span className="text-muted-foreground text-xs">{item.label}</span>
                      <img src={weatherIconSrc(item.icon)} className="size-14" alt="" />
                      <span className="text-foreground text-sm font-semibold">{val}</span>
                      {metric === 'temp' && <span className="text-[10px] text-muted-foreground">{item.precip}%</span>}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* ── 7-day forecast ── */}
          <div className="bg-card border border-border rounded-2xl mx-4 mt-3 overflow-hidden">
            <p className="px-4 pt-3 pb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">7-day forecast</p>
            {data!.weather.daily.time.slice(1).map((t, idx) => {
              const i = idx + 1
              const w = wmoInfo(data!.weather.daily.weather_code[i], isDay)
              const precipChance = data!.weather.daily.precipitation_probability_max?.[i] ?? 0
              const expanded = expandedDay === i
              const dayHourlySlots = (() => {
                if (!hourlyData) return []
                const dayStart = i * 24
                return hourlyData.time.slice(dayStart, dayStart + 24).map((ht, hi) => ({
                  time: ht,
                  icon: wmoInfo(hourlyData.weather_code[dayStart + hi], isDay).icon,
                  temp: round(hourlyData.temperature_2m[dayStart + hi]),
                }))
              })()
              return (
                <div key={t} className="border-t border-border first:border-0">
                  <button
                    onClick={() => setExpandedDay(expanded ? null : i)}
                    className="group w-full flex flex-col px-4 py-3 hover:bg-muted/50 active:bg-muted/70 transition-colors text-left cursor-pointer"
                  >
                    <div className="flex items-center gap-3 w-full">
                      <span className="w-20 shrink-0 text-sm font-medium">{dayLabel(t, tz)}</span>
                      <img src={weatherIconSrc(w.icon)} className="size-12 shrink-0" alt="" />
                      <div className="flex-1 flex items-center gap-1.5">
                        <span className="text-xs text-blue-500 w-8 text-right">{precipChance}%</span>
                        <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                          <div className="h-full rounded-full bg-blue-400" style={{ width: `${precipChance}%` }} />
                        </div>
                      </div>
                      <div className="flex gap-2 text-sm shrink-0">
                        <span className="font-semibold">{round(data!.weather.daily.temperature_2m_max[i])}{ul}</span>
                        <span className="text-muted-foreground">{round(data!.weather.daily.temperature_2m_min[i])}{ul}</span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <span className={cn('text-[10px] font-medium transition-colors', expanded ? 'text-primary' : 'text-muted-foreground/50 group-hover:text-muted-foreground/80')}>
                          {expanded ? 'Less' : 'Details'}
                        </span>
                        <ChevronRight className={cn('size-4 transition-all shrink-0', expanded ? 'rotate-90 text-primary' : 'text-muted-foreground/50 group-hover:text-muted-foreground/80')} />
                      </div>
                    </div>
                    {daySummaries.get(i) ? (
                      <p className="text-xs text-muted-foreground italic mt-1.5">{daySummaries.get(i)}</p>
                    ) : daySummaries.get(i) === null ? (
                      <div className="flex items-center gap-1 mt-1.5 text-muted-foreground/40">
                        <Loader2 className="size-3 animate-spin" />
                        <span className="text-xs">Summarizing…</span>
                      </div>
                    ) : null}
                  </button>
                  {expanded && (
                    <div className="px-4 pb-3 bg-muted/30">
                      {dayHourlySlots.length > 0 && (
                        <div className="flex gap-3 overflow-x-auto no-scrollbar">
                          {dayHourlySlots.map((hs, hi) => (
                            <div key={hi} className="flex flex-col items-center gap-1 shrink-0 w-12">
                              <span className="text-[10px] text-muted-foreground">{hourLabel(hs.time, tz)}</span>
                              <img src={weatherIconSrc(hs.icon)} className="size-10" alt="" />
                              <span className="text-xs font-medium">{hs.temp}{ul}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

        </>
      )}
    </div>
    </PageShell>
  )
}
