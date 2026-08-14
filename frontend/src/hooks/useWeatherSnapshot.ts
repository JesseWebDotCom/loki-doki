import { useEffect, useState } from 'react'
import { useUserLocation } from './useUserLocation'
import { useCurrentPlace } from './useCurrentPlace'
import { useAutoRefresh } from './useAutoRefresh'
import { fetchWeatherData, fetchWeatherAlerts, resolveWmoInfo, type WeatherData, type WmoInfo, type WeatherAlert } from '@/lib/weather'

export interface WeatherSnapshot {
  location: string
  temp: number
  feelsLike: number
  high: number
  low: number
  isDay: boolean
  info: WmoInfo
  unit: '°F' | '°C'
  alerts: WeatherAlert[]
}

export type SnapshotStatus = 'loading' | 'ready' | 'no-location' | 'error'

export interface UseWeatherSnapshotResult {
  snapshot: WeatherSnapshot | null
  status: SnapshotStatus
}

/**
 * Lightweight current-conditions snapshot for compact surfaces (Home card,
 * Today hero). Reuses the shared weather cache so it costs nothing when the
 * full Weather page has already loaded.
 */
export function useWeatherSnapshot(): UseWeatherSnapshotResult {
  const { location: home, status: locStatus } = useUserLocation()
  // Travel awareness: when the device's coordinates put it away from home, the
  // compact surfaces show conditions where the user actually IS. Falls back to
  // the saved home location whenever there is no current-place signal.
  const { current } = useCurrentPlace()
  const location = current
    ? { displayName: current.label, lat: current.lat, lng: current.lng }
    : home
  // Bumps on tab re-show / focus / reconnect / day-change so a long-idle tab
  // re-fetches conditions instead of showing the snapshot from first mount. The
  // 5-min weather cache means a bump only hits the network once it's stale.
  const refreshEpoch = useAutoRefresh()
  const [snapshot, setSnapshot] = useState<WeatherSnapshot | null>(null)
  const [status, setStatus] = useState<SnapshotStatus>('loading')

  useEffect(() => {
    if (!location && (locStatus === 'loading' || locStatus === 'detecting')) {
      setStatus('loading')
      return
    }
    if (!location) {
      setStatus('no-location')
      return
    }

    let cancelled = false
    setStatus((s) => (snapshot ? s : 'loading'))

    Promise.all([
      fetchWeatherData(location, { days: 1, unit: 'fahrenheit' }),
      fetchWeatherAlerts(location),
    ])
      .then(([d, alerts]: [WeatherData, WeatherAlert[]]) => {
        if (cancelled) return
        const cur = d.weather.current
        const daily = d.weather.daily
        setSnapshot({
          location: d.location,
          temp: Math.round(cur.temperature_2m),
          feelsLike: Math.round(cur.apparent_temperature),
          high: Math.round(daily.temperature_2m_max[0]),
          low: Math.round(daily.temperature_2m_min[0]),
          isDay: !!cur.is_day,
          info: resolveWmoInfo(cur.weather_code, !!cur.is_day, d.observation),
          unit: '°F',
          alerts,
        })
        setStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setStatus('error')
      })

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location?.displayName, locStatus, current?.label, refreshEpoch])

  return { snapshot, status }
}
