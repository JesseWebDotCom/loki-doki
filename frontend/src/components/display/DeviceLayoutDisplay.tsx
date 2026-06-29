import { useEffect, useRef, useState } from 'react'
import { useNow } from '@/hooks/useNow'
import { useWeatherSnapshot } from '@/hooks/useWeatherSnapshot'
import { WeatherHeroBg } from '@/components/weather/WeatherHeroBg'
import { FlipClock } from '@/components/display/FlipClock'
import { heroBackground, weatherIconSrc, getAdvisoryEffect, type HeroGradient } from '@/lib/weather'
import { clockParts, type HomeDisplayConfig } from '@/lib/homeDisplay'
import {
  FRAME_W, FRAME_H, CELL_W, CELL_H, GUTTER, spanOf, footprint, contentFit, safeTheme,
  type WidgetPlacement, type ThemeTokens,
} from '@/lib/pod/layout'

// The LIVE slot-based ambient display for a screen device. Renders the SAME descriptor
// (theme + widgets) the device gets, but with REAL clock + REAL weather — this is the
// page the server screenshots into a JPEG for the firmware (one unified path: the
// admin Layouts editor and the device both consume the same descriptor).

export interface Descriptor {
  theme: ThemeTokens
  widgets: WidgetPlacement[]
}

interface Props {
  descriptor: Descriptor
  isDeviceRender: boolean
  voiceOn: boolean
  handsFreeOn: boolean
  onToggleVoice: () => void
  onToggleHandsFree: () => void
}

export function DeviceLayoutDisplay({ descriptor }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => { if (e) setBox({ w: e.contentRect.width, h: e.contentRect.height }) })
    ro.observe(el)
    setBox({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])
  // Contain the 16:9 frame within the box (letterbox if the panel ratio differs).
  const scale = box.w > 0 ? Math.min(box.w / FRAME_W, box.h / FRAME_H) : 0
  const theme = safeTheme(descriptor.theme)

  return (
    <div ref={ref} className="absolute inset-0 flex items-center justify-center overflow-hidden" style={{ background: theme.bg }}>
      {/* Voice controls + status/Stop are drawn NATIVELY by the firmware (bottom row) —
          not part of this server image. */}
      {scale > 0 && (
        <div style={{ transform: `scale(${scale})`, transformOrigin: 'center' }}>
          <LayoutContent descriptor={descriptor} />
        </div>
      )}
    </div>
  )
}

