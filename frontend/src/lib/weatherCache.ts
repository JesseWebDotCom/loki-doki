// Shared, cross-route module cache for the core weather forecast. WeatherPage reads it
// on mount for an instant first paint (no skeleton), and the app prefetch warmer fills
// it ahead of time via prewarmWeather(). The AI banner/day summaries are NOT cached here
// — the page fills those in progressively after the core data renders.

import type { WeatherData } from '@/lib/weather'
import type { UserLocation } from '@/hooks/useUserLocation'

export interface WeatherCache {
  data: WeatherData
  locationKey: string
  ts: number
  summary?: string | null
  daySummaries?: Map<number, string | null>
}

let _wxCache: WeatherCache | null = null
export const WX_CACHE_TTL_MS = 5 * 60 * 1000

/** The cache entry if it's still fresh, else null. */
export function getWeatherCache(): WeatherCache | null {
  if (_wxCache && Date.now() - _wxCache.ts < WX_CACHE_TTL_MS) return _wxCache
  return null
}

/** The raw entry regardless of freshness — used to attach summaries by reference. */
export function getWeatherCacheRaw(): WeatherCache | null {
  return _wxCache
}

export function setWeatherCache(c: WeatherCache): WeatherCache {
  _wxCache = c
  return c
}

/** Fetch the core 7-day forecast for a location and store it. Best-effort and a no-op
 *  if a fresh entry for the same location already exists. */
export async function prewarmWeather(location: UserLocation): Promise<void> {
  const fresh = getWeatherCache()
  if (fresh && fresh.locationKey === location.displayName) return
  try {
    const params = new URLSearchParams({
      lat: String(location.lat),
      lng: String(location.lng),
      location: location.displayName,
      days: '7',
      unit: 'fahrenheit',
    })
    const res = await fetch(`/api/tools/weather/data?${params}`, { credentials: 'include' })
    if (!res.ok) return
    const d = (await res.json()) as WeatherData
    setWeatherCache({ data: d, locationKey: location.displayName, ts: Date.now() })
  } catch {
    /* best-effort warm — the page will fetch cold if this fails */
  }
}
