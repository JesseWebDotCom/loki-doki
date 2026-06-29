import { useEffect, useRef, useState } from 'react'
import { Mic, Volume2 } from 'lucide-react'
import { LayoutContent } from '@/components/display/DeviceLayoutDisplay'
import {
  FRAME_W, FRAME_H, CELL_W, CELL_H, GUTTER, spanOf, safeTheme,
  type WidgetPlacement, type ThemeTokens, type WeatherCondition,
} from '@/lib/pod/layout'

// Device-accurate preview: renders through the SAME <LayoutContent/> the Tab5 shows, so
// the preview can NEVER drift from the device. The bottom controls are static
// representations (the firmware draws them natively on the device).

interface Props {
  theme: ThemeTokens
  widgets: WidgetPlacement[]
  width?: number              // explicit px width; omit to fill the parent (responsive)
  weather?: WeatherCondition  // (accepted for compatibility; the preview uses live weather)
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

function PreviewInner({ theme: rawTheme, widgets, width = 448, selectedIndex, onSelect, onSlotClick }: Props) {
  const theme = safeTheme(rawTheme)
  const scale = width / FRAME_W
  const height = FRAME_H * scale
  const fs = theme.font_scale || 1

  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/50 shadow-inner" style={{ width, height }}>
      <div style={{ width: FRAME_W, height: FRAME_H, transform: `scale(${scale})`, transformOrigin: 'top left', position: 'absolute' }}>
        {/* The EXACT device content — same component the Tab5 renders. */}
        <LayoutContent descriptor={{ theme, widgets }} />

        {/* Editor: empty-slot click targets for placement + per-widget select overlay. */}
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
        {onSelect && widgets.map((w, i) => {
          const span = spanOf(w)
          const [r, c] = w.anchor
          return (
            <button
              key={`sel-${i}`}
              onClick={(e) => { e.stopPropagation(); onSelect(i) }}
              className="absolute rounded-2xl"
              style={{
                left: c * CELL_W + GUTTER, top: r * CELL_H + GUTTER,
                width: span.cols * CELL_W - GUTTER * 2, height: span.rows * CELL_H - GUTTER * 2,
                outline: selectedIndex === i ? `3px solid ${theme.accent}` : '1px solid rgba(255,255,255,0.07)',
                background: 'transparent',
              }}
            />
          )
        })}

        {/* Bottom controls — static representations (native on the device). The mic
            doubles as Stop during a turn; the centre pill shows the conversation status. */}
        <PreviewControl side="left" Icon={Mic} label="Listening" accent={theme.accent} text={theme.text} fs={fs} />
        <PreviewControl side="right" Icon={Volume2} label="Sound on" accent={theme.accent} text={theme.text} fs={fs} />
        <div className="absolute flex items-center justify-center rounded-full text-white"
          style={{ left: '50%', transform: 'translateX(-50%)', bottom: 34, height: 76, padding: '0 28px', background: '#16A34A', fontSize: 26 * fs }}>
          Listening
        </div>
      </div>
    </div>
  )
}

// Static representation of a corner control (mic left, audio right).
function PreviewControl({ side, Icon, label, accent, text, fs }: { side: 'left' | 'right'; Icon: typeof Mic; label: string; accent: string; text: string; fs: number }) {
  return (
    <div className="absolute flex flex-col items-center gap-2" style={{ [side]: 48, bottom: 28, color: text } as React.CSSProperties}>
      <span className="flex items-center justify-center rounded-full" style={{ width: 112, height: 112, background: accent }}>
        <Icon className="text-white" style={{ width: 56, height: 56 }} />
      </span>
      <span style={{ fontSize: 24 * fs, opacity: 0.85 }}>{label}</span>
    </div>
  )
}
