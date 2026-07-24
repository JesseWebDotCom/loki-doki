// Broadcast weather: big current conditions, feels-like and high/low, an
// alerts banner when the NWS has something to say, and a 7-day strip.

import { useQuery } from '@tanstack/react-query'
import { CloudSun, TriangleAlert } from 'lucide-react'
import { useWeatherSnapshot } from '@/hooks/useWeatherSnapshot'
import { useUserLocation } from '@/hooks/useUserLocation'
import { heroBackground, weatherIconSrc, wmoInfo } from '@/lib/weather'
import type { TvScreenProps } from './index'
import { ScreenFrame, StatusPanel, getJson } from './shared'

interface WeekResponse {
  weather: {
    daily: {
      time: string[]
      temperature_2m_max: number[]
      temperature_2m_min: number[]
      weather_code: number[]
    }
  }
}

function weekdayLabel(isoDate: string, index: number): string {
  if (index === 0) return 'Today'
  return new Date(`${isoDate}T12:00:00`).toLocaleDateString([], { weekday: 'short' })
}

export function WeatherScreen({ channel, title, subtitle }: TvScreenProps) {
  const { snapshot, status } = useWeatherSnapshot()
  const { location } = useUserLocation()

  // Fetch the 7-day strip directly: the shared fetchWeatherData cache is keyed
  // by location only, and the snapshot hook fills it with a 1-day payload.
  const week = useQuery({
    queryKey: ['dokitv', 'weather-week', location?.displayName ?? ''],
    queryFn: () => {
      if (!location) throw new Error('No location')
      const params = new URLSearchParams({
        lat: String(location.lat),
        lng: String(location.lng),
        location: location.displayName,
        days: '7',
        unit: 'fahrenheit',
      })
      return getJson<WeekResponse>(`/api/tools/weather/data?${params}`)
    },
    enabled: !!location,
    refetchInterval: 10 * 60_000,
  })

  if (status === 'no-location') {
    return (
      <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel channel={channel} icon={CloudSun} headline="Waiting for a home location" note="Set the household location in Settings to see local weather" />
      </ScreenFrame>
    )
  }
  if (status === 'error') {
    return (
      <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel channel={channel} icon={CloudSun} headline="Weather is unavailable" note="We could not reach the forecast service" />
      </ScreenFrame>
    )
  }
  if (status === 'loading' || !snapshot) {
    return (
      <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel channel={channel} icon={CloudSun} headline="Checking the sky" note="Waiting for data" />
      </ScreenFrame>
    )
  }

  const daily = week.data?.weather.daily
  const days = daily ? daily.time.slice(0, 7) : []
  const alert = snapshot.alerts[0] ?? null

  return (
    <ScreenFrame channel={channel} title={title} subtitle={subtitle ?? snapshot.location}>
      <div className="flex h-full flex-col gap-6">
        {alert ? (
          <div className="flex items-center gap-4 rounded-card border border-warning/50 bg-warning/15 px-6 py-4">
            <TriangleAlert className="size-7 shrink-0 text-warning" />
            <p className="truncate text-xl font-semibold">{alert.headline ?? alert.event}</p>
            {snapshot.alerts.length > 1 ? (
              <span className="ml-auto shrink-0 text-base text-muted-foreground">+{snapshot.alerts.length - 1} more</span>
            ) : null}
          </div>
        ) : null}

        <div
          className="flex min-h-0 flex-1 items-center justify-between gap-10 overflow-hidden rounded-sheet border border-border/50 px-12"
          style={{ backgroundImage: heroBackground(snapshot.info.gradient, snapshot.isDay) }}
        >
          <div className="min-w-0">
            <p className="text-2xl font-semibold text-white/85">{snapshot.location}</p>
            <p className="mt-2 text-[9rem] font-bold leading-none tracking-tighter text-white tabular-nums">
              {snapshot.temp}
              <span className="align-top text-6xl font-semibold text-white/80">{snapshot.unit}</span>
            </p>
            <p className="mt-3 truncate text-4xl font-semibold text-white">{snapshot.info.desc}</p>
            <p className="mt-3 text-2xl text-white/80">
              Feels like {snapshot.feelsLike}{snapshot.unit}
              <span className="mx-3">|</span>
              High {snapshot.high} <span className="mx-1 text-white/50">/</span> Low {snapshot.low}
            </p>
          </div>
          <img
            src={weatherIconSrc(snapshot.info.icon)}
            alt=""
            decoding="async"
            className="hidden size-56 shrink-0 drop-shadow-lg md:block"
          />
        </div>

        {days.length > 0 && daily ? (
          <div className="grid shrink-0 grid-cols-7 gap-3">
            {days.map((d, i) => {
              const info = wmoInfo(daily.weather_code[i] ?? 0, true)
              return (
                <div key={d} className="flex flex-col items-center gap-2 rounded-card border border-border/50 bg-card/50 px-2 py-4">
                  <span className="text-base font-bold uppercase tracking-widest text-muted-foreground">{weekdayLabel(d, i)}</span>
                  <img src={weatherIconSrc(info.icon)} alt={info.desc} decoding="async" className="size-14" />
                  <span className="text-xl font-semibold tabular-nums">
                    {Math.round(daily.temperature_2m_max[i] ?? 0)}
                    <span className="ml-2 text-muted-foreground">{Math.round(daily.temperature_2m_min[i] ?? 0)}</span>
                  </span>
                </div>
              )
            })}
          </div>
        ) : null}
      </div>
    </ScreenFrame>
  )
}
