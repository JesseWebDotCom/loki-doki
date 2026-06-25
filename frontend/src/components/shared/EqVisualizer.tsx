import { useEffect, useRef } from 'react'
import { cn } from '@/lib/cn'

/**
 * Audio-reactive equalizer for the docked players.
 *
 * Driven purely by REAL spectrum data: pass `getAnalyser` (the radio engine exposes a live
 * Web-Audio AnalyserNode, fed by routing each song deck through source → destination + analyser).
 * We read getByteFrequencyData every frame and map it onto log-spaced bars — bass on the left,
 * treble on the right — so the bars only ever move with the actual audio. When there's no signal
 * (paused, buffering, or no analyser) the bars settle to a calm baseline rather than animating;
 * we never fake motion. Honors prefers-reduced-motion with a static silhouette.
 */
export interface EqVisualizerProps {
  /** Animate while true; when false the bars ease down to a resting line and the loop parks. */
  active?: boolean
  /** Returns a live AnalyserNode for real spectrum data, or null. Polled each frame. */
  getAnalyser?: () => AnalyserNode | null
  /** Top/accent colour of each bar's vertical gradient. */
  color?: string
  /** Base colour (bottom of the gradient). Falls back to `color`. */
  colorDark?: string
  /** Overall alpha — keep low for the behind-the-player background use. */
  opacity?: number
  /** Fade the left/right edges with a mask so it blends as a background. */
  fade?: boolean
  className?: string
}

export function EqVisualizer({
  active = true,
  getAnalyser,
  color = '#a855f7',
  colorDark,
  opacity = 1,
  fade = false,
  className,
}: EqVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Live mirrors of props so the long-lived rAF reads fresh values without re-subscribing.
  const stateRef = useRef({ active, color, colorDark: colorDark ?? color, getAnalyser })
  stateRef.current = { active, color, colorDark: colorDark ?? color, getAnalyser }
  const kickRef = useRef<() => void>(() => {})

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const c2d = cv.getContext('2d')
    if (!c2d) return

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const BAR_W = 3, GAP = 4 // logical px
    const REST = 0.05        // resting bar height fraction when there's no signal

    let amps: number[] = []
    let count = 0
    let dpr = 1, w = 0, h = 0
    let freq: Uint8Array = new Uint8Array(0) // reused FFT scratch buffer

    function resize() {
      const r = cv!.getBoundingClientRect()
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = Math.max(1, Math.floor(r.width))
      h = Math.max(1, Math.floor(r.height))
      cv!.width = w * dpr
      cv!.height = h * dpr
      c2d!.setTransform(dpr, 0, 0, dpr, 0, 0)
      const n = Math.max(1, Math.floor((w + GAP) / (BAR_W + GAP)))
      if (n !== count) {
        count = n
        amps = Array.from({ length: n }, () => REST)
      }
    }

    // Log-spaced peak of the FFT band for bar i (bass left → treble right).
    function realTarget(i: number, bins: number): number {
      const usable = Math.floor(bins * 0.72) // upper bins are mostly empty for music
      const lo = Math.floor(Math.pow(i / count, 1.7) * usable)
      const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / count, 1.7) * usable))
      let peak = 0
      for (let j = lo; j < hi && j < bins; j++) peak = Math.max(peak, freq[j]!)
      // Normalize + a mild perceptual lift so quiet detail still shows.
      return Math.max(REST, Math.min(1, Math.pow(peak / 255, 0.9) * 1.05))
    }

    function draw() {
      const { color, colorDark } = stateRef.current
      c2d!.clearRect(0, 0, w, h)
      const grad = c2d!.createLinearGradient(0, h, 0, 0)
      grad.addColorStop(0, colorDark)
      grad.addColorStop(1, color)
      c2d!.fillStyle = grad
      const total = count * BAR_W + (count - 1) * GAP
      let x = Math.max(0, (w - total) / 2)
      for (let i = 0; i < count; i++) {
        const bh = Math.max(2, amps[i]! * h)
        const r = Math.min(BAR_W / 2, bh / 2)
        c2d!.beginPath()
        c2d!.roundRect(x, h - bh, BAR_W, bh, r)
        c2d!.fill()
        x += BAR_W + GAP
      }
    }

    let raf = 0
    let parked = false

    function frame() {
      const { active, getAnalyser } = stateRef.current
      const analyser = active ? getAnalyser?.() ?? null : null
      if (analyser) {
        if (freq.length !== analyser.frequencyBinCount) freq = new Uint8Array(analyser.frequencyBinCount)
        analyser.getByteFrequencyData(freq)
      }

      let moving = false
      for (let i = 0; i < count; i++) {
        const target = analyser ? realTarget(i, freq.length) : REST
        const cur = amps[i]!
        const k = target > cur ? 0.5 : 0.22 // snappy attack, smoother release
        const next = cur + (target - cur) * k
        amps[i] = next
        if (Math.abs(next - target) > 0.004) moving = true
      }
      draw()

      // Park only when inactive (paused/stopped) and the bars have settled.
      if (!active && !moving) { parked = true; return }
      raf = requestAnimationFrame(frame)
    }

    function kick() {
      if (reduced) return
      parked = false
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(frame)
    }
    kickRef.current = kick

    resize()
    if (reduced) {
      // Static silhouette — a calm frozen spectrum, no motion.
      const envelope = (i: number) => 0.55 + 0.45 * Math.cos((i / Math.max(1, count - 1)) * Math.PI * 0.5)
      for (let i = 0; i < count; i++) amps[i] = 0.2 + 0.45 * envelope(i) * (0.6 + 0.4 * Math.sin(i * 1.3))
      draw()
    } else {
      raf = requestAnimationFrame(frame)
    }

    const ro = new ResizeObserver(() => { resize(); if (!reduced) kick() })
    ro.observe(cv)

    return () => { cancelAnimationFrame(raf); ro.disconnect(); kickRef.current = () => {} }
  }, [])

  // Wake a parked loop the instant playback resumes.
  useEffect(() => { kickRef.current() }, [active])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={cn('pointer-events-none block size-full', className)}
      style={{
        opacity,
        ...(fade ? { maskImage: 'linear-gradient(90deg,transparent,#000 12%,#000 88%,transparent)', WebkitMaskImage: 'linear-gradient(90deg,transparent,#000 12%,#000 88%,transparent)' } : {}),
      }}
    />
  )
}
