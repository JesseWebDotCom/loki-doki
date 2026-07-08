// Moosic-style waveform seek bar: the track's real amplitude envelope as thin vertical
// bars, played portion bright, with the same pointer-capture scrub contract as the shared
// SeekBar. Falls back to a plain SeekBar when no peaks exist for the ref (streamed-only
// tracks) - the fetch miss lazily queues a server scan so the waveform appears next play.

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { SeekBar } from '@/components/shared/SeekBar'
import { getWaveform } from '@/lib/music/metaApi'

export function WaveformSeekBar({ trackRef, pos, total, onSeek, accent, disabled, onScrubStateChange, className }: {
  trackRef: string
  pos: number
  total: number
  onSeek: (sec: number) => void
  accent?: string
  disabled?: boolean
  onScrubStateChange?: (scrubbing: boolean) => void
  className?: string
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
      ctx.fillStyle = x <= playedX ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.28)'
      ctx.beginPath()
      ctx.roundRect(x, mid - h / 2, barW, h, 1)
      ctx.fill()
    }
  }, [peaks, frac])

  if (!peaks) {
    return <SeekBar pos={pos} total={total} onSeek={onSeek} accent={accent} disabled={disabled}
      onScrubStateChange={onScrubStateChange} className={className} />
  }

  const fracFrom = (clientX: number) => {
    const el = wrapRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    return Math.max(0, Math.min((clientX - r.left) / r.width, 1))
  }

  return (
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
      className={cn('touch-none select-none', disabled ? 'cursor-default opacity-40' : 'cursor-pointer', className)}>
      <canvas ref={canvasRef} className="block h-10 w-full" />
    </div>
  )
}
