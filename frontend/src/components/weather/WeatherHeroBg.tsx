import { type HeroGradient, type AdvisoryEffect } from '@/lib/weather'
import { cn } from '@/lib/cn'

function rnd(min: number, max: number) { return min + Math.random() * (max - min) }

interface RainLine { key: string; x: number; width: number; opacity: number; dur: number; delay: number }

function makeRainLines(count: number, layer: 'fg' | 'mid' | 'bg'): RainLine[] {
  const cfg = {
    fg:  { w: [1.4, 1.8], op: [0.55, 0.70], dur: [0.42, 0.58] },
    mid: { w: [0.9, 1.2], op: [0.35, 0.50], dur: [0.60, 0.78] },
    bg:  { w: [0.5, 0.8], op: [0.18, 0.30], dur: [0.80, 1.05] },
  }[layer]
  return Array.from({ length: count }, (_, i) => {
    const dur = rnd(cfg.dur[0], cfg.dur[1])
    return { key: `rain-${layer}-${i}`, x: rnd(0, 100), width: rnd(cfg.w[0], cfg.w[1]), opacity: rnd(cfg.op[0], cfg.op[1]), dur, delay: -rnd(0, dur) }
  })
}

function RainSvg({ lines }: { lines: RainLine[] }) {
  return (
    <svg className="absolute inset-0 w-full h-full overflow-hidden weather-particle-container" aria-hidden preserveAspectRatio="none">
      {lines.map((l) => (
        <line key={l.key} x1={`${l.x}%`} y1="-10%" x2={`${l.x - 4}%`} y2="115%"
          stroke="white" strokeWidth={l.width} strokeOpacity={l.opacity}
          style={{ strokeDasharray: '18 120', animationName: 'rain-dash', animationDuration: `${l.dur}s`, animationTimingFunction: 'linear', animationIterationCount: 'infinite', animationDelay: `${l.delay}s` }} />
      ))}
    </svg>
  )
}

interface SnowFlake { key: string; left: number; size: number; dur: number; delay: number; blur: number; opacity: number }

function makeSnowFlakes(count: number, layer: 'fg' | 'mid' | 'bg'): SnowFlake[] {
  const cfg = {
    fg:  { size: [5, 8],   dur: [3.5, 5.5], blur: 0,   op: [0.85, 1.0]  },
    mid: { size: [3, 5],   dur: [5.0, 7.5], blur: 2,   op: [0.60, 0.80] },
    bg:  { size: [1.5, 3], dur: [7.0, 10],  blur: 5,   op: [0.30, 0.55] },
  }[layer]
  return Array.from({ length: count }, (_, i) => {
    const dur = rnd(cfg.dur[0], cfg.dur[1])
    return { key: `snow-${layer}-${i}`, left: rnd(0, 100), size: rnd(cfg.size[0], cfg.size[1]), dur, delay: -rnd(0, dur), blur: cfg.blur, opacity: rnd(cfg.op[0], cfg.op[1]) }
  })
}

function SnowLayer({ flakes }: { flakes: SnowFlake[] }) {
  return (
    <div className="absolute inset-0 overflow-hidden weather-particle-container" aria-hidden>
      {flakes.map((f) => (
        <div key={f.key} className="weather-snow-flake"
          style={{ left: `${f.left}%`, top: 0, width: f.size, height: f.size, filter: f.blur ? `blur(${f.blur}px)` : undefined, opacity: f.opacity, animationDuration: `${f.dur}s`, animationDelay: `${f.delay}s` }} />
      ))}
    </div>
  )
}

