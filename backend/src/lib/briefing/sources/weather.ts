// One-line weather summary for the briefing, via open-meteo (no API key). Mirrors the
// geocode + forecast calls in tools/weather.ts but returns a compact human string.

// WMO weather interpretation codes → short text. Subset covering the common cases.
const WMO: Record<number, string> = {
  0: 'clear', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'foggy', 48: 'rime fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers',
  85: 'snow showers', 86: 'snow showers',
  95: 'thunderstorm', 96: 'thunderstorm w/ hail', 99: 'thunderstorm w/ hail',
}

interface Coords {
  lat: number
  lng: number
  name?: string
}

async function geocode(location: string, timeoutMs: number): Promise<Coords | null> {
  // open-meteo's geocoder wants a bare place name — "Milford, CT" returns nothing. Query
  // the town alone, then disambiguate against the state hint (admin1) when one was given.
  const parts = location.split(',').map((p) => p.trim()).filter(Boolean)
  const town = parts[0] || location
  const hint = parts[1]?.toLowerCase() ?? ''
  const res = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(town)}&count=5&language=en&format=json`,
    { signal: AbortSignal.timeout(timeoutMs) },
  )
  if (!res.ok) return null
  const geo = (await res.json()) as {
    results?: Array<{ latitude: number; longitude: number; name: string; admin1?: string; admin1_code?: string; country_code?: string }>
  }
  const results = geo.results ?? []
  if (!results.length) return null
  const match = hint
    ? results.find(
        (r) =>
          r.admin1?.toLowerCase() === hint ||
          r.admin1_code?.toLowerCase() === hint ||
          r.country_code?.toLowerCase() === hint,
      )
    : undefined
  const p = match ?? results[0]!
  return { lat: p.latitude, lng: p.longitude, name: p.name }
}

/**
 * Returns a one-line summary like "72°F, partly cloudy, high 78°F / low 60°F".
 * Pass coords when known (from user.location) to skip geocoding. Throws on failure
 * so the refresher's allSettled marks the source degraded.
 */
export async function weatherSummary(
  opts: { location?: string; lat?: number; lng?: number; unit?: 'fahrenheit' | 'celsius' },
  timeoutMs = 5000,
): Promise<string> {
  let lat = opts.lat
  let lng = opts.lng
  if (lat === undefined || lng === undefined) {
    if (!opts.location) throw new Error('weather: no location or coords')
    const c = await geocode(opts.location, timeoutMs)
    if (!c) throw new Error('weather: geocode failed')
    lat = c.lat
    lng = c.lng
  }
  const unit = opts.unit === 'celsius' ? 'celsius' : 'fahrenheit'
  const deg = unit === 'celsius' ? '°C' : '°F'
  const res = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&current=temperature_2m,weather_code` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&forecast_days=1&timezone=auto&temperature_unit=${unit}`,
    { signal: AbortSignal.timeout(timeoutMs) },
  )
  if (!res.ok) throw new Error(`weather: forecast ${res.status}`)
  const data = (await res.json()) as {
    current?: { temperature_2m?: number; weather_code?: number }
    daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_probability_max?: number[] }
  }
  const cur = data.current
  const daily = data.daily
  const parts: string[] = []
  if (typeof cur?.temperature_2m === 'number') parts.push(`${Math.round(cur.temperature_2m)}${deg}`)
  if (typeof cur?.weather_code === 'number' && WMO[cur.weather_code]) parts.push(WMO[cur.weather_code]!)
  const hi = daily?.temperature_2m_max?.[0]
  const lo = daily?.temperature_2m_min?.[0]
  if (typeof hi === 'number' && typeof lo === 'number') {
    parts.push(`high ${Math.round(hi)}${deg} / low ${Math.round(lo)}${deg}`)
  }
  const pop = daily?.precipitation_probability_max?.[0]
  if (typeof pop === 'number' && pop >= 30) parts.push(`${pop}% chance of precip`)
  if (!parts.length) throw new Error('weather: empty')
  return parts.join(', ')
}
