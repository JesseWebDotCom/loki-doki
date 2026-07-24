// Tonight's sky: moon phase computed client-side (synodic month math from
// lib/weather), a geometric SVG moon, and sunrise/sunset when a location is
// set, all over the shared deep-space backdrop.

import { useQuery } from '@tanstack/react-query'
import { MoonStar, Sunrise, Sunset } from 'lucide-react'
import { SpaceBackdrop } from '@/components/shared/SpaceBackdrop'
import { useUserLocation } from '@/hooks/useUserLocation'
import { currentMoonPhase, moonPhaseInfo } from '@/lib/weather'
import type { TvScreenProps } from './index'
import { ScreenEyebrow, getJson, useTick } from './shared'

interface SunResponse {
  weather: { daily: { sunrise: string[]; sunset: string[] } }
}

/** Geometric moon: opaque dark disc, lit half, and a terminator ellipse whose
 * fill flips between lit (gibbous) and dark (crescent). */
function MoonDisc({ phase, glow }: { phase: number; glow: string }) {
  const p = ((phase % 1) + 1) % 1
  const k = Math.cos(2 * Math.PI * p) // 1 = new, -1 = full
  const waxing = p < 0.5
  const rx = Math.abs(k) * 45
  const gibbous = k < 0
  return (
    <svg
      viewBox="0 0 100 100"
      className="size-64 xl:size-80"
      style={{ filter: `drop-shadow(0 0 48px color-mix(in oklab, ${glow} 45%, transparent))` }}
      role="img"
      aria-label="Moon phase"
    >
      <circle cx="50" cy="50" r="45" className="fill-card" />
      <path d={waxing ? 'M50 5 A45 45 0 0 1 50 95 Z' : 'M50 5 A45 45 0 0 0 50 95 Z'} className="fill-foreground/90" />
      <ellipse cx="50" cy="50" rx={rx} ry="45" className={gibbous ? 'fill-foreground/90' : 'fill-card'} />
      <circle cx="50" cy="50" r="45" fill="none" className="stroke-border/70" strokeWidth="1" />
    </svg>
  )
}

function timeFromIso(iso: string | undefined): string | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function NightSkyScreen({ channel, title, subtitle }: TvScreenProps) {
  const now = useTick(60 * 60_000)
  const { location } = useUserLocation()
  const phase = currentMoonPhase()
  const info = moonPhaseInfo(phase)
  const waxing = phase < 0.5
  const daysToFull = Math.round((((0.5 - phase) % 1 + 1) % 1) * 29.53)
  const daysToNew = Math.round((((1 - phase) % 1 + 1) % 1) * 29.53)

  const sun = useQuery({
    queryKey: ['dokitv', 'nightsky-sun', location?.displayName ?? ''],
    queryFn: () => {
      if (!location) throw new Error('No location')
      const params = new URLSearchParams({
        lat: String(location.lat),
        lng: String(location.lng),
        location: location.displayName,
        days: '1',
        unit: 'fahrenheit',
      })
      return getJson<SunResponse>(`/api/tools/weather/data?${params}`)
    },
    enabled: !!location,
    refetchInterval: 60 * 60_000,
    retry: 1,
  })

  const sunrise = timeFromIso(sun.data?.weather.daily.sunrise[0])
  const sunset = timeFromIso(sun.data?.weather.daily.sunset[0])

  const facts: { label: string; value: string }[] = [
    { label: 'Illumination', value: `${info.illumination}%` },
    { label: 'Trend', value: waxing ? 'Waxing' : 'Waning' },
    { label: 'Full moon', value: daysToFull === 0 ? 'Tonight' : `In ${daysToFull} days` },
    { label: 'New moon', value: daysToNew === 0 ? 'Tonight' : `In ${daysToNew} days` },
  ]
  if (sunset) facts.push({ label: 'Sunset', value: sunset })
  if (sunrise) facts.push({ label: 'Sunrise', value: sunrise })

  return (
    <div data-theme="dark" className="relative h-full w-full overflow-hidden bg-black text-foreground">
      <SpaceBackdrop className="absolute inset-0 z-0" />
      <div className="relative z-10 flex h-full flex-col gap-6 p-8 lg:p-10">
        <ScreenEyebrow channel={channel} title={title} subtitle={subtitle} />
        <div className="flex min-h-0 flex-1 items-center justify-center gap-16">
          <MoonDisc phase={phase} glow={channel.color} />
          <div className="max-w-xl">
            <p className="flex items-center gap-3 text-sm font-bold uppercase tracking-[0.3em] text-muted-foreground">
              <MoonStar className="size-5" style={{ color: channel.color }} />
              {new Date(now).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
            </p>
            <p className="mt-3 text-6xl font-bold tracking-tight xl:text-7xl">{info.name}</p>
            <div className="mt-8 grid grid-cols-2 gap-x-12 gap-y-4">
              {facts.map((f) => (
                <div key={f.label} className="flex items-baseline justify-between gap-6 border-b border-border/40 pb-2">
                  <span className="flex items-center gap-2 text-base uppercase tracking-widest text-muted-foreground">
                    {f.label === 'Sunset' ? <Sunset className="size-4" /> : null}
                    {f.label === 'Sunrise' ? <Sunrise className="size-4" /> : null}
                    {f.label}
                  </span>
                  <span className="text-xl font-semibold tabular-nums">{f.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
