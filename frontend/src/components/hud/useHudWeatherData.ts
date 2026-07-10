import { useEffect, useState } from 'react'
import { useUserLocation } from '@/hooks/useUserLocation'
import { fetchWeatherData, type WeatherData } from '@/lib/weather'

// Full weather payload (current + hourly + daily) for the island's Weather
// page. Same effect skeleton as useWeatherSnapshot. CACHE CAVEAT: the lib
// cache keys on location.displayName only (not days), so a days:1 snapshot
// fetched first can serve a short hourly array for up to 5 minutes. Consumers
// must bound hourly loops by hourly.time.length.

export type HudWeatherStatus = 'loading' | 'ready' | 'no-location' | 'error'

export function useHudWeatherData(): { data: WeatherData | null; status: HudWeatherStatus } {
  const { location, status: locStatus } = useUserLocation()
  const [data, setData] = useState<WeatherData | null>(null)
  const [status, setStatus] = useState<HudWeatherStatus>('loading')

  useEffect(() => {
    if (locStatus === 'loading' || locStatus === 'detecting') {
      setStatus('loading')
      return
    }
    if (!location) {
      setStatus('no-location')
      return
    }
    let cancelled = false
    setStatus((s) => (data ? s : 'loading'))
    fetchWeatherData(location, { days: 2, unit: 'fahrenheit' })
      .then((d) => {
        if (cancelled) return
        setData(d)
        setStatus('ready')
      })
      .catch(() => { if (!cancelled) setStatus('error') })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location?.displayName, locStatus])

  return { data, status }
}
