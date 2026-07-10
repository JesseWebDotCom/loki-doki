import { useEffect, useRef } from 'react'
import { cn } from '@/lib/cn'
import type { Palette } from '@/lib/music/albumColors'

// Fullscreen audio-reactive visualizers for the immersive player. All driven by the SAME
// real Web-Audio AnalyserNode the docked EQ uses - nothing is faked; with no signal the
// scene settles. Honors prefers-reduced-motion (renders a calm static frame).
//
// The set mirrors Plexamp's signature scenes: flowing neon Ribbons, the LED Dot Grid with
// peak-hold caps, the radial Fan of filled blades, plus Spectrum bars (with peak-hold),
// Radial spokes, Aurora colour-field and the Nebula blob.

export type VisualizerVariant = 'bars' | 'radial' | 'blob' | 'aurora' | 'ribbons' | 'dots' | 'fan'
export const VISUALIZERS: { id: VisualizerVariant; label: string }[] = [
  { id: 'fan', label: 'Soundprint' },
  { id: 'ribbons', label: 'Ribbons' },
  { id: 'dots', label: 'Dot Grid' },
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
  /** The track's server loudness envelope - powers the Soundprint's accumulated history. */
  peaks?: number[] | null
  /** Playback position as a 0-1 fraction of the track - how much Soundprint has "grown". */
  progress?: number
  className?: string
}

