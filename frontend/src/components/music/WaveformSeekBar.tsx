// Plexamp-style "soundwave" seek bar: the track's real amplitude envelope as thin vertical
// bars mirrored around the centre line, played portion filled with the album accent colour,
// the rest neutral. `clocks` renders the signature inline layout - elapsed on the left,
// remaining (with minus sign) on the right of the wave itself. Same pointer-capture scrub
// contract as the shared SeekBar; falls back to a plain SeekBar when no peaks exist for the
// ref (streamed-only tracks) - the fetch miss lazily queues a server scan so the waveform
// appears next play.

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { SeekBar } from '@/components/shared/SeekBar'
import { getWaveform } from '@/lib/music/metaApi'

const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.max(0, Math.floor(s % 60))).padStart(2, '0')}`

export function WaveformSeekBar({ trackRef, pos, total, onSeek, accent, disabled, onScrubStateChange, className, clocks = false }: {
  trackRef: string
  pos: number
  total: number
  onSeek: (sec: number) => void
  /** Colour of the played portion of the wave (Plexamp tints this with the album accent). */
  accent?: string
  disabled?: boolean
  onScrubStateChange?: (scrubbing: boolean) => void
  className?: string
  /** Plexamp inline layout: elapsed left of the wave, -remaining right of it. */
  clocks?: boolean
}) {
  const [peaks, setPeaks] = useState<number[] | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    setPeaks(null)
    getWaveform(trackRef).then((p) => { if (alive) setPeaks(p) })
    return () => { alive = false }
  }, [trackRef])

  const frac = drag ?? (total > 0 ? Math.max(0, Math.min(pos / total, 1)) : 0)
  // design-ok(hex-in-tsx): canvas fillStyle fallback, callers pass palette colours
  const played = accent ?? '#ffffff'

  // Canvas render: bars sized to the element, re-drawn on progress/theme changes.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !peaks) return
    const dpr = window.devicePixelRatio || 1
    const { width, height } = canvas.getBoundingClientRect()
    if (!width || !height) return
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)

    const barW = 2
    const gap = 1
    const bars = Math.max(1, Math.floor(width / (barW + gap)))
    const mid = height / 2
    const playedX = frac * width
    // Normalize against the loudest bucket so quiet masters still fill the lane.
    let max = 1
    for (const v of peaks) if (v > max) max = v

    for (let i = 0; i < bars; i++) {
      const x = i * (barW + gap)
      const bucket = peaks[Math.floor((i / bars) * peaks.length)] ?? 0
      const h = Math.max(2, (bucket / max) * (height - 2))
      ctx.fillStyle = x <= playedX ? played : 'rgba(255,255,255,0.28)'
      ctx.beginPath()
      ctx.roundRect(x, mid - h / 2, barW, h, 1)
      ctx.fill()
    }
  }, [peaks, frac, played])

  const fracFrom = (clientX: number) => {
    const el = wrapRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    return Math.max(0, Math.min((clientX - r.left) / r.width, 1))
  }

  const wave = !peaks ? (
    <SeekBar pos={pos} total={total} onSeek={onSeek} accent={accent} disabled={disabled}
      onScrubStateChange={onScrubStateChange} className={clocks ? 'min-w-0 flex-1' : className} />
  ) : (
    <div ref={wrapRef}
      onPointerDown={(e) => {
        if (disabled || total <= 0) return
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        onScrubStateChange?.(true)
        const f = fracFrom(e.clientX); setDrag(f); onSeek(f * total)
      }}
      onPointerMove={(e) => {
        if (drag == null) return
        const f = fracFrom(e.clientX); setDrag(f); onSeek(f * total)
      }}
      onPointerUp={(e) => {
        if (drag == null) return
        try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* not captured */ }
        setDrag(null); onScrubStateChange?.(false)
      }}
      className={cn('touch-none select-none', disabled ? 'cursor-default opacity-40' : 'cursor-pointer',
        clocks ? 'min-w-0 flex-1' : className)}>
      <canvas ref={canvasRef} className="block h-10 w-full" />
    </div>
  )

  if (!clocks) return wave

  const dragSec = drag != null && total > 0 ? drag * total : null
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <span className="shrink-0 text-[11px] tabular-nums text-white/60">{fmtClock(dragSec ?? pos)}</span>
      {wave}
      <span className="shrink-0 text-[11px] tabular-nums text-white/60">
        {total > 0 ? `-${fmtClock(Math.max(0, total - (dragSec ?? pos)))}` : '--:--'}
      </span>
    </div>
  )
}
