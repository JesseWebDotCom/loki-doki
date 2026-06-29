import { useEffect, useRef, useState } from 'react'
import { Ear, Volume2 } from 'lucide-react'
import { FlipClock } from '@/components/display/FlipClock'
import {
  FRAME_W, FRAME_H, CELL_W, CELL_H, GUTTER, spanOf, centerOffset, WEATHER_CATALOG, safeTheme,
  type WidgetPlacement, type ThemeTokens, type WeatherCondition,
} from '@/lib/pod/layout'

// Device-accurate preview: renders the SAME grid math + theme tokens the Tab5 uses,
// at the device's 1280×720 ratio, scaled to fit `width`. What you arrange here is what
// the tablet shows, because both consume the identical descriptor (§9.2).

interface Props {
  theme: ThemeTokens
  widgets: WidgetPlacement[]
  width?: number              // explicit px width; omit to fill the parent (responsive)
  weather?: WeatherCondition
  isNight?: boolean
  selectedIndex?: number      // highlight a widget in the editor
  onSelect?: (i: number) => void
  onSlotClick?: (row: number, col: number) => void
}

// Fills its parent's width by default (keeping the device's 16:9 ratio), measuring with
// a ResizeObserver so the preview always uses the whole column. Pass `width` to fix it.
export function DevicePreview(props: Props) {
  const { width } = props
  const ref = useRef<HTMLDivElement>(null)
  const [measured, setMeasured] = useState(0)
  useEffect(() => {
    if (width || !ref.current) return
    const el = ref.current
    const ro = new ResizeObserver(([e]) => { if (e) setMeasured(e.contentRect.width) })
    ro.observe(el)
    setMeasured(el.clientWidth)
    return () => ro.disconnect()
  }, [width])
  if (width) return <PreviewInner {...props} width={width} />
  return <div ref={ref} className="w-full">{measured > 0 && <PreviewInner {...props} width={measured} />}</div>
}

function PreviewInner({ theme: rawTheme, widgets, width = 448, weather = 'partly-cloudy', isNight = false, selectedIndex, onSelect, onSlotClick }: Props) {
  const theme = safeTheme(rawTheme)
  const scale = width / FRAME_W
  const height = FRAME_H * scale
  const fs = theme.font_scale || 1

  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/50 shadow-inner" style={{ width, height }}>
      <div style={{ width: FRAME_W, height: FRAME_H, transform: `scale(${scale})`, transformOrigin: 'top left', background: theme.bg, position: 'absolute', color: theme.text }}>
        {/* Empty-slot click targets (editor only) */}
        {onSlotClick && Array.from({ length: 9 }).map((_, i) => {
          const r = Math.floor(i / 3), c = i % 3
          return (
            <button
              key={`slot-${i}`}
              onClick={() => onSlotClick(r, c)}
              className="absolute rounded-xl border border-dashed border-white/10 transition-colors hover:border-white/30 hover:bg-white/5"
              style={{ left: c * CELL_W + GUTTER, top: r * CELL_H + GUTTER, width: CELL_W - GUTTER * 2, height: CELL_H - GUTTER * 2 }}
            />
          )
        })}

        {(() => { const off = onSlotClick ? { x: 0, y: 0 } : centerOffset(widgets); return widgets.map((w, i) => {
          const span = spanOf(w)
          const [r, c] = w.anchor
          const left = c * CELL_W + GUTTER + off.x
          const top = r * CELL_H + GUTTER + off.y
          const wpx = span.cols * CELL_W - GUTTER * 2
          const hpx = span.rows * CELL_H - GUTTER * 2
          const selected = selectedIndex === i
          return (
            <div
              key={i}
              onClick={(e) => { e.stopPropagation(); onSelect?.(i) }}
              className={`absolute flex items-center justify-center overflow-hidden rounded-2xl ${onSelect ? 'cursor-pointer' : ''}`}
              style={{
                left, top, width: wpx, height: hpx,
                background: w.type === 'weather' && (w.size === 'large' || w.size === 'full') ? (isNight ? WEATHER_CATALOG[weather].night : WEATHER_CATALOG[weather].day) : 'rgba(255,255,255,0.05)',
                outline: selected ? `3px solid ${theme.accent}` : '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <WidgetContent w={w} theme={theme} fs={fs} weather={weather} isNight={isNight} />
            </div>
          )
        }) })()}

        {/* Global voice controls: wake/listen (ear) bottom-left, mute the companion's
            voice (speaker) bottom-right — shown on every layout, like the device. */}
        <PreviewControl side="left" Icon={Ear} label="Tap to talk" accent={theme.accent} text={theme.text} fs={fs} />
        <PreviewControl side="right" Icon={Volume2} label="Sound on" accent={theme.accent} text={theme.text} fs={fs} />
      </div>
    </div>
  )
}

function WidgetContent({ w, theme, fs, weather, isNight }: { w: WidgetPlacement; theme: ThemeTokens; fs: number; weather: WeatherCondition; isNight: boolean }) {
  if (w.type === 'clock') return <ClockWidget size={w.size} fs={fs} text={theme.text} accent={theme.accent} />
  if (w.type === 'weather') return <WeatherWidget size={w.size} fs={fs} text={theme.text} weather={weather} isNight={isNight} />
  // mic/mute are global corner controls now (PreviewControl), not slot widgets.
  return null
}

// Static representation of a corner voice control in the preview (ear = wake-word,
// speaker = mute the companion's voice).
function PreviewControl({ side, Icon, label, accent, text, fs }: { side: 'left' | 'right'; Icon: typeof Ear; label: string; accent: string; text: string; fs: number }) {
  return (
    <div className="absolute flex flex-col items-center gap-2" style={{ [side]: 48, bottom: 28, color: text } as React.CSSProperties}>
      <span className="flex items-center justify-center rounded-full" style={{ width: 112, height: 112, background: side === 'left' ? accent : 'rgba(255,255,255,0.14)' }}>
        <Icon className="text-white" style={{ width: 56, height: 56 }} />
      </span>
      <span style={{ fontSize: 24 * fs, opacity: 0.85 }}>{label}</span>
    </div>
  )
}

function ClockWidget({ size, fs, text, accent }: { size: WidgetPlacement['size']; fs: number; text: string; accent: string }) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t) }, [])
  const hh = ((now.getHours() % 12) || 12).toString()
  const mm = now.getMinutes().toString().padStart(2, '0')
  const ss = now.getSeconds().toString().padStart(2, '0')
  const ampm = now.getHours() < 12 ? 'AM' : 'PM'
  const day = now.toLocaleDateString(undefined, { weekday: 'long' })
  const date = now.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })
  // 'full' → big, dead-centre flip clock (the ambient flip-clock look).
  if (size === 'full') {
    // Match DeviceLayoutDisplay: 170px keeps the ~6em-wide flip clock on the 1280px panel.
    return (
      <div className="flex h-full w-full flex-col items-center justify-center overflow-hidden" style={{ color: text }}>
        <FlipClock hh={hh.padStart(2, '0')} mm={mm} ampm={ampm} style={{ fontSize: 170 * fs }} />
        <div style={{ fontSize: 44 * fs, opacity: 0.85, marginTop: 24 }}>{day}, {date}</div>
      </div>
    )
  }
  const big = size === 'large' ? 150 : size === 'medium' ? 96 : 60
  return (
    <div className="flex flex-col items-center" style={{ color: text }}>
      <div className="font-semibold tabular-nums" style={{ fontSize: big * fs, lineHeight: 1 }}>
        {hh}:{mm}{size === 'large' && <span style={{ fontSize: big * 0.4 * fs, color: accent }}>:{ss}</span>}
        {size !== 'small' && <span style={{ fontSize: big * 0.3 * fs, marginLeft: 12, opacity: 0.7 }}>{ampm}</span>}
      </div>
      {size === 'large' && <div style={{ fontSize: 40 * fs, opacity: 0.85, marginTop: 12 }}>{day}, {date}</div>}
      {size === 'medium' && <div style={{ fontSize: 30 * fs, opacity: 0.8, marginTop: 8 }}>{date}</div>}
    </div>
  )
}

