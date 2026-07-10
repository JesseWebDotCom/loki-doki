import { Droplets, Sun, Thermometer, Wind } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { weatherIconSrc, resolveWmoInfo, wmoInfo, heroBackground, heroTextClass, SNOW_TEXT } from '@/lib/weather'
import { WeatherHeroBg } from '@/components/weather/WeatherHeroBg'
import { useHudWeatherData } from '../useHudWeatherData'
import { compassDir, hourLabel, kphToMph, uvLabel } from './weatherFormat'

// Weather page of the island panel: big current conditions + hourly strip +
// details grid, over the Weather app's ANIMATED hero backdrop (rain, snow,
// stars... via WeatherHeroBg + the same condition gradients). Pale gradients
// (daytime snow) flip to dark text via heroTextClass, same as the Weather app.
// No AQI: the weather API has no AQI surface.

export function IslandPageWeather() {
  const { data, status } = useHudWeatherData()

  if (status === 'no-location') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-white/50">
        <p className="text-sm">Set your location to see weather here.</p>
        <Button size="sm" variant="outline" className="rounded-full" onClick={() => window.lokiDesktop?.openMainWindow('/weather/settings')}>
          Open weather settings
        </Button>
      </div>
    )
  }
  if (status !== 'ready' || !data) {
    return <div className="flex h-full items-center justify-center text-xs text-white/40">{status === 'error' ? 'Weather unavailable right now.' : 'Loading weather…'}</div>
  }

  const cur = data.weather.current
  const daily = data.weather.daily
  const hourly = data.weather.hourly
  const isDay = !!cur.is_day
  const info = resolveWmoInfo(cur.weather_code, isDay, data.observation)
  const darkText = heroTextClass(info.gradient, isDay) === SNOW_TEXT

  // Contrast roles over the animated backdrop. Slate matches the Weather app's
  // own SNOW_TEXT treatment for pale daytime-snow gradients.
  // design-ok(raw-palette-semantic): weather-hero contrast text mirrors WeatherPage's SNOW_TEXT slate scale
  const tPrimary = darkText ? 'text-slate-800' : 'text-white'
  // design-ok(raw-palette-semantic): weather-hero contrast text mirrors WeatherPage's SNOW_TEXT slate scale
  const tSecondary = darkText ? 'text-slate-700' : 'text-white/75'
  // design-ok(raw-palette-semantic): weather-hero contrast text mirrors WeatherPage's SNOW_TEXT slate scale
  const tFaint = darkText ? 'text-slate-600' : 'text-white/55'
  const cell = darkText ? 'bg-black/10' : 'bg-black/25'

  // First hourly slot at/after now; bounded by the array (the shared cache can
  // hand back a short days:1 payload for a few minutes, see useHudWeatherData).
  const now = Date.now()
  let startIdx = hourly.time.findIndex((t) => new Date(t).getTime() >= now)
  if (startIdx < 0) startIdx = Math.max(0, hourly.time.length - 1)
  const slots = [
    { label: 'Now', icon: info.icon, temp: Math.round(cur.temperature_2m) },
    ...hourly.time.slice(startIdx, startIdx + 7).map((t, i) => {
      const idx = startIdx + i
      return {
        label: hourLabel(t, data.weather.timezone),
        icon: wmoInfo(hourly.weather_code[idx] ?? 0, !!(hourly.is_day?.[idx] ?? 1)).icon,
        temp: Math.round(hourly.temperature_2m[idx] ?? 0),
      }
    }),
  ]

  return (
    <div className="relative h-full overflow-hidden rounded-card" style={{ background: heroBackground(info.gradient, isDay) }}>
      <WeatherHeroBg gradient={info.gradient} isDay={isDay} />
      <div className="relative z-10 flex h-full flex-col gap-2.5 p-3.5">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <img src={weatherIconSrc(info.icon)} alt="" className="size-12 drop-shadow" draggable={false} />
            <div>
              <div className={cn('text-4xl font-semibold drop-shadow', tPrimary)}>{Math.round(cur.temperature_2m)}°</div>
              <div className={cn('text-sm', tSecondary)}>{info.desc}</div>
              <div className={cn('text-xs', tFaint)}>{data.location}</div>
            </div>
          </div>
          <div className={cn('text-right text-sm', tSecondary)}>
            <div>H: {Math.round(daily.temperature_2m_max[0] ?? 0)}°</div>
            <div>L: {Math.round(daily.temperature_2m_min[0] ?? 0)}°</div>
          </div>
        </div>

        <div className="flex gap-4 overflow-x-auto pb-0.5">
          {slots.map((s, i) => (
            <div key={i} className="flex shrink-0 flex-col items-center gap-0.5">
              <span className={cn('text-[10px]', tFaint)}>{s.label}</span>
              <img src={weatherIconSrc(s.icon)} alt="" className="size-6 drop-shadow" draggable={false} />
              <span className={cn('text-xs', tSecondary)}>{s.temp}°</span>
            </div>
          ))}
        </div>

        <div className="mt-auto grid grid-cols-4 gap-2">
          {[
            { icon: Thermometer, label: 'Feels like', value: `${Math.round(cur.apparent_temperature)}°` },
            { icon: Droplets, label: 'Humidity', value: `${Math.round(cur.relative_humidity_2m)}%` },
            { icon: Wind, label: 'Wind', value: `${kphToMph(cur.wind_speed_10m)} mph ${compassDir(cur.wind_direction_10m)}` },
            { icon: Sun, label: 'UV Index', value: `${Math.round(cur.uv_index)} ${uvLabel(cur.uv_index)}` },
          ].map((c) => (
            <div key={c.label} className={cn('rounded-card px-2.5 py-2', cell)}>
              <div className={cn('flex items-center gap-1 text-[10px]', tFaint)}>
                <c.icon className="size-3" />
                {c.label}
              </div>
              <div className={cn('mt-0.5 text-sm font-medium', tPrimary)}>{c.value}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
