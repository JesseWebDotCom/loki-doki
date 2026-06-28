import { useEffect, useRef, useState } from 'react'
import { Mic, MicOff, Volume2, VolumeX } from 'lucide-react'
import { useNow } from '@/hooks/useNow'
import { useWeatherSnapshot } from '@/hooks/useWeatherSnapshot'
import { WeatherHeroBg } from '@/components/weather/WeatherHeroBg'
import { FlipClock } from '@/components/display/FlipClock'
import { heroBackground, weatherIconSrc, getAdvisoryEffect, type HeroGradient } from '@/lib/weather'
import { clockParts, type HomeDisplayConfig } from '@/lib/homeDisplay'
import {
  FRAME_W, FRAME_H, CELL_W, CELL_H, GUTTER, spanOf, centerOffset, safeTheme,
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

export function DeviceLayoutDisplay({ descriptor, isDeviceRender, voiceOn, handsFreeOn, onToggleVoice, onToggleHandsFree }: Props) {
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
      {scale > 0 && (() => {
        // Centre the occupied widgets in the frame so a layout that doesn't fill all 9
        // cells reads as intentional instead of leaving a blank bottom row / right column.
        const off = centerOffset(descriptor.widgets)
        return (
        <div style={{ width: FRAME_W, height: FRAME_H, transform: `scale(${scale})`, transformOrigin: 'center', position: 'relative', color: theme.text }}>
          {descriptor.widgets.map((w, i) => {
            const span = spanOf(w)
            const [r, c] = w.anchor
            return (
              <div key={i} className="absolute overflow-hidden rounded-3xl" style={{
                left: c * CELL_W + GUTTER + off.x, top: r * CELL_H + GUTTER + off.y,
                width: span.cols * CELL_W - GUTTER * 2, height: span.rows * CELL_H - GUTTER * 2,
              }}>
                <SlotWidget w={w} theme={theme} isDeviceRender={isDeviceRender}
                  voiceOn={voiceOn} handsFreeOn={handsFreeOn} onToggleVoice={onToggleVoice} onToggleHandsFree={onToggleHandsFree} />
              </div>
            )
          })}
        </div>
        )
      })()}
    </div>
  )
}

function SlotWidget({ w, theme, isDeviceRender, voiceOn, handsFreeOn, onToggleVoice, onToggleHandsFree }: {
  w: WidgetPlacement; theme: ThemeTokens; isDeviceRender: boolean
  voiceOn: boolean; handsFreeOn: boolean; onToggleVoice: () => void; onToggleHandsFree: () => void
}) {
  if (w.type === 'clock') return <LiveClock size={w.size} theme={theme} />
  if (w.type === 'weather') return <LiveWeather size={w.size} theme={theme} />
  // mic / mute — interactive for browser viewers; static on the device render (the
  // firmware draws its own native, touchable buttons over the JPEG).
  const isMic = w.type === 'mic'
  const active = isMic ? handsFreeOn : voiceOn
  const ActiveIcon = isMic ? Mic : Volume2
  const InactiveIcon = isMic ? MicOff : VolumeX
  const Icon = active ? ActiveIcon : InactiveIcon
  const onClick = isDeviceRender ? undefined : (isMic ? onToggleHandsFree : onToggleVoice)
  return (
    <button onClick={onClick} disabled={isDeviceRender} className="flex h-full w-full flex-col items-center justify-center gap-3"
      style={{ color: theme.text, cursor: isDeviceRender ? 'default' : 'pointer' }}>
      <span className="flex items-center justify-center rounded-full" style={{ width: 110, height: 110, background: active ? theme.accent : 'rgba(255,255,255,0.12)' }}>
        <Icon style={{ width: 54, height: 54 }} className="text-white" />
      </span>
      <span style={{ fontSize: 26 * theme.font_scale, opacity: 0.8 }}>{isMic ? (handsFreeOn ? 'Listening' : 'Tap to talk') : (voiceOn ? 'Sound on' : 'Muted')}</span>
    </button>
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
    // The flip clock is ~6em wide (4 digits + colon + AM/PM); at the old 230px it ran
    // ~1380px and clipped the 1280px panel. 170px keeps it ~1020px — fully on screen.
    return (
      <div className="flex h-full w-full flex-col items-center justify-center overflow-hidden" style={{ color: theme.text }}>
        <FlipClock hh={hh} mm={mm} ampm={ampm || undefined} style={{ fontSize: 170 * fs }} />
        <div style={{ fontSize: 44 * fs, opacity: 0.85, marginTop: 24 }}>{day}, {date}</div>
      </div>
    )
  }
  const big = (size === 'large' ? 150 : size === 'medium' ? 96 : 60) * fs
  return (
    <div className="flex h-full w-full flex-col items-center justify-center" style={{ color: theme.text }}>
      <div className="flex items-end font-black tabular-nums leading-none" style={{ fontSize: big }}>
        <span>{hh}:{mm}</span>
        {size === 'large' && <span style={{ fontSize: big * 0.4, color: theme.accent, marginLeft: 8 }}>:{ss}</span>}
        {size !== 'small' && ampm && <span style={{ fontSize: big * 0.28, opacity: 0.7, marginLeft: 12, marginBottom: big * 0.08 }}>{ampm}</span>}
      </div>
      {size === 'large' && <div style={{ fontSize: 40 * fs, opacity: 0.85, marginTop: 14 }}>{day}, {date}</div>}
      {size === 'medium' && <div style={{ fontSize: 30 * fs, opacity: 0.8, marginTop: 8 }}>{date}</div>}
    </div>
  )
}