type Rgb = [number, number, number]
function hexToRgb(h: string): Rgb {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(h)
  return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : [176, 107, 255]
}
const mix = (a: Rgb, b: Rgb, t: number): Rgb =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const rgba = (c: Rgb, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`

export function MusicVisualizer({ variant, getAnalyser, palette, active = true, peaks = null, progress = 0, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef({ variant, getAnalyser, palette, active, peaks, progress })
  stateRef.current = { variant, getAnalyser, palette, active, peaks, progress }

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let dpr = 1, w = 0, h = 0
    let freq = new Uint8Array(0)
    const bands = new Float32Array(64)   // smoothed log-spaced spectrum
    const hold = new Float32Array(64)    // peak-hold levels (bars / dot grid caps)
    const holdVel = new Float32Array(64) // per-band fall speed (gravity)
    let bass = 0, phase = 0

    function resize() {
      const r = cv!.getBoundingClientRect()
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = Math.max(1, Math.floor(r.width)); h = Math.max(1, Math.floor(r.height))
      cv!.width = w * dpr; cv!.height = h * dpr
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    // Fill `bands` from the analyser (log-spaced, smoothed), update the bass envelope and
    // the peak-hold caps (rise instantly, fall with gravity - the classic EQ "cap" motion).
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
        if (bands[i]! >= hold[i]!) { hold[i] = bands[i]!; holdVel[i] = 0 }
        else { holdVel[i]! += 0.0011; hold[i] = Math.max(bands[i]!, hold[i]! - holdVel[i]!) }
      }
      const bTarget = bassAcc / 6
      bass += (bTarget - bass) * (bTarget > bass ? 0.5 : 0.1)
    }

    function drawBars(vib: Rgb, light: Rgb) {
      const n = bands.length
      const gap = 2
      const bw = (w - gap * (n - 1)) / n
      for (let i = 0; i < n; i++) {
        const bh = Math.max(2, bands[i]! * h * 0.9)
        const grad = ctx!.createLinearGradient(0, h, 0, h - bh)
        grad.addColorStop(0, rgba(vib, 0.35))
        grad.addColorStop(1, rgba(light, 0.95))
        ctx!.fillStyle = grad
        const x = i * (bw + gap)
        ctx!.beginPath()
        ctx!.roundRect(x, h - bh, bw, bh, bw / 2)
        ctx!.fill()
        // Floating peak-hold cap above the bar (Plexamp/Winamp EQ signature).
        const capY = h - Math.max(2, hold[i]! * h * 0.9) - 5
        if (capY < h - 8) {
          ctx!.fillStyle = 'rgba(255,255,255,0.85)'
          ctx!.beginPath()
          ctx!.roundRect(x, capY, bw, 2.5, 1.25)
          ctx!.fill()
        }
      }
    }

    function drawDots(vib: Rgb, light: Rgb) {
      // LED dot-matrix spectrum: columns light bottom-up with the band level, a lone
      // peak-hold dot floats above each column, the unlit grid glows faintly behind.
      const cols = Math.max(16, Math.min(56, Math.floor(w / 22)))
      const cell = w / cols
      const rows = Math.max(8, Math.floor((h * 0.86) / cell))
      const r = Math.max(2.5, cell * 0.32)
      const y0 = h - cell * 0.8
      for (let cIdx = 0; cIdx < cols; cIdx++) {
        const band = bands[Math.floor((cIdx / cols) * bands.length)]!
        const lit = Math.round(band * rows)
        const capRow = Math.round(hold[Math.floor((cIdx / cols) * bands.length)]! * rows)
        const x = cIdx * cell + cell / 2
        for (let rIdx = 0; rIdx < rows; rIdx++) {
          const y = y0 - rIdx * cell
          const t = rIdx / rows
          if (rIdx < lit) {
            ctx!.fillStyle = rgba(mix(vib, light, t), 0.55 + t * 0.45)
          } else if (rIdx === capRow && capRow > 0) {
            ctx!.fillStyle = 'rgba(255,255,255,0.9)'
          } else {
            ctx!.fillStyle = rgba(mix(vib, light, t), 0.07)
          }
          ctx!.beginPath()
          ctx!.arc(x, y, rIdx === capRow && rIdx >= lit ? r * 0.8 : r, 0, Math.PI * 2)
          ctx!.fill()
        }
      }
    }

    function drawRibbons(vib: Rgb, light: Rgb, dark: Rgb, corners: Rgb[]) {
      // Flowing neon strands: a handful of horizontal polylines whose vertical drift rides
      // the spectrum (bass on the left, treble right), each strand its own palette colour.
      const strands = [
        { c: light, amp: 1.0, off: -0.06, ph: 0.0, glow: 0.9 },
        { c: vib, amp: 0.85, off: -0.02, ph: 1.4, glow: 0.8 },
        { c: corners[1] ?? vib, amp: 0.7, off: 0.02, ph: 2.9, glow: 0.7 },
        { c: corners[3] ?? dark, amp: 0.55, off: 0.06, ph: 4.1, glow: 0.6 },
        { c: mix(vib, light, 0.5), amp: 0.45, off: 0.1, ph: 5.3, glow: 0.5 },
      ]
      const pts = 90
      ctx!.lineWidth = 2.2
      ctx!.lineJoin = 'round'
      ctx!.lineCap = 'round'
      for (const s of strands) {
        ctx!.strokeStyle = rgba(s.c, 0.85)
        ctx!.shadowColor = rgba(s.c, s.glow)
        ctx!.shadowBlur = 18
        ctx!.beginPath()
        for (let i = 0; i <= pts; i++) {
          const t = i / pts
          const band = bands[Math.floor(t * (bands.length - 1))]!
          const swell = band * h * 0.28 * s.amp
          const y = h * (0.5 + s.off)
            + Math.sin(t * Math.PI * 2.2 + phase * 0.02 + s.ph) * (h * 0.05 + swell)
            + Math.sin(t * Math.PI * 5.1 - phase * 0.013 + s.ph * 2) * swell * 0.5
          const x = t * w
          i === 0 ? ctx!.moveTo(x, y) : ctx!.lineTo(x, y)
        }
        ctx!.stroke()
      }
      ctx!.shadowBlur = 0
    }

    function drawFan(vib: Rgb, light: Rgb, dark: Rgb, corners: Rgb[], peaks: number[] | null, progress: number) {
      // Plexamp's signature "Soundprint": the track's loudness history as chunky radial
      // blades. Twelve o'clock is the start of the song; blades accumulate clockwise as it
      // plays (a full circle = the whole track), blade length = loudness, colour = loudness
      // tier so quiet/loud passages read as sections. Falls back to a live FFT fan for
      // tracks with no server loudness scan yet.
      const cx = w / 2, cy = h / 2
      const r0 = Math.min(w, h) * 0.045
      const maxLen = Math.min(w, h) * 0.42
      const N = 144
      const step = (Math.PI * 2) / N
      const start = -Math.PI / 2
      ctx!.save()
      ctx!.translate(cx, cy)

      // Faint sweep needle at the leading edge (the cards' "seconds hand").
      const lead = start + (peaks ? Math.min(1, Math.max(0, progress)) : phase * 0.0007 % 1) * Math.PI * 2
      ctx!.strokeStyle = 'rgba(255,255,255,0.16)'
      ctx!.lineWidth = 1.5
      ctx!.beginPath(); ctx!.moveTo(0, 0)
      ctx!.lineTo(Math.cos(lead) * Math.max(w, h), Math.sin(lead) * Math.max(w, h)); ctx!.stroke()

      const shades = [dark, corners[2] ?? dark, vib, corners[1] ?? mix(vib, light, 0.5), light]
      let max = 1
      if (peaks) for (const v of peaks) if (v > max) max = v

      const drawn = peaks ? Math.ceil(Math.min(1, Math.max(0, progress)) * N) : N
      for (let i = 0; i < drawn; i++) {
        const a0 = start + i * step
        let level: number
        if (peaks) {
          // Peak of the envelope inside this wedge's time slice.
          const lo = Math.floor((i / N) * peaks.length)
          const hi = Math.max(lo + 1, Math.floor(((i + 1) / N) * peaks.length))
          let p = 0
          for (let j = lo; j < hi && j < peaks.length; j++) p = Math.max(p, peaks[j]!)
          level = p / max
        } else {
          level = bands[(i * 7 + 3) % bands.length]!
        }
        // The freshest wedge breathes with the live signal so "now" feels alive.
        if (peaks && i === drawn - 1) level = Math.min(1, level * (0.85 + bass * 0.4))
        const len = r0 + Math.pow(level, 1.2) * maxLen
        const tier = Math.min(shades.length - 1, Math.floor(level * shades.length))
        ctx!.fillStyle = rgba(shades[tier]!, 0.6 + level * 0.4)
        ctx!.beginPath()
        ctx!.moveTo(Math.cos(a0) * r0, Math.sin(a0) * r0)
        ctx!.arc(0, 0, len, a0, a0 + step * 0.85)
        ctx!.arc(0, 0, r0, a0 + step * 0.85, a0, true)
        ctx!.closePath()
        ctx!.fill()
      }
      // Hub disc.
      ctx!.fillStyle = rgba(dark, 0.9)
      ctx!.beginPath(); ctx!.arc(0, 0, r0 + 3, 0, Math.PI * 2); ctx!.fill()
      ctx!.restore()
    }

    function drawRadial(vib: Rgb, light: Rgb) {
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
        ctx!.strokeStyle = rgba(mix(vib, light, t), 0.9)
        ctx!.lineWidth = 3
        ctx!.lineCap = 'round'
        ctx!.beginPath()
        ctx!.moveTo(Math.cos(a) * r0, Math.sin(a) * r0)
        ctx!.lineTo(Math.cos(a) * (r0 + len), Math.sin(a) * (r0 + len))
        ctx!.stroke()
      }
      // Inner glow disc pulsing with bass.
      const glow = ctx!.createRadialGradient(0, 0, 0, 0, 0, r0)
      glow.addColorStop(0, rgba(light, 0.18 + bass * 0.25))
      glow.addColorStop(1, 'rgba(0,0,0,0)')
      ctx!.fillStyle = glow
      ctx!.beginPath(); ctx!.arc(0, 0, r0, 0, Math.PI * 2); ctx!.fill()
      ctx!.restore()
    }

    function drawBlob(vib: Rgb, light: Rgb, dark: Rgb) {
      const cx = w / 2, cy = h / 2
      const base = Math.min(w, h) * 0.24
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
      grad.addColorStop(0, rgba(light, 0.85))
      grad.addColorStop(0.5, rgba(vib, 0.6))
      grad.addColorStop(1, rgba(dark, 0.05))
      ctx!.fillStyle = grad
      ctx!.shadowColor = rgba(vib, 0.9)
      ctx!.shadowBlur = 40 + bass * 60
      ctx!.fill()
      ctx!.shadowBlur = 0
    }

    function drawAurora(vib: Rgb, light: Rgb, dark: Rgb) {
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
        g.addColorStop(0, rgba(b.c, 0.4 + b.e * 0.4))
        g.addColorStop(1, 'rgba(0,0,0,0)')
        ctx!.fillStyle = g
        ctx!.fillRect(0, 0, w, h)
      }
    }

    let raf = 0
    function frame() {
      const { variant, getAnalyser, palette, active, peaks, progress } = stateRef.current
      const analyser = active ? getAnalyser() : null
      sample(analyser)
      phase += 1
      const vib = hexToRgb(palette.vibrant)
      const light = hexToRgb(palette.light)
      const dark = hexToRgb(palette.dark)
      const corners = palette.corners.map(hexToRgb)

      ctx!.clearRect(0, 0, w, h)
      if (variant === 'aurora') drawAurora(vib, light, dark)
      else if (variant === 'blob') drawBlob(vib, light, dark)
      else if (variant === 'radial') drawRadial(vib, light)
      else if (variant === 'ribbons') drawRibbons(vib, light, dark, corners)
      else if (variant === 'dots') drawDots(vib, light)
      else if (variant === 'fan') drawFan(vib, light, dark, corners, peaks, progress)
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
