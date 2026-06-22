import type { Tool, ToolResult } from './index'

export const weatherTool: Tool = {
  id: 'weather',
  name: 'Weather',
  description: 'Get current weather and forecasts for a location',
  offline: false,
  dataSources: [
    { name: 'Open-Meteo', domain: 'open-meteo.com', purpose: 'Weather forecasts and conditions', type: 'api' },
    { name: 'Open-Meteo Geocoding', domain: 'geocoding-api.open-meteo.com', purpose: 'Converts location names to coordinates', type: 'api' },
  ],
  configSchema: [
    {
      key: 'default_location',
      label: 'Default Location',
      description: 'Used automatically when no location is mentioned in the request',
      type: 'string' as const,
      scope: 'user' as const,
      placeholder: 'e.g. Austin, TX',
    },
  ],
  examples: [
    'current weather conditions and temperature for a location',
    'weather forecast — will it rain, snow, or be sunny',
    'what to wear based on the weather outside today',
    'temperature and precipitation in a city right now',
    'weekly weather forecast and outlook',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'weather',
      description: 'Get current weather and forecasts for a location',
      parameters: {
        type: 'object',
        required: [],
        properties: {
          location: { type: 'string', description: 'City name or location. Omit if the user did not specify one — the default will be used.' },
          days: { type: 'number', description: 'Number of forecast days (1–7)', default: 1 },
        },
      },
    },
  },

  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const {
      location,
      days = 1,
      lat: argsLat,
      lng: argsLng,
      temperature_unit: argsUnit,
      include_hourly = false,
    } = args as {
      location?: string
      days?: number
      lat?: number
      lng?: number
      temperature_unit?: string
      include_hourly?: boolean
    }
    const temperature_unit = argsUnit ?? (config?.['_temperature_unit'] as string | undefined) ?? 'fahrenheit'

    // _lat/_lng injected by the chat route from user.location or clientLat/Lng
    const configLat = config?.['_lat'] as number | undefined
    const configLng = config?.['_lng'] as number | undefined

    // Reject coordinates that aren't real before interpolating into the Open-Meteo URL.
    const validCoords = (lat: unknown, lng: unknown): lat is number =>
      typeof lat === 'number' && typeof lng === 'number' &&
      Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
      Number.isFinite(lng) && lng >= -180 && lng <= 180

    try {
      let latitude: number
      let longitude: number
      let locationName: string

      if (validCoords(argsLat, argsLng)) {
        latitude = argsLat
        longitude = argsLng as number
        locationName = location?.trim() || `${argsLat.toFixed(2)}, ${(argsLng as number).toFixed(2)}`
      } else if (validCoords(configLat, configLng)) {
        latitude = configLat
        longitude = configLng as number
        locationName = String(config?.['default_location'] ?? '').trim() || `${configLat.toFixed(2)}, ${(configLng as number).toFixed(2)}`
      } else {
        const effectiveLocation = location?.trim() || String(config?.default_location ?? '').trim()
        if (!effectiveLocation) {
          return { success: false, error: 'Location required — include one in your message or set your location in Settings → General' }
        }

        const geoRes = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(effectiveLocation)}&count=1`,
          { signal: AbortSignal.timeout(5000) },
        )
        if (!geoRes.ok) return { success: false, error: 'Geocoding failed' }

        const geo = (await geoRes.json()) as {
          results?: Array<{ latitude: number; longitude: number; name: string; country: string }>
        }
        const place = geo.results?.[0]
        if (!place) return { success: false, error: `Location not found: ${effectiveLocation}` }

        latitude = place.latitude
        longitude = place.longitude
        locationName = `${place.name}, ${place.country}`
      }

      const unit = temperature_unit === 'fahrenheit' ? 'fahrenheit' : 'celsius'
      const forecastDays = Math.min(Math.max(1, days), 7)

      const hourlyParams = include_hourly
        ? '&hourly=temperature_2m,weather_code,precipitation_probability,wind_speed_10m,uv_index,is_day'
        : ''

      const weatherRes = await fetch(
        `https://api.open-meteo.com/v1/forecast?` +
          `latitude=${latitude}&longitude=${longitude}` +
          `&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,apparent_temperature,is_day,uv_index,wind_direction_10m,visibility` +
          `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code,precipitation_probability_max,sunrise,sunset` +
          `${hourlyParams}` +
          `&forecast_days=${forecastDays}&timezone=auto` +
          `&temperature_unit=${unit}`,
        { signal: AbortSignal.timeout(5000) },
      )
      if (!weatherRes.ok) return { success: false, error: 'Weather fetch failed' }

      return {
        success: true,
        data: {
          location: locationName,
          weather: await weatherRes.json(),
          temperature_unit: unit,
        },
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return { success: false, offline: true, error: 'Network unavailable' }
      }
      return { success: false, error: String(err) }
    }
  },
}