function LiveWeather({ size, theme }: { size: WidgetPlacement['size']; theme: ThemeTokens }) {
  const { snapshot, status } = useWeatherSnapshot()
  const ready = status === 'ready' && !!snapshot
  const gradient: HeroGradient = snapshot?.info.gradient ?? 'clear-night'
  const isDay = snapshot?.isDay ?? false
  const fs = theme.font_scale
  const big = size === 'full'
  const showBg = (size === 'large' || big) && ready
  const wrap = (kids: React.ReactNode) => (
    <div className="relative h-full w-full" style={{ background: showBg ? heroBackground(gradient, isDay) : 'rgba(255,255,255,0.05)' }}>
      {showBg && <WeatherHeroBg gradient={gradient} isDay={isDay} advisory={getAdvisoryEffect(snapshot!.alerts)} />}
      <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ color: theme.text }}>{kids}</div>
    </div>
  )
  if (!ready) return wrap(<span style={{ opacity: 0.5 }}>—</span>)
  const isz = big ? 360 : size === 'large' ? 190 : size === 'medium' ? 170 : 90
  const icon = <img src={weatherIconSrc(snapshot!.info.icon)} alt="" style={{ width: isz, height: isz }} />
  // Full-screen weather: big sun/icon to the LEFT of a big temperature, condition below.
  if (big) {
    return wrap(
      <>
        <div className="flex items-center justify-center" style={{ gap: 24 }}>
          {icon}
          <span className="font-black tabular-nums" style={{ fontSize: 220 * fs, lineHeight: 1 }}>{snapshot!.temp}°</span>
        </div>
        <span style={{ fontSize: 56 * fs, opacity: 0.9, marginTop: 8 }}>{snapshot!.info.desc}</span>
        <span style={{ fontSize: 34 * fs, opacity: 0.65, marginTop: 6 }}>{snapshot!.location}</span>
      </>,
    )
  }
  // Small = compact icon+temp; medium/large = stacked but noticeably larger.
  return wrap(
    <>
      {icon}
      <span className="font-black tabular-nums" style={{ fontSize: (size === 'large' ? 96 : size === 'medium' ? 84 : 44) * fs, lineHeight: 1.05 }}>{snapshot!.temp}°</span>
      {size !== 'small' && <span style={{ fontSize: (size === 'large' ? 36 : 34) * fs, opacity: 0.85, marginTop: 4 }}>{snapshot!.info.desc}</span>}
      {size === 'large' && <span style={{ fontSize: 26 * fs, opacity: 0.65 }}>{snapshot!.location}</span>}
    </>,
  )
}
