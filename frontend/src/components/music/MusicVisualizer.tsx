import { useEffect, useRef } from 'react'
import { cn } from '@/lib/cn'
import type { Palette } from '@/lib/music/albumColors'

// Fullscreen audio-reactive visualizers for the immersive player. All driven by the SAME
// real Web-Audio AnalyserNode the docked EQ uses - nothing is faked; with no signal the
// scene settles. Honors prefers-reduced-motion (renders a calm static frame).

export type VisualizerVariant = 'bars' | 'radial' | 'blob' | 'aurora'
export const VISUALIZERS: { id: VisualizerVariant; label: string }[] = [
  { id: 'aurora', label: 'Aurora' },
  { id: 'bars', label: 'Spectrum' },
  { id: 'radial', label: 'Radial' },
  { id: 'blob', label: 'Nebula' },
]

interface Props {
  variant: VisualizerVariant
  getAnalyser: () => AnalyserNode | null
  palette: Palette
  active?: boolean
  className?: string
}

function hexToRgb(h: string): [number, number, number] {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(h)
  return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : [176, 107, 255]
}

export function MusicVisualizer({ variant, getAnalyser, palette, active = true, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef({ variant, getAnalyser, palette, active })
  stateRef.current = { variant, getAnalyser, palette, active }

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let dpr = 1, w = 0, h = 0
    let freq = new Uint8Array(0)
    const bands = new Float32Array(64)   // smoothed log-spaced spectrum
    let bass = 0, phase = 0

    function resize() {
      const r = cv!.getBoundingClientRect()
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = Math.max(1, Math.floor(r.width)); h = Math.max(1, Math.floor(r.height))
      cv!.width = w * dpr; cv!.height = h * dpr
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    // Fill `bands` from the analyser (log-spaced, smoothed), update the bass envelope.
    function sample(analyser: AnalyserNode | null) {
      if (analyser) {
        if (freq.length !== analyser.frequencyBinCount) freq = new Uint8Array(analyser.frequencyBinCount)
        analyser.getByteFrequencyData(freq)
      }
      const usable = Math.floor(freq.length * 0.5) || 1
      let bassAcc = 0
      for (let i = 0; i < bands.length; i++) {
        const lo = Math.floor(Math.pow(i / bands.length, 1.7) * usable)
        const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / bands.length, 1.7) * usable))
        let peak = 0
        for (let j = lo; j < hi && j < freq.length; j++) peak = Math.max(peak, freq[j]!)
        const target = analyser ? Math.pow(Math.min(1, peak / 255), 1.5) : 0
        bands[i]! += (target - bands[i]!) * (target > bands[i]! ? 0.6 : 0.12)
        if (i < 6) bassAcc += bands[i]!
      }
      const bTarget = bassAcc / 6
      bass += (bTarget - bass) * (bTarget > bass ? 0.5 : 0.1)
    }

    function drawBars(vib: number[], light: number[]) {
      const n = bands.length
      const gap = 2
      const bw = (w - gap * (n - 1)) / n
      for (let i = 0; i < n; i++) {
        const bh = Math.max(2, bands[i]! * h * 0.9)
        const grad = ctx!.createLinearGradient(0, h, 0, h - bh)
        grad.addColorStop(0, `rgba(${vib[0]},${vib[1]},${vib[2]},0.35)`)
        grad.addColorStop(1, `rgba(${light[0]},${light[1]},${light[2]},0.95)`)
        ctx!.fillStyle = grad
        const x = i * (bw + gap)
        ctx!.beginPath()
        ctx!.roundRect(x, h - bh, bw, bh, bw / 2)
        ctx!.fill()
      }
    }

    function drawRadial(vib: number[], light: number[]) {
      const cx = w / 2, cy = h / 2
      const n = bands.length
      const r0 = Math.min(w, h) * (0.16 + bass * 0.05)
      ctx!.save()
      ctx!.translate(cx, cy)
      ctx!.rotate(phase * 0.05)
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        const len = 8 + bands[i]! * Math.min(w, h) * 0.32
        const t = i / n
        ctx!.strokeStyle = `rgba(${vib[0] + (light[0] - vib[0]) * t},${vib[1] + (light[1] - vib[1]) * t},${vib[2] + (light[2] - vib[2]) * t},0.9)`
        ctx!.lineWidth = 3
        ctx!.lineCap = 'round'
        ctx!.beginPath()
        ctx!.moveTo(Math.cos(a) * r0, Math.sin(a) * r0)
        ctx!.lineTo(Math.cos(a) * (r0 + len), Math.sin(a) * (r0 + len))
        ctx!.stroke()
      }
      // Inner glow disc pulsing with bass.
      const glow = ctx!.createRadialGradient(0, 0, 0, 0, 0, r0)
      glow.addColorStop(0, `rgba(${light[0]},${light[1]},${light[2]},${0.18 + bass * 0.25})`)
      glow.addColorStop(1, 'rgba(0,0,0,0)')
      ctx!.fillStyle = glow
      ctx!.beginPath(); ctx!.arc(0, 0, r0, 0, Math.PI * 2); ctx!.fill()
      ctx!.restore()
    }

    function drawBlob(vib: number[], light: number[], dark: number[]) {
      const cx = w / 2, cy = h / 2
      const base = Math.min(w, h) * 0.24
      const bg = ctx!.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.7)
      bg.addColorStop(0, `rgba(${dark[0]},${dark[1]},${dark[2]},0.0)`)
      bg.addColorStop(1, `rgba(${dark[0]},${dark[1]},${dark[2]},0.0)`)
      ctx!.fillStyle = bg
      ctx!.fillRect(0, 0, w, h)
      const lobes = 8
      ctx!.beginPath()
      for (let i = 0; i <= 120; i++) {
        const a = (i / 120) * Math.PI * 2
        const bandIdx = Math.floor((i / 120) * bands.length) % bands.length
        const wobble = Math.sin(a * lobes + phase * 0.6) * (0.08 + bands[bandIdx]! * 0.5)
        const r = base * (1 + wobble + bass * 0.5)
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r
        i === 0 ? ctx!.moveTo(x, y) : ctx!.lineTo(x, y)
      }
      ctx!.closePath()
      const grad = ctx!.createRadialGradient(cx, cy, base * 0.2, cx, cy, base * 1.8)
      grad.addColorStop(0, `rgba(${light[0]},${light[1]},${light[2]},0.85)`)
      grad.addColorStop(0.5, `rgba(${vib[0]},${vib[1]},${vib[2]},0.6)`)
      grad.addColorStop(1, `rgba(${dark[0]},${dark[1]},${dark[2]},0.05)`)
      ctx!.fillStyle = grad
      ctx!.shadowColor = `rgba(${vib[0]},${vib[1]},${vib[2]},0.9)`
      ctx!.shadowBlur = 40 + bass * 60
      ctx!.fill()
      ctx!.shadowBlur = 0
    }

    function drawAurora(vib: number[], light: number[], dark: number[]) {
      // Soft breathing colour-field (Rothko/UltraBlur, but music-reactive): three drifting
      // radial blobs whose radius and opacity ride the bass + mid energy.
      const mid = (bands[10]! + bands[16]! + bands[24]!) / 3
      const blobs = [
        { x: 0.3, y: 0.35, c: vib, e: bass },
        { x: 0.7, y: 0.4, c: light, e: mid },
        { x: 0.5, y: 0.75, c: dark, e: (bass + mid) / 2 },
      ]
      for (let i = 0; i < blobs.length; i++) {
        const b = blobs[i]!
        const drift = phase * 0.01 + i
        const x = (b.x + Math.sin(drift) * 0.06) * w
        const y = (b.y + Math.cos(drift * 0.8) * 0.06) * h
        const r = Math.max(w, h) * (0.3 + b.e * 0.35)
        const g = ctx!.createRadialGradient(x, y, 0, x, y, r)
        g.addColorStop(0, `rgba(${b.c[0]},${b.c[1]},${b.c[2]},${0.4 + b.e * 0.4})`)
        g.addColorStop(1, 'rgba(0,0,0,0)')
        ctx!.fillStyle = g
        ctx!.fillRect(0, 0, w, h)
      }
    }

    let raf = 0
    function frame() {
      const { variant, getAnalyser, palette, active } = stateRef.current
      const analyser = active ? getAnalyser() : null
      sample(analyser)
      phase += 1
      const vib = hexToRgb(palette.vibrant)
      const light = hexToRgb(palette.light)
      const dark = hexToRgb(palette.dark)

      ctx!.clearRect(0, 0, w, h)
      // Aurora/blob layer their own translucent fills; bars/radial get a clean transparent bg.
      if (variant === 'aurora') drawAurora(vib, light, dark)
      else if (variant === 'blob') drawBlob(vib, light, dark)
      else if (variant === 'radial') drawRadial(vib, light)
      else drawBars(vib, light)

      raf = requestAnimationFrame(frame)
    }

    resize()
    if (reduced) { sample(null); frame(); cancelAnimationFrame(raf) }
    else raf = requestAnimationFrame(frame)
    const ro = new ResizeObserver(resize)
    ro.observe(cv)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [])

  return <canvas ref={canvasRef} aria-hidden className={cn('block size-full', className)} />
}