// Module-level stable particle arrays (created once, never re-randomised)
const RAIN_FG    = makeRainLines(22, 'fg'),  RAIN_MID    = makeRainLines(16, 'mid'), RAIN_BG    = makeRainLines(10, 'bg')
const DRIZZLE_FG = makeRainLines(10, 'fg'),  DRIZZLE_MID = makeRainLines(8,  'mid')
const STORM_FG   = makeRainLines(28, 'fg'),  STORM_MID   = makeRainLines(20, 'mid'), STORM_BG   = makeRainLines(12, 'bg')
const SNOW_FG    = makeSnowFlakes(10, 'fg'), SNOW_MID    = makeSnowFlakes(12, 'mid'), SNOW_BG    = makeSnowFlakes(14, 'bg')
const STARS         = Array.from({ length: 40 }, (_, i) => { const dur = rnd(1.5, 4);  return { key: `star-${i}`,  left: rnd(0, 100), top: rnd(0, 88),  size: rnd(1, 3),   dur, delay: -rnd(0, dur) } })
const SPARKLES      = Array.from({ length: 14 }, (_, i) => { const dur = rnd(2, 4.5);  return { key: `sp-${i}`,    left: rnd(8, 92),  top: rnd(40, 82), size: rnd(3, 7),   dur, delay: -rnd(0, dur) } })
const SHOOTING_STARS = Array.from({ length: 3 }, (_, i) => { const dur = rnd(9, 15);   return { key: `shoot-${i}`, top: rnd(5, 38),   left: rnd(20, 72), angle: rnd(28, 42), dur, delay: -rnd(0, dur) } })
const CLOUDS_PARTLY = [
  { key: 'cp-0', top: '5%',  width: 210, height: 60,  blur: 18, opacity: 0.72, dur: 28, delay: -10 },
  { key: 'cp-1', top: '38%', width: 155, height: 46,  blur: 14, opacity: 0.58, dur: 22, delay: -6  },
  { key: 'cp-2', top: '17%', width: 100, height: 30,  blur: 10, opacity: 0.44, dur: 36, delay: -22 },
  { key: 'cp-3', top: '65%', width: 130, height: 38,  blur: 12, opacity: 0.40, dur: 20, delay: -14 },
]
const CLOUDS_OVERCAST = [
  { key: 'co-0', top: '0%',  width: 290, height: 82,  blur: 24, opacity: 0.55, dur: 32, delay: -13 },
  { key: 'co-1', top: '28%', width: 210, height: 62,  blur: 18, opacity: 0.48, dur: 25, delay: -9  },
  { key: 'co-2', top: '56%', width: 165, height: 50,  blur: 15, opacity: 0.42, dur: 19, delay: -5  },
  { key: 'co-3', top: '13%', width: 125, height: 38,  blur: 11, opacity: 0.36, dur: 40, delay: -24 },
]
const FOG_LAYERS = [
  { key: 'fog-0', top: '18%', height: '32%', dur: '8s',  delay: '0s'   },
  { key: 'fog-1', top: '48%', height: '26%', dur: '12s', delay: '-4s'  },
  { key: 'fog-2', top: '70%', height: '20%', dur: '16s', delay: '-8s'  },
]

// Advisory particle arrays — stable across renders
const HEAT_WAVES = Array.from({ length: 6 }, (_, i) => ({
  key: `hw-${i}`,
  bottom: `${10 + i * 13}%`,
  dur: 2.8 + i * 0.5,
  delay: -(i * 0.85),
}))
const SMOKE_LAYERS = [
  { key: 'sm-0', top: '6%',  height: '28%', dur: '11s', delay: '0s'   },
  { key: 'sm-1', top: '34%', height: '24%', dur: '15s', delay: '-5s'  },
  { key: 'sm-2', top: '57%', height: '22%', dur: '19s', delay: '-9s'  },
  { key: 'sm-3', top: '80%', height: '18%', dur: '25s', delay: '-14s' },
]
const WIND_GUSTS = Array.from({ length: 20 }, (_, i) => {
  const dur = rnd(0.9, 1.7)
  return { key: `wg-${i}`, top: rnd(2, 96), width: rnd(70, 220), dur, delay: -rnd(0, dur * 4) }
})
const FROST_CRYSTALS = Array.from({ length: 22 }, (_, i) => {
  const dur = rnd(2.0, 5.5)
  return { key: `fc-${i}`, left: rnd(0, 100), top: rnd(0, 92), size: rnd(2, 5), dur, delay: -rnd(0, dur) }
})

