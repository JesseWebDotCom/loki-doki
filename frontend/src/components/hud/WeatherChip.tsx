import { useWeatherSnapshot } from '@/hooks/useWeatherSnapshot'
import { weatherIconSrc } from '@/lib/weather'

// Weather module for the island: a glanceable wing chip (temp + icon) and a
// fuller card row for the expanded panel. Data is the shared cached snapshot
// (lib/weatherCache), so this costs nothing extra to render.

export function WeatherChip() {
  const { snapshot, status } = useWeatherSnapshot()
  if (status !== 'ready' || !snapshot) return null
  return (
    <span className="flex items-center gap-1" title={snapshot.info.desc}>
      <img src={weatherIconSrc(snapshot.info.icon)} alt="" className="size-5" draggable={false} />
      <span className="text-xs font-medium text-white/85">{Math.round(snapshot.temp)}{snapshot.unit}</span>
    </span>
  )
}

export function WeatherCard() {
  const { snapshot, status } = useWeatherSnapshot()
  if (status !== 'ready' || !snapshot) return null
  return (
    <div className="flex items-center gap-2.5">
      <img src={weatherIconSrc(snapshot.info.icon)} alt="" className="size-8" draggable={false} />
      <div className="min-w-0">
        <div className="text-sm font-medium text-white/90">
          {Math.round(snapshot.temp)}{snapshot.unit}
          <span className="ml-2 text-xs font-normal text-white/55">{snapshot.info.desc}</span>
        </div>
        <div className="text-[11px] text-white/45">
          H {Math.round(snapshot.high)}{snapshot.unit} · L {Math.round(snapshot.low)}{snapshot.unit}
          {snapshot.alerts.length > 0 && <span className="ml-2 text-warning">{snapshot.alerts.length} alert{snapshot.alerts.length > 1 ? 's' : ''}</span>}
        </div>
      </div>
    </div>
  )
}
