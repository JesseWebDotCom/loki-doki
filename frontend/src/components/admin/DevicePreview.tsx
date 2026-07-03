import React, { useEffect, useRef, useState } from 'react'
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
  orientation?: number        // 0|90|180|270 — repositions the native control row
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

// Where the native control row sits for each orientation (it lives at the physical
// bottom of the panel; the firmware moves it via lv_disp_set_rotation).
type ControlEdge = 'bottom' | 'top' | 'left' | 'right'
function controlEdge(orientation: number): ControlEdge {
  if (orientation === 180) return 'top'
  if (orientation === 90)  return 'right'
  if (orientation === 270) return 'left'
  return 'bottom'
}

function PreviewInner({ theme: rawTheme, widgets, width = 448, orientation = 0, selectedIndex, onSelect, onSlotClick }: Props) {
  const theme = safeTheme(rawTheme)
  const scale = width / FRAME_W
  const height = FRAME_H * scale
  const fs = theme.font_scale || 1
  const edge = controlEdge(orientation)
  const isHoriz = edge === 'top' || edge === 'bottom'

  // Positions for the native control row representation.
  // Portrait orientations (90/270) place the control strip on the left/right edge.
  const edgeInset = 28
  const pillPos: React.CSSProperties = isHoriz
    ? { [edge]: 34, left: '50%', transform: 'translateX(-50%)' }
    : { [edge]: 34, top: '50%', transform: 'translateY(-50%)' }
  const iconPos1 = isHoriz
    ? { [edge]: edgeInset, left: 48 } as React.CSSProperties
    : { [edge]: edgeInset, top: 48 } as React.CSSProperties
  const iconPos2 = isHoriz
    ? { [edge]: edgeInset, right: 48 } as React.CSSProperties
    : { [edge]: edgeInset, bottom: 48 } as React.CSSProperties

  return (
    <div className="relative overflow-hidden rounded-card border border-border/50 shadow-inner" style={{ width, height }}>
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
              // design-ok(glass-on-plain-bg): empty-slot hover highlight over the live device preview canvas (artwork/widgets), not a plain page background
              className="absolute rounded-control border border-dashed border-white/10 transition-colors hover:border-white/30 hover:bg-white/5"
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
              className="absolute rounded-card"
              style={{
                left: c * CELL_W + GUTTER, top: r * CELL_H + GUTTER,
                width: span.cols * CELL_W - GUTTER * 2, height: span.rows * CELL_H - GUTTER * 2,
                outline: selectedIndex === i ? `3px solid ${theme.accent}` : '1px solid rgba(255,255,255,0.07)',
                background: 'transparent',
              }}
            />
          )
        })}

        {/* Native control row — static representation of the firmware-drawn mic / audio
            buttons + status pill. Position follows the orientation: the firmware moves
            these via lv_disp_set_rotation() when we push the display.orientation event. */}
        <div className="absolute" style={{ ...iconPos1, color: theme.text }}>
          <span className="flex flex-col items-center gap-2">
            <span className="flex items-center justify-center rounded-full" style={{ width: 112, height: 112, background: theme.accent }}>
              <Mic className="text-white" style={{ width: 56, height: 56 }} />
            </span>
            <span style={{ fontSize: 24 * fs, opacity: 0.85 }}>Listening</span>
          </span>
        </div>
        <div className="absolute" style={{ ...iconPos2, color: theme.text }}>
          <span className="flex flex-col items-center gap-2">
            <span className="flex items-center justify-center rounded-full" style={{ width: 112, height: 112, background: theme.accent }}>
              <Volume2 className="text-white" style={{ width: 56, height: 56 }} />
            </span>
            <span style={{ fontSize: 24 * fs, opacity: 0.85 }}>Sound on</span>
          </span>
        </div>
        {/* design-ok(hex-in-tsx): mirrors the fixed firmware-drawn "Listening" pill color on real hardware, not app chrome */}
        <div className="absolute flex items-center justify-center rounded-full text-white"
          style={{ ...pillPos, height: 76, padding: '0 28px', background: '#16A34A', fontSize: 26 * fs }}>
          Listening
        </div>
      </div>
    </div>
  )
}

