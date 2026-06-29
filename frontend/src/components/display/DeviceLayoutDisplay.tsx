import { useEffect, useRef, useState } from 'react'
import { Ear, Volume2, VolumeX } from 'lucide-react'
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
                <SlotWidget w={w} theme={theme} />
              </div>
            )
          })}
          {/* Global voice controls on every layout: wake/listen (ear) bottom-left,
              mute the companion's voice (speaker) bottom-right. */}
          <VoiceControls theme={theme} isDeviceRender={isDeviceRender}
            voiceOn={voiceOn} handsFreeOn={handsFreeOn} onToggleVoice={onToggleVoice} onToggleHandsFree={onToggleHandsFree} />
        </div>
        )
      })()}
    </div>
  )
}

function SlotWidget({ w, theme }: { w: WidgetPlacement; theme: ThemeTokens }) {
  if (w.type === 'clock') return <LiveClock size={w.size} theme={theme} />
  if (w.type === 'weather') return <LiveWeather size={w.size} theme={theme} />
  // mic/mute are no longer slot widgets — they're global corner controls (VoiceControls).
  return null
}

// Wake-word (ear, bottom-left) + companion-voice mute (speaker, bottom-right) controls,
// drawn on every layout. On a browser they toggle the shared companion state; on the
// device render they're visual (the firmware's corner taps drive the real toggles).
function VoiceControls({ theme, isDeviceRender, voiceOn, handsFreeOn, onToggleVoice, onToggleHandsFree }: {
  theme: ThemeTokens; isDeviceRender: boolean
  voiceOn: boolean; handsFreeOn: boolean; onToggleVoice: () => void; onToggleHandsFree: () => void
}) {
  const fs = theme.font_scale
  // On the device render the firmware owns the live state, so show neutral affordances.
  const hf = isDeviceRender ? false : handsFreeOn
  const vo = isDeviceRender ? true : voiceOn
  const Btn = ({ side, Icon, active, label, onClick }: { side: 'left' | 'right'; Icon: typeof Ear; active: boolean; label: string; onClick: () => void }) => (
    <button
      onClick={isDeviceRender ? undefined : onClick}
      disabled={isDeviceRender}
      className="absolute flex flex-col items-center gap-2"
      style={{ [side]: 48, bottom: 28, color: theme.text, cursor: isDeviceRender ? 'default' : 'pointer' } as React.CSSProperties}
    >
      <span className="flex items-center justify-center rounded-full" style={{ width: 112, height: 112, background: active ? theme.accent : 'rgba(255,255,255,0.14)' }}>
        <Icon style={{ width: 56, height: 56 }} className="text-white" />
      </span>
      <span style={{ fontSize: 24 * fs, opacity: 0.85 }}>{label}</span>
    </button>
  )
  return (
    <>
      <Btn side="left" Icon={Ear} active={hf} label={hf ? 'Listening' : 'Tap to talk'} onClick={onToggleHandsFree} />
      <Btn side="right" Icon={vo ? Volume2 : VolumeX} active={!vo} label={vo ? 'Voice reply' : 'Text only'} onClick={onToggleVoice} />
    </>
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
        <FlipClock hh={hh} mm={mm} ampm={ampm || undefined} style={{ fontSize: 170 * fs }} />
        <div style={{ fontSize: 44 * fs, opacity: 0.85, marginTop: 24 }}>{day}, {date}</div>
      </div>
    )
  }
  const big = (size === 'large' ? 188 : size === 'medium' ? 96 : 60) * fs
  return (
    <div className="flex h-full w-full flex-col items-center justify-center" style={{ color: theme.text }}>
      <div className="flex items-end leading-none" style={{ fontSize: big }}>
        <span className="font-black tabular-nums">{hh}:{mm}</span>
        {size === 'large' ? (
          // Seconds stacked ABOVE the AM/PM, to the right of the time.
          <div className="flex flex-col items-start leading-none" style={{ marginLeft: 16, marginBottom: big * 0.05 }}>
            <span className="font-black tabular-nums" style={{ fontSize: big * 0.34, color: theme.accent }}>:{ss}</span>
            {ampm && <span style={{ fontSize: big * 0.3, opacity: 0.7, marginTop: 6 }}>{ampm}</span>}
          </div>
        ) : (
          size === 'medium' && ampm && <span style={{ fontSize: big * 0.28, opacity: 0.7, marginLeft: 12, marginBottom: big * 0.08 }}>{ampm}</span>
        )}
      </div>
      {size === 'large' && <div style={{ fontSize: 40 * fs, opacity: 0.85, marginTop: 14 }}>{day}, {date}</div>}
      {size === 'medium' && <div style={{ fontSize: 30 * fs, opacity: 0.8, marginTop: 8 }}>{date}</div>}
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
  const isz = big ? 460 : size === 'large' ? 230 : size === 'medium' ? 230 : 90
  const icon = <img src={weatherIconSrc(snapshot!.info.icon)} alt="" style={{ width: isz, height: isz }} />
  // Full-screen weather: the big icon (sun/cloud/…) centered with the temperature to its
  // RIGHT, the forecast + area underneath, and a little clock in the top-left corner.
  if (big) {
    return (
      <div className="relative h-full w-full" style={{ background: showBg ? heroBackground(gradient, isDay) : 'rgba(255,255,255,0.05)' }}>
        {showBg && <WeatherHeroBg gradient={gradient} isDay={isDay} advisory={getAdvisoryEffect(snapshot!.alerts)} />}
        <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ color: theme.text }}>
          <div className="flex items-center justify-center" style={{ gap: 8 }}>
            {icon}
            <span className="font-black tabular-nums" style={{ fontSize: 200 * fs, lineHeight: 1 }}>{snapshot!.temp}°</span>
          </div>
          <span style={{ fontSize: 52 * fs, opacity: 0.9, marginTop: 4 }}>{snapshot!.info.desc}</span>
          <span style={{ fontSize: 32 * fs, opacity: 0.65, marginTop: 6 }}>{snapshot!.location}</span>
        </div>
        <FullWeatherClock theme={theme} />
      </div>
    )
  }
  // Small = compact icon+temp; medium/large = stacked but noticeably larger.
  return wrap(
    <>
      {icon}
      <span className="font-black tabular-nums" style={{ fontSize: (size === 'large' ? 118 : size === 'medium' ? 116 : 44) * fs, lineHeight: 1.05 }}>{snapshot!.temp}°</span>
      {size !== 'small' && <span style={{ fontSize: (size === 'large' ? 40 : 38) * fs, opacity: 0.85, marginTop: 4 }}>{snapshot!.info.desc}</span>}
      {size === 'large' && <span style={{ fontSize: 26 * fs, opacity: 0.65 }}>{snapshot!.location}</span>}
    </>,
  )
}
