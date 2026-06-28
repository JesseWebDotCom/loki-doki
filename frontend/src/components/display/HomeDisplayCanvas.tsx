import { Loader2 } from 'lucide-react'
import { useNow } from '@/hooks/useNow'
import { useWeatherSnapshot } from '@/hooks/useWeatherSnapshot'
import { WeatherHeroBg } from '@/components/weather/WeatherHeroBg'
import { FlipClock } from '@/components/display/FlipClock'
import {
  heroBackground,
  weatherIconSrc,
  getAdvisoryEffect,
  currentMoonPhase,
  moonPhaseInfo,
  type HeroGradient,
} from '@/lib/weather'
import { clockParts, dateLabel, type HomeDisplayConfig } from '@/lib/homeDisplay'
import { cn } from '@/lib/cn'

// The visual of the ambient display, decoupled from chrome/controls so it can be
// rendered both full-screen (DisplayPage) and as a live admin preview. Everything
// is sized in container-query units (cqmin) so it scales to whatever box it's in —
// a 1280×720 wall display or a 280px settings thumbnail look identical.

function CanvasWeather() {
  const { snapshot, status } = useWeatherSnapshot()
  if (status === 'loading') return <Loader2 className="animate-spin text-white/40" style={{ width: '7cqmin', height: '7cqmin' }} />
  if (status !== 'ready' || !snapshot) return null
  const moon = moonPhaseInfo(currentMoonPhase())
  return (
    <div className="flex flex-col items-end" style={{ gap: '0' }} aria-hidden>
      <div className="flex items-center" style={{ gap: '2cqmin' }}>
        <div className="relative shrink-0">
          <img src={weatherIconSrc(snapshot.info.icon)} alt="" style={{ width: '26cqmin', height: '26cqmin' }} />
          {!snapshot.isDay && (
            <span
              className="absolute leading-none"
              style={{ top: '-1cqmin', right: '-1cqmin', fontSize: '6cqmin', filter: 'drop-shadow(0 0 4px rgba(147,197,253,0.9))' }}
            >
              {moon.emoji}
            </span>
          )}
        </div>
        <span className="font-black tabular-nums leading-none text-white drop-shadow-lg" style={{ fontSize: '13cqmin' }}>
          {snapshot.temp}°
        </span>
      </div>
      <p className="font-semibold leading-none text-white/90" style={{ fontSize: '7cqmin', marginTop: '-6cqmin' }}>{snapshot.info.desc}</p>
      <p className="truncate text-right leading-none text-white/60" style={{ fontSize: '3cqmin', maxWidth: '42cqmin', marginTop: '1cqmin' }}>{snapshot.location}</p>
    </div>
  )
}

export function HomeDisplayCanvas({ config, className }: { config: HomeDisplayConfig; className?: string }) {
  const now = useNow(1000)
  const { snapshot, status } = useWeatherSnapshot()

  const wxReady = status === 'ready' && !!snapshot
  const gradient: HeroGradient = snapshot?.info.gradient ?? 'clear-night'
  const isDay = snapshot?.isDay ?? false
  const advisory = wxReady ? getAdvisoryEffect(snapshot!.alerts) : null
  const baseBg = wxReady ? heroBackground(gradient, isDay) : 'linear-gradient(160deg,#0b1120,#05080c)'

  const d = new Date(now)
  const { hh, mm, ss, ampm } = clockParts(d, config)
  const showWxBg = config.weatherBackground && wxReady

  return (
    <div className={cn('home-display-canvas relative overflow-hidden text-white', className)} style={{ background: baseBg }}>
      {showWxBg && <WeatherHeroBg gradient={gradient} isDay={isDay} advisory={advisory} />}
      {/* Legibility scrim — keeps white text readable over bright (snow/clear-day) skies. */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-black/50" />

      {config.weather && (
        <div className="absolute right-0 top-0 z-10" style={{ paddingTop: '1cqmin', paddingRight: '4cqmin' }}>
          <CanvasWeather />
        </div>
      )}

      <div className="relative z-10 flex h-full w-full flex-col items-center justify-center text-center" style={{ padding: '4cqmin' }}>
        {config.clock &&
          (config.clockStyle === 'flip' ? (
            <FlipClock
              hh={hh}
              mm={mm}
              ss={config.showSeconds ? ss : undefined}
              ampm={ampm || undefined}
              style={{ fontSize: '16cqmin' }}
            />
          ) : (
            <div className="flex items-end justify-center font-black tabular-nums leading-none text-white drop-shadow-2xl" style={{ fontSize: '26cqmin' }}>
              <span>{hh}:{mm}</span>
              {config.showSeconds && (
                <span className="text-white/65" style={{ fontSize: '0.46em', marginLeft: '0.12em', marginBottom: '0.12em' }}>:{ss}</span>
              )}
              {ampm && (
                <span className="font-bold text-white/70" style={{ fontSize: '0.26em', marginLeft: '0.18em', marginBottom: '0.55em', letterSpacing: '0.05em' }}>{ampm}</span>
              )}
            </div>
          ))}
        {config.date && (
          <p className="font-semibold tracking-wide text-white/80 drop-shadow" style={{ fontSize: '5cqmin', marginTop: '3cqmin' }}>
            {dateLabel(d)}
          </p>
        )}
      </div>
    </div>
  )
}