export function WeatherHeroBg({ gradient, isDay, advisory = null }: { gradient: HeroGradient; isDay: boolean; advisory?: AdvisoryEffect }) {
  const moonGlow      = <div className="weather-moon-glow" style={{ top: '-35px', right: '16%' }} />
  const moonGlowFaint = <div className="weather-moon-glow" style={{ top: '-35px', right: '16%', opacity: 0.35 }} />

  const weatherBg = (() => {
    switch (gradient) {
      case 'rain':
        return (
          <div className="absolute inset-0 overflow-hidden" aria-hidden>
            {!isDay && moonGlowFaint}
            <RainSvg lines={RAIN_BG} /><RainSvg lines={RAIN_MID} /><RainSvg lines={RAIN_FG} />
          </div>
        )
      case 'drizzle':
        return (
          <div className="absolute inset-0 overflow-hidden" aria-hidden>
            {!isDay && moonGlow}
            <RainSvg lines={DRIZZLE_MID} /><RainSvg lines={DRIZZLE_FG} />
          </div>
        )
      case 'storm':
        return (
          <div className="absolute inset-0 overflow-hidden" aria-hidden>
            <div className="weather-lightning" />
            <RainSvg lines={STORM_BG} /><RainSvg lines={STORM_MID} /><RainSvg lines={STORM_FG} />
          </div>
        )
      case 'snow':
        return (
          <div className="absolute inset-0 overflow-hidden weather-particle-container" aria-hidden>
            {!isDay && moonGlow}
            {!isDay && STARS.slice(0, 18).map((s) => (
              <div key={s.key} className="weather-star" style={{ left: `${s.left}%`, top: `${s.top}%`, width: s.size, height: s.size, animationDuration: `${s.dur}s`, animationDelay: `${s.delay}s` }} />
            ))}
            <SnowLayer flakes={SNOW_BG} /><SnowLayer flakes={SNOW_MID} /><SnowLayer flakes={SNOW_FG} />
          </div>
        )
      case 'fog':
        return (
          <div className="absolute inset-0 overflow-hidden" aria-hidden>
            {!isDay && moonGlowFaint}
            {FOG_LAYERS.map((l) => <div key={l.key} className="weather-fog-layer" style={{ top: l.top, height: l.height, animationDuration: l.dur, animationDelay: l.delay }} />)}
          </div>
        )
      case 'clear-night':
        return (
          <div className="absolute inset-0 overflow-hidden weather-particle-container" aria-hidden>
            <div className="weather-moon-glow" style={{ top: '-35px', right: '16%' }} />
            {STARS.map((s) => <div key={s.key} className="weather-star" style={{ left: `${s.left}%`, top: `${s.top}%`, width: s.size, height: s.size, animationDuration: `${s.dur}s`, animationDelay: `${s.delay}s` }} />)}
            {SHOOTING_STARS.map((s) => (
              <div key={s.key} style={{ position: 'absolute', top: `${s.top}%`, left: `${s.left}%`, transform: `rotate(${s.angle}deg)` }}>
                <div className="weather-shooting-star" style={{ animationDuration: `${s.dur}s`, animationDelay: `${s.delay}s` }} />
              </div>
            ))}
          </div>
        )
      case 'clear-day':
        return (
          <div className="absolute inset-0 overflow-hidden weather-particle-container" aria-hidden>
            <div className="weather-sun-rays" style={{ top: '-80px', right: '14%' }} />
            <div className="weather-sun-orb" style={{ top: '-80px', right: '14%' }} />
            {SPARKLES.map((s) => <div key={s.key} className="weather-sparkle" style={{ left: `${s.left}%`, top: `${s.top}%`, width: s.size, height: s.size, animationDuration: `${s.dur}s`, animationDelay: `${s.delay}s` }} />)}
          </div>
        )
      case 'partly-cloudy':
        return (
          <div className="absolute inset-0 overflow-hidden" aria-hidden>
            {isDay
              ? <div className="weather-sun-orb" style={{ top: '-80px', right: '20%', opacity: 0.50 }} />
              : moonGlow}
            {CLOUDS_PARTLY.map((c) => (
              <div key={c.key} className={cn('weather-cloud-shape', !isDay && 'weather-cloud-shape--dark')} style={{ top: c.top, width: c.width, height: c.height, filter: `blur(${c.blur}px)`, opacity: c.opacity, animationDuration: `${c.dur}s`, animationDelay: `${c.delay}s` }} />
            ))}
          </div>
        )
      case 'cloudy':
        return (
          <div className="absolute inset-0 overflow-hidden" aria-hidden>
            {!isDay && moonGlowFaint}
            {CLOUDS_OVERCAST.map((c) => (
              <div key={c.key} className="weather-cloud-shape weather-cloud-shape--dark" style={{ top: c.top, width: c.width, height: c.height, filter: `blur(${c.blur}px)`, opacity: c.opacity, animationDuration: `${c.dur}s`, animationDelay: `${c.delay}s` }} />
            ))}
          </div>
        )
      default:
        return null
    }
  })()

  const advisoryOverlay = (() => {
    switch (advisory) {
      case 'heat':
        return (
          <div className="absolute inset-0 overflow-hidden" aria-hidden>
            {HEAT_WAVES.map((w) => (
              <div key={w.key} className="weather-heat-wave"
                style={{ bottom: w.bottom, animationDuration: `${w.dur}s`, animationDelay: `${w.delay}s` }} />
            ))}
          </div>
        )
      case 'smoke':
        return (
          <div className="absolute inset-0 overflow-hidden" aria-hidden>
            {SMOKE_LAYERS.map((l) => (
              <div key={l.key} className="weather-smoke-layer"
                style={{ top: l.top, height: l.height, animationDuration: l.dur, animationDelay: l.delay }} />
            ))}
          </div>
        )
      case 'wind':
        return (
          <div className="absolute inset-0 overflow-hidden" aria-hidden>
            {WIND_GUSTS.map((g) => (
              <div key={g.key} className="weather-wind-gust"
                style={{ top: `${g.top}%`, width: g.width, animationDuration: `${g.dur}s`, animationDelay: `${g.delay}s` }} />
            ))}
          </div>
        )
      case 'freeze':
        return (
          <div className="absolute inset-0 overflow-hidden weather-particle-container" aria-hidden>
            {FROST_CRYSTALS.map((c) => (
              <div key={c.key} className="weather-frost-crystal"
                style={{ left: `${c.left}%`, top: `${c.top}%`, width: c.size, height: c.size, animationDuration: `${c.dur}s`, animationDelay: `${c.delay}s` }} />
            ))}
          </div>
        )
      default:
        return null
    }
  })()

  if (!weatherBg && !advisoryOverlay) return null
  return <>{weatherBg}{advisoryOverlay}</>
}