function WeatherWidget({ size, fs, text, weather, isNight }: { size: WidgetPlacement['size']; fs: number; text: string; weather: WeatherCondition; isNight: boolean }) {
  const v = WEATHER_CATALOG[weather]
  const temp = '41°'
  const glyph = isNight ? '🌙' : '☀️'
  if (size === 'small') return <div className="flex flex-col items-center" style={{ color: text }}><span style={{ fontSize: 64 }}>{glyph}</span><span style={{ fontSize: 40 * fs }}>{temp}</span></div>
  // Full = big icon centered with the temp to its RIGHT, forecast + area underneath,
  // and a little clock in the bottom-left corner.
  if (size === 'full') {
    const now = new Date()
    const hhmm = `${((now.getHours() % 12) || 12)}:${now.getMinutes().toString().padStart(2, '0')}`
    return (
      <div className="relative h-full w-full" style={{ color: text }}>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="flex items-center justify-center" style={{ gap: 8 }}>
            <span style={{ fontSize: 300 }}>{glyph}</span>
            <span className="font-black tabular-nums" style={{ fontSize: 200 * fs, lineHeight: 1 }}>{temp}</span>
          </div>
          <span style={{ fontSize: 52 * fs, opacity: 0.9, marginTop: 4 }}>{v.label}</span>
          <span style={{ fontSize: 32 * fs, opacity: 0.65, marginTop: 6 }}>Milford, Connecticut</span>
        </div>
        <div className="absolute font-semibold tabular-nums" style={{ left: 40, top: 24, fontSize: 64 * fs }}>{hhmm}<span style={{ fontSize: 26 * fs, opacity: 0.7, marginLeft: 8 }}>{now.getHours() < 12 ? 'AM' : 'PM'}</span></div>
      </div>
    )
  }
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1" style={{ color: text }}>
      <span style={{ fontSize: size === 'large' ? 220 : 210 }}>{glyph}</span>
      <span className="font-semibold" style={{ fontSize: (size === 'large' ? 118 : 116) * fs, lineHeight: 1.05 }}>{temp}</span>
      <span style={{ fontSize: (size === 'large' ? 40 : 38) * fs, opacity: 0.85 }}>{v.label}</span>
      {size === 'large' && <span style={{ fontSize: 26 * fs, opacity: 0.7 }}>H:47°  L:38°</span>}
    </div>
  )
}