// The EXACT 1280×720 content the device renders (theme background + full-height weather
// backdrop + fitted widgets). Exported so the admin preview renders through the SAME
// code — the preview and the device can never drift apart.
export function LayoutContent({ descriptor }: { descriptor: Descriptor }) {
  const theme = safeTheme(descriptor.theme)
  const fit = contentFit(descriptor.widgets)
  return (
    <div style={{ width: FRAME_W, height: FRAME_H, position: 'relative', color: theme.text, background: theme.bg }}>
      <WeatherBackdrop widgets={descriptor.widgets} />
      <div style={{ position: 'absolute', inset: 0, transform: `translate(${fit.tx}px, ${fit.ty}px) scale(${fit.scale})`, transformOrigin: `${fit.ox}px ${fit.oy}px` }}>
        {descriptor.widgets.map((w, i) => {
          const span = spanOf(w)
          const [r, c] = w.anchor
          return (
            <div key={i} className="absolute overflow-hidden rounded-3xl" style={{
              left: c * CELL_W + GUTTER, top: r * CELL_H + GUTTER,
              width: span.cols * CELL_W - GUTTER * 2, height: span.rows * CELL_H - GUTTER * 2,
            }}>
              <SlotWidget w={w} theme={theme} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function SlotWidget({ w, theme }: { w: WidgetPlacement; theme: ThemeTokens }) {
  if (w.type === 'clock') return <LiveClock size={w.size} theme={theme} />
  if (w.type === 'weather') return <LiveWeather size={w.size} theme={theme} bg={!!w.bg} />
  // mic/mute are no longer slot widgets — they're global corner controls (VoiceControls).
  return null
}

// Recommended apparel for the conditions — shown (instead of the icon) when the live
// weather sky is the background, since the sky already conveys the condition.
function apparelFor(gradient: HeroGradient, temp: number, isDay: boolean): string[] {
  const out: string[] = []
  if (gradient === 'rain' || gradient === 'drizzle' || gradient === 'storm') out.push('☂️')
  if (gradient === 'snow') out.push('🧣')
  if (temp <= 50) out.push('🧥')                                   // coat — cold
  if ((gradient === 'clear-day' || gradient === 'partly-cloudy') && isDay && temp >= 62) out.push('🕶️')
  if (!out.length) out.push('👕')                                   // mild & dry → just a tee
  return [...new Set(out)]
}

// Live weather sky painted FULL-HEIGHT behind the column(s) of a weather widget that
// opted in (bg: true) — so it reaches top-to-bottom incl. behind the bottom controls,
// not just the scaled content band. Weather widgets themselves render transparent.
function WeatherBackdrop({ widgets }: { widgets: WidgetPlacement[] }) {
  const { snapshot, status } = useWeatherSnapshot()
  const bgW = widgets.find((w) => w.type === 'weather' && w.bg)
  if (!bgW || status !== 'ready' || !snapshot) return null
  const cols = footprint(bgW).map(([, c]) => c)
  const minC = Math.min(...cols), maxC = Math.max(...cols)
  const left = minC * CELL_W, width = (maxC - minC + 1) * CELL_W
  const gradient: HeroGradient = snapshot.info.gradient ?? 'clear-night'
  const isDay = snapshot.isDay ?? false
  return (
    <div style={{ position: 'absolute', left, top: 0, width, height: FRAME_H, overflow: 'hidden', background: heroBackground(gradient, isDay) }}>
      <WeatherHeroBg gradient={gradient} isDay={isDay} advisory={getAdvisoryEffect(snapshot.alerts)} />
    </div>
  )
}

function LiveClock({ size, theme }: { size: WidgetPlacement['size']; theme: ThemeTokens }) {
  const now = useNow(1000)
  const d = new Date(now)
  const cfg: HomeDisplayConfig = { clock: true, clockStyle: 'digital', showSeconds: size === 'large', hour24: false, date: true, weather: false, weatherBackground: false }
  const { hh, mm, ss, ampm } = clockParts(d, cfg)
  const fs = theme.font_scale
  const day = d.toLocaleDateString(undefined, { weekday: 'long' })
  const date = d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })
  // 'full' → a big, dead-centre flip clock filling the screen.
  if (size === 'full') {
    // ~6em wide (4 digits + colon + AM/PM); 170px keeps it on the 1280px panel.
    return (
      <div className="flex h-full w-full flex-col items-center justify-center overflow-hidden" style={{ color: theme.text }}>
        <FlipClock hh={hh} mm={mm} ampm={ampm || undefined} style={{ fontSize: 300 * fs }} />
        <div style={{ fontSize: 60 * fs, opacity: 0.85, marginTop: 24 }}>{day}, {date}</div>
      </div>
    )
  }
  const big = (size === 'large' ? 188 : size === 'medium' ? 96 : 60) * fs
  // The TIME is centred on the cell midline (the date floats below) so it lines up
  // vertically with the weather temp, which is centred the same way.
  return (
    <div className="relative h-full w-full" style={{ color: theme.text }}>
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex items-end leading-none" style={{ fontSize: big }}>
          <span className="font-black tabular-nums">{hh}:{mm}</span>
          {size === 'large' ? (
            <div className="flex flex-col items-start leading-none" style={{ marginLeft: 16, marginBottom: big * 0.05 }}>
              <span className="font-black tabular-nums" style={{ fontSize: big * 0.34, color: theme.accent }}>:{ss}</span>
              {ampm && <span style={{ fontSize: big * 0.3, opacity: 0.7, marginTop: 6 }}>{ampm}</span>}
            </div>
          ) : (
            size === 'medium' && ampm && <span style={{ fontSize: big * 0.28, opacity: 0.7, marginLeft: 12, marginBottom: big * 0.08 }}>{ampm}</span>
          )}
        </div>
      </div>
      <div className="absolute inset-x-0 flex justify-center" style={{ bottom: '13%', fontSize: (size === 'medium' ? 30 : 40) * fs, opacity: 0.82 }}>{day}, {date}</div>
    </div>
  )
}

// Small clock in the TOP-left of the full weather screen (the bottom corners are
// reserved for the global wake/mute controls).
function FullWeatherClock({ theme }: { theme: ThemeTokens }) {
  const now = useNow(1000)
  const cfg: HomeDisplayConfig = { clock: true, clockStyle: 'digital', showSeconds: false, hour24: false, date: false, weather: false, weatherBackground: false }
  const { hh, mm, ampm } = clockParts(new Date(now), cfg)
  return (
    <div className="absolute flex items-baseline gap-2 font-semibold tabular-nums" style={{ left: 40, top: 28, color: theme.text }}>
      <span style={{ fontSize: 64 * theme.font_scale, lineHeight: 1 }}>{hh}:{mm}</span>
      {ampm && <span style={{ fontSize: 26 * theme.font_scale, opacity: 0.7 }}>{ampm}</span>}
    </div>
  )
}

function LiveWeather({ size, theme, bg }: { size: WidgetPlacement['size']; theme: ThemeTokens; bg?: boolean }) {
  const { snapshot, status } = useWeatherSnapshot()
  const ready = status === 'ready' && !!snapshot
  const fs = theme.font_scale
  const big = size === 'full'
  // Content only — any weather background is painted full-height by <WeatherBackdrop/>.
  if (!ready) return <div className="flex h-full w-full items-center justify-center" style={{ color: theme.text, opacity: 0.5 }}>—</div>
  // When the sky background is showing we drop the icon (the sky conveys the condition)
  // and show recommended apparel under the description instead.
  const apparel = bg ? apparelFor(snapshot!.info.gradient, snapshot!.temp, snapshot!.isDay) : []
  const isz = big ? 470 : size === 'large' ? 240 : size === 'medium' ? 230 : 90
  const icon = <img src={weatherIconSrc(snapshot!.info.icon)} alt="" style={{ width: isz, height: isz }} />
  if (big) {
    return (
      <div className="relative h-full w-full" style={{ color: theme.text }}>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="flex items-center justify-center" style={{ gap: 8 }}>
            {!bg && icon}
            <span className="font-black tabular-nums" style={{ fontSize: 260 * fs, lineHeight: 1 }}>{snapshot!.temp}°</span>
          </div>
          <span style={{ fontSize: 60 * fs, opacity: 0.92, marginTop: 4 }}>{snapshot!.info.desc}</span>
          {bg && <div className="flex items-center justify-center" style={{ gap: 18, fontSize: 76 * fs, marginTop: 10 }}>{apparel.map((a, i) => <span key={i}>{a}</span>)}</div>}
          <span style={{ fontSize: 36 * fs, opacity: 0.7, marginTop: 10 }}>{snapshot!.location}</span>
        </div>
        <FullWeatherClock theme={theme} />
      </div>
    )
  }
  const tempFont = (size === 'large' ? 132 : size === 'medium' ? 128 : 44) * fs
  // With the sky background (Clock and Weather): centre the TEMP on the cell midline so
  // it lines up with the clock time; description + apparel float below.
  if (bg) {
    return (
      <div className="relative h-full w-full" style={{ color: theme.text }}>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="font-black tabular-nums" style={{ fontSize: tempFont, lineHeight: 1 }}>{snapshot!.temp}°</span>
        </div>
        <div className="absolute inset-x-0 flex flex-col items-center" style={{ bottom: '12%', gap: 8 }}>
          <span style={{ fontSize: 40 * fs, opacity: 0.88 }}>{snapshot!.info.desc}</span>
          <div className="flex items-center justify-center" style={{ gap: 14, fontSize: 58 * fs }}>{apparel.map((a, i) => <span key={i}>{a}</span>)}</div>
        </div>
      </div>
    )
  }
  return (
    <div className="flex h-full w-full flex-col items-center justify-center" style={{ color: theme.text }}>
      {icon}
      <span className="font-black tabular-nums" style={{ fontSize: tempFont, lineHeight: 1.05 }}>{snapshot!.temp}°</span>
      {size !== 'small' && <span style={{ fontSize: (size === 'large' ? 44 : 40) * fs, opacity: 0.88, marginTop: 4 }}>{snapshot!.info.desc}</span>}
      {size === 'large' && <span style={{ fontSize: 28 * fs, opacity: 0.65 }}>{snapshot!.location}</span>}
    </div>
  )
}
