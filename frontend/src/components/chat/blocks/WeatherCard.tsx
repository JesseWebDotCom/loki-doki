import { Droplets, Wind } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/cn'
import type { WeatherBlockData } from './types'

// WMO weather interpretation codes
function wmoLabel(code: number): string {
  if (code === 0) return 'Clear sky'
  if (code === 1) return 'Mainly clear'
  if (code === 2) return 'Partly cloudy'
  if (code === 3) return 'Overcast'
  if (code === 45 || code === 48) return 'Fog'
  if (code >= 51 && code <= 55) return 'Drizzle'
  if (code >= 61 && code <= 65) return 'Rain'
  if (code >= 71 && code <= 77) return 'Snow'
  if (code === 80 || code === 81 || code === 82) return 'Showers'
  if (code === 85 || code === 86) return 'Snow showers'
  if (code === 95) return 'Thunderstorm'
  if (code === 96 || code === 99) return 'Thunderstorm'
  return 'Unknown'
}

function wmoIcon(code: number): string {
  if (code === 0 || code === 1) return 'day'
  if (code === 2) return 'cloudy-day-1'
  if (code === 3 || code === 45 || code === 48) return 'cloudy'
  if (code === 51) return 'rainy-1'
  if (code === 53) return 'rainy-2'
  if (code >= 55 && code <= 57) return 'rainy-3'
  if (code === 61 || code === 66) return 'rainy-4'
  if (code === 63 || code === 67) return 'rainy-5'
  if (code === 65) return 'rainy-6'
  if (code === 80) return 'rainy-3'
  if (code === 81) return 'rainy-5'
  if (code === 82) return 'rainy-7'
  if (code === 71 || code === 77) return 'snowy-1'
  if (code === 73) return 'snowy-3'
  if (code === 75) return 'snowy-5'
  if (code === 85) return 'snowy-2'
  if (code === 86) return 'snowy-6'
  if (code === 95 || code === 96 || code === 99) return 'thunder'
  return 'day'
}

function dayAbbr(dateStr: string): string {
  try {
    const d = new Date(dateStr + 'T12:00:00')
    return d.toLocaleDateString('en-US', { weekday: 'short' })
  } catch {
    return dateStr.slice(5)
  }
}

export function WeatherCard({ data }: { data: WeatherBlockData }) {
  return (
    <Card variant="surface" className="text-card-foreground text-sm">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-border/30">
        <p className="text-xs text-muted-foreground mb-1">{data.location}</p>
        <div className="flex items-end gap-3">
          <img src={`/weather-icons/animated/${wmoIcon(data.code)}.svg`} className="size-16" alt="" />
          <div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-3xl font-semibold">{data.tempF}°F</span>
              <span className="text-sm text-muted-foreground">/ {data.tempC}°C</span>
            </div>
            <p className="text-xs text-muted-foreground">{wmoLabel(data.code)}</p>
          </div>
          <div className="ml-auto flex flex-col items-end gap-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><Droplets className="size-3" />{data.humidity}%</span>
            <span className="flex items-center gap-1"><Wind className="size-3" />{data.windKph} km/h</span>
          </div>
        </div>
      </div>

      {/* Forecast strip */}
      {data.forecast.length > 1 && (
        <div className="flex divide-x divide-border/30 overflow-x-auto">
          {data.forecast.map((day, i) => (
            <div
              key={day.date}
              className={cn(
                'flex flex-col items-center gap-1 px-3 py-2.5 min-w-[64px] text-xs',
                i === 0 && 'bg-muted/30',
              )}
            >
              <span className="font-medium text-[11px] text-muted-foreground">
                {i === 0 ? 'Today' : dayAbbr(day.date)}
              </span>
              <img src={`/weather-icons/animated/${wmoIcon(day.code)}.svg`} className="size-10" alt="" />
              <span className="font-medium">{day.high}°</span>
              <span className="text-muted-foreground">{day.low}°</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
