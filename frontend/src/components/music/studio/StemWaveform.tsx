// Per-stem waveform strip (Moises-style). Draws precomputed peak buckets (from the engine)
// to a canvas with a playhead overlay that follows playback.
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/cn'

interface Props {
  peaks: number[]
  /** 0..1 playback position for the playhead. */
  progress: number
  active: boolean
  className?: string
  /** CSS colour for the bars (defaults to the brand colour). */
  color?: string
  /** When set, clicking the waveform jumps playback there (fraction 0..1). */
  onSeek?: (fraction: number) => void
}

export function StemWaveform({ peaks, progress, active, className, color, onSeek }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth, h = canvas.clientHeight
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    if (peaks.length === 0) return

    const barW = w / peaks.length
    const mid = h / 2
    const playX = Math.max(0, Math.min(1, progress)) * w
    // Resolve the (theme-aware) colour from the canvas's own computed `color` - the
    // wrapper sets `text-brand`, so this works in light + dark without hardcoding hex.
    const color = getComputedStyle(canvas).color || 'currentColor'
    for (let i = 0; i < peaks.length; i++) {
      const x = i * barW
      const amp = Math.max(1, peaks[i] * (h * 0.9))
      ctx.globalAlpha = active ? (x <= playX ? 1 : 0.3) : 0.18
      ctx.fillStyle = color
      ctx.fillRect(x, mid - amp / 2, Math.max(1, barW - 0.5), amp)
    }
    ctx.globalAlpha = 1
  }, [peaks, progress, active])

  const onDown = onSeek
    ? (e: React.PointerEvent<HTMLCanvasElement>) => {
        const r = e.currentTarget.getBoundingClientRect()
        onSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)))
      }
    : undefined

  return <canvas ref={canvasRef} onPointerDown={onDown} style={color ? { color } : undefined} className={cn('text-brand', onSeek && 'cursor-pointer', className)} />
}
