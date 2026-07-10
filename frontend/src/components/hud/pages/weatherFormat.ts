// Weather formatting helpers for the island pages, copied from WeatherPage.tsx
// (module-private there). Keep in sync if the page's copies change.

export function kphToMph(k: number): number { return Math.round(k * 0.621371) }

export function compassDir(deg: number): string {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8]!
}

export function uvLabel(uv: number): string {
  if (uv <= 2) return 'Low'
  if (uv <= 5) return 'Moderate'
  if (uv <= 7) return 'High'
  if (uv <= 10) return 'Very high'
  return 'Extreme'
}

export function hourLabel(isoTime: string, tz: string): string {
  try {
    return new Date(isoTime).toLocaleTimeString('en-US', { hour: 'numeric', hour12: true, timeZone: tz })
  } catch {
    return isoTime.slice(11, 16)
  }
}
