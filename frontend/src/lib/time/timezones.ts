// A curated set of IANA timezones for the world-clock "Add city" picker, grouped
// by region. Labels are the common city name; the value is the IANA zone id.

export interface TzChoice { value: string; label: string; region: string }

export const TIMEZONES: TzChoice[] = [
  // Americas
  { value: 'America/Los_Angeles', label: 'Los Angeles', region: 'Americas' },
  { value: 'America/Denver', label: 'Denver', region: 'Americas' },
  { value: 'America/Chicago', label: 'Chicago', region: 'Americas' },
  { value: 'America/New_York', label: 'New York', region: 'Americas' },
  { value: 'America/Toronto', label: 'Toronto', region: 'Americas' },
  { value: 'America/Mexico_City', label: 'Mexico City', region: 'Americas' },
  { value: 'America/Bogota', label: 'Bogotá', region: 'Americas' },
  { value: 'America/Sao_Paulo', label: 'São Paulo', region: 'Americas' },
  { value: 'America/Argentina/Buenos_Aires', label: 'Buenos Aires', region: 'Americas' },
  { value: 'America/Anchorage', label: 'Anchorage', region: 'Americas' },
  { value: 'Pacific/Honolulu', label: 'Honolulu', region: 'Americas' },
  // Europe & Africa
  { value: 'Europe/London', label: 'London', region: 'Europe & Africa' },
  { value: 'Europe/Dublin', label: 'Dublin', region: 'Europe & Africa' },
  { value: 'Europe/Paris', label: 'Paris', region: 'Europe & Africa' },
  { value: 'Europe/Madrid', label: 'Madrid', region: 'Europe & Africa' },
  { value: 'Europe/Berlin', label: 'Berlin', region: 'Europe & Africa' },
  { value: 'Europe/Rome', label: 'Rome', region: 'Europe & Africa' },
  { value: 'Europe/Athens', label: 'Athens', region: 'Europe & Africa' },
  { value: 'Europe/Moscow', label: 'Moscow', region: 'Europe & Africa' },
  { value: 'Africa/Lagos', label: 'Lagos', region: 'Europe & Africa' },
  { value: 'Africa/Cairo', label: 'Cairo', region: 'Europe & Africa' },
  { value: 'Africa/Johannesburg', label: 'Johannesburg', region: 'Europe & Africa' },
  // Asia & Pacific
  { value: 'Asia/Dubai', label: 'Dubai', region: 'Asia & Pacific' },
  { value: 'Asia/Karachi', label: 'Karachi', region: 'Asia & Pacific' },
  { value: 'Asia/Kolkata', label: 'Mumbai', region: 'Asia & Pacific' },
  { value: 'Asia/Bangkok', label: 'Bangkok', region: 'Asia & Pacific' },
  { value: 'Asia/Singapore', label: 'Singapore', region: 'Asia & Pacific' },
  { value: 'Asia/Hong_Kong', label: 'Hong Kong', region: 'Asia & Pacific' },
  { value: 'Asia/Shanghai', label: 'Shanghai', region: 'Asia & Pacific' },
  { value: 'Asia/Tokyo', label: 'Tokyo', region: 'Asia & Pacific' },
  { value: 'Asia/Seoul', label: 'Seoul', region: 'Asia & Pacific' },
  { value: 'Australia/Sydney', label: 'Sydney', region: 'Asia & Pacific' },
  { value: 'Pacific/Auckland', label: 'Auckland', region: 'Asia & Pacific' },
]

export function tzLabel(value: string): string {
  return TIMEZONES.find((t) => t.value === value)?.label ?? value.split('/').pop()?.replace(/_/g, ' ') ?? value
}
