import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { accentOf, hexToRgb, mixRgb, rgba, type Palette, type Rgb } from '@/lib/music/albumColors'

// THE audio-reactive visualizer (replaces the old shared/EqVisualizer + music/MusicVisualizer
// pair). One registry of scenes, two rendering modes - EVERY scene renders in both:
//   - mode="full":  the Plexamp-style immersive stage
//   - mode="strip": a short ambient band behind mini players / chrome. Center-anchored
//                   scenes get purpose-built strip forms (Soundprint = horizontal loudness
//                   timeline, Radial = bottom-anchored sunrise fan, Nebula = drifting orb)
// All scenes are driven by the SAME real Web-Audio AnalyserNode - nothing is faked; with no
// signal the scene settles. Honors prefers-reduced-motion (one calm static frame). The rAF
// parks when the tab is hidden, and additionally (strip mode) when playback is inactive and
// the bars have settled, so an always-mounted mini bar costs nothing while paused.

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

// ONE visualizer choice for the whole app: the same scene renders as the mini/ambient
// strip AND the fullscreen stage ("if I select Dot Grid, I want it for mini and full").
// Center-anchored scenes can't draw in a ~56px band, so strips fall back to Spectrum for
// those (handled inside the component). Per-device, like every other music.* surface pref.
const PREF_KEY = 'music.visualizer'
const LEGACY_KEYS = ['music.stripVisualizer', 'music.immersiveVisualizer']
const prefListeners = new Set<() => void>()
export function getVisualizerPref(): VisualizerVariant {
  const saved = localStorage.getItem(PREF_KEY) ?? LEGACY_KEYS.map((k) => localStorage.getItem(k)).find(Boolean)
  return (VISUALIZERS.find((v) => v.id === saved)?.id ?? 'bars') as VisualizerVariant
}
export function setVisualizerPref(v: VisualizerVariant): void {
  localStorage.setItem(PREF_KEY, v)
  prefListeners.forEach((fn) => fn())
}
export function useVisualizerPref(): VisualizerVariant {
  const [variant, setVariant] = useState<VisualizerVariant>(getVisualizerPref)
  useEffect(() => {
    const fn = () => setVariant(getVisualizerPref())
    prefListeners.add(fn)
    return () => { prefListeners.delete(fn) }
  }, [])
  return variant
}

interface Props {
  variant: VisualizerVariant
  /** "full" = immersive stage (default). "strip" = short ambient band behind chrome. */
  mode?: 'full' | 'strip'
  /** Returns a live AnalyserNode for real spectrum data, or null. Polled each frame. */
  getAnalyser: () => AnalyserNode | null
  palette: Palette
  active?: boolean
  /** The track's server loudness envelope - powers the Soundprint's accumulated history. */
  peaks?: number[] | null
  /** Playback position as a 0-1 fraction of the track - how much Soundprint has "grown". */
  progress?: number
  /** Overall alpha; keep low for the behind-the-player background use. */
  opacity?: number
  /** Fade the left/right edges with a mask so it blends as a background. */
  fade?: boolean
  className?: string
}

export function AudioVisualizer({
  variant,
  mode = 'full',
  getAnalyser,
  palette,
  active = true,
  peaks = null,
  progress = 0,
  opacity = 1,
  fade = false,
  className,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Live mirrors of props so the long-lived rAF reads fresh values without re-subscribing.
  const stateRef = useRef({ variant, mode, getAnalyser, palette, active, peaks, progress })
  stateRef.current = { variant, mode, getAnalyser, palette, active, peaks, progress }
  const kickRef = useRef<() => void>(() => {})

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
    // Only maps up to bins*0.5 (~10kHz): streaming audio is low-passed and the top bins
    // read ~0, which would leave the treble end frozen. Returns true while anything is
    // still visibly moving (used to park the strip loop once settled).
    function sample(analyser: AnalyserNode | null): boolean {
      if (analyser) {
        if (freq.length !== analyser.frequencyBinCount) freq = new Uint8Array(analyser.frequencyBinCount)
        analyser.getByteFrequencyData(freq)
      }
      const usable = Math.floor(freq.length * 0.5) || 1
      let bassAcc = 0
      let moving = false
      // Strip mode keeps the docked EQ's punchy fast-attack/quick-release feel (hits stand
      // apart, no smear); full mode keeps the smoother cinematic easing the scenes expect.
      const strip = stateRef.current.mode === 'strip'
      const up = strip ? 0.7 : 0.6
      const down = strip ? 0.4 : 0.12
      for (let i = 0; i < bands.length; i++) {
        const lo = Math.floor(Math.pow(i / bands.length, 1.7) * usable)
        const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / bands.length, 1.7) * usable))
        let peak = 0
        for (let j = lo; j < hi && j < freq.length; j++) peak = Math.max(peak, freq[j]!)
        const target = analyser ? Math.pow(Math.min(1, peak / 255), 1.5) : 0
        bands[i]! += (target - bands[i]!) * (target > bands[i]! ? up : down)
        if (Math.abs(bands[i]! - target) > 0.004) moving = true
        if (i < 6) bassAcc += bands[i]!
        if (bands[i]! >= hold[i]!) { hold[i] = bands[i]!; holdVel[i] = 0 }
        else { holdVel[i]! += 0.0011; hold[i] = Math.max(bands[i]!, hold[i]! - holdVel[i]!) }
        if (hold[i]! > 0.01) moving = true
      }
      const bTarget = bassAcc / 6
      bass += (bTarget - bass) * (bTarget > bass ? 0.5 : 0.1)
      return moving
    }

    // Strip-mode Spectrum: the classic docked bar-EQ (bar count from width, rounded bars,
    // dark→accent gradient, calm resting baseline). Pixel-look of the old EqVisualizer.
    function drawStripBars(accent: Rgb, dark: Rgb) {
      const BAR_W = 3, GAP = 4, REST = 0.05
      const count = Math.max(1, Math.floor((w + GAP) / (BAR_W + GAP)))
      const grad = ctx!.createLinearGradient(0, h, 0, 0)
      grad.addColorStop(0, rgba(dark, 1))
      grad.addColorStop(1, rgba(accent, 1))
      ctx!.fillStyle = grad
      const total = count * BAR_W + (count - 1) * GAP
      let x = Math.max(0, (w - total) / 2)
      for (let i = 0; i < count; i++) {
        // Resample the 64 bands onto the width-derived bar count (peak over the range),
        // with the old strip's treble tilt + gamma so hits stand apart.
        const lo = Math.floor((i / count) * bands.length)
        const hi = Math.max(lo + 1, Math.floor(((i + 1) / count) * bands.length))
        let level = 0
        for (let j = lo; j < hi; j++) level = Math.max(level, bands[j]!)
        const tilt = 1 + 0.6 * (i / Math.max(1, count - 1))
        const amp = Math.max(REST, Math.pow(Math.min(1, level * tilt), 1.1))
        const bh = Math.max(2, amp * h)
        const r = Math.min(BAR_W / 2, bh / 2)
        ctx!.beginPath()
        ctx!.roundRect(x, h - bh, BAR_W, bh, r)
        ctx!.fill()
        x += BAR_W + GAP
      }
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

    function drawDots(vib: Rgb, light: Rgb, strip: boolean) {
      // LED dot-matrix spectrum: columns light bottom-up with the band level, a lone
      // peak-hold dot floats above each column, the unlit grid glows faintly behind.
      // Strip mode drops the min-row floor and cell padding so the grid fits a short band.
      const cols = Math.max(16, Math.min(56, Math.floor(w / (strip ? 14 : 22))))
      const cell = w / cols
      const rows = strip
        ? Math.max(2, Math.floor((h * 0.9) / cell))
        : Math.max(8, Math.floor((h * 0.86) / cell))
      const r = Math.max(strip ? 1.5 : 2.5, cell * 0.32)
      const y0 = h - cell * (strip ? 0.55 : 0.8)
      for (let cIdx = 0; cIdx < cols; cIdx++) {
        const band = bands[Math.floor((cIdx / cols) * bands.length)]!
        const lit = Math.round(band * rows)
        const capRow = Math.round(hold[Math.floor((cIdx / cols) * bands.length)]! * rows)
        const x = cIdx * cell + cell / 2
        for (let rIdx = 0; rIdx < rows; rIdx++) {
          const y = y0 - rIdx * cell
          const t = rIdx / rows
          if (rIdx < lit) {
            ctx!.fillStyle = rgba(mixRgb(vib, light, t), 0.55 + t * 0.45)
          } else if (rIdx === capRow && capRow > 0) {
            ctx!.fillStyle = 'rgba(255,255,255,0.9)'
          } else {
            ctx!.fillStyle = rgba(mixRgb(vib, light, t), 0.07)
          }
          ctx!.beginPath()
          ctx!.arc(x, y, rIdx === capRow && rIdx >= lit ? r * 0.8 : r, 0, Math.PI * 2)
          ctx!.fill()
        }
      }
    }

    function drawRibbons(vib: Rgb, light: Rgb, dark: Rgb, corners: Rgb[], strip: boolean) {
      // Flowing neon strands: a handful of horizontal polylines whose vertical drift rides
      // the spectrum (bass on the left, treble right), each strand its own palette colour.
      const strands = [
        { c: light, amp: 1.0, off: -0.06, ph: 0.0, glow: 0.9 },
        { c: vib, amp: 0.85, off: -0.02, ph: 1.4, glow: 0.8 },
        { c: corners[1] ?? vib, amp: 0.7, off: 0.02, ph: 2.9, glow: 0.7 },
        { c: corners[3] ?? dark, amp: 0.55, off: 0.06, ph: 4.1, glow: 0.6 },
        { c: mixRgb(vib, light, 0.5), amp: 0.45, off: 0.1, ph: 5.3, glow: 0.5 },
      ]
      const pts = 90
      ctx!.lineWidth = strip ? 1.5 : 2.2
      ctx!.lineJoin = 'round'
      ctx!.lineCap = 'round'
      for (const s of strands) {
        ctx!.strokeStyle = rgba(s.c, 0.85)
        ctx!.shadowColor = rgba(s.c, s.glow)
        ctx!.shadowBlur = strip ? 8 : 18
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

    // Strip Soundprint: the same loudness-history idea unrolled onto a horizontal
    // timeline (start of the track on the left). Played slivers are colored by loudness
    // tier, the leading sliver breathes with the live signal, and the unplayed remainder
    // ghosts at low alpha so the track's shape is visible ahead of the playhead.
    function drawFanStrip(vib: Rgb, light: Rgb, dark: Rgb, corners: Rgb[], pk: number[] | null, prog: number) {
      // Sliver width scales with the bar so a desktop-wide strip stays chunky (~140
      // blades, like the circular Soundprint's 144) instead of degrading into
      // hundreds of hairlines that read as noise.
      const SLIVER = Math.max(2.5, Math.min(8, w / 140))
      const GAP = Math.max(2, SLIVER * 0.7)
      const n = Math.max(8, Math.floor((w + GAP) / (SLIVER + GAP)))
      const shades = [dark, corners[2] ?? dark, vib, corners[1] ?? mixRgb(vib, light, 0.5), light]
      let max = 1
      if (pk) for (const v of pk) if (v > max) max = v
      const drawn = pk ? Math.ceil(Math.min(1, Math.max(0, prog)) * n) : n
      let x = Math.max(0, (w - (n * SLIVER + (n - 1) * GAP)) / 2)
      for (let i = 0; i < n; i++) {
        let level: number
        if (pk) {
          const lo = Math.floor((i / n) * pk.length)
          const hi = Math.max(lo + 1, Math.floor(((i + 1) / n) * pk.length))
          let p = 0
          for (let j = lo; j < hi && j < pk.length; j++) p = Math.max(p, pk[j]!)
          level = p / max
        } else {
          level = bands[(i * 7 + 3) % bands.length]!
        }
        const played = i < drawn
        if (pk && played && i === drawn - 1) level = Math.min(1, level * (0.85 + bass * 0.4))
        const bh = Math.max(2, Math.pow(level, 1.2) * (h - 4))
        const tier = Math.min(shades.length - 1, Math.floor(level * shades.length))
        // Ghost the unplayed remainder only faintly - at strip opacity a 0.12 ghost
        // across a wide bar reads as smeared static rather than "the road ahead".
        ctx!.fillStyle = played ? rgba(shades[tier]!, 0.6 + level * 0.4) : rgba(mixRgb(vib, light, 0.3), 0.05)
        ctx!.beginPath()
        ctx!.roundRect(x, h - bh, SLIVER, bh, SLIVER / 2)
        ctx!.fill()
        x += SLIVER + GAP
      }
    }

    // Strip Radial: a "sunrise" fan anchored at bottom-center - the same spokes over a
    // 180-degree arc so it fits a short band.
    function drawRadialStrip(vib: Rgb, light: Rgb) {
      const cx = w / 2, cy = h
      const n = 48
      const r0 = h * (0.18 + bass * 0.1)
      const maxLen = h * 0.78
      ctx!.save()
      ctx!.translate(cx, cy)
      for (let i = 0; i < n; i++) {
        const a = -Math.PI + ((i + 0.5) / n) * Math.PI
        const band = bands[Math.floor((i / n) * bands.length)]!
        const len = 3 + band * maxLen
        ctx!.strokeStyle = rgba(mixRgb(vib, light, i / n), 0.9)
        ctx!.lineWidth = 2
        ctx!.lineCap = 'round'
        ctx!.beginPath()
        ctx!.moveTo(Math.cos(a) * r0, Math.sin(a) * r0)
        ctx!.lineTo(Math.cos(a) * (r0 + len), Math.sin(a) * (r0 + len))
        ctx!.stroke()
      }
      const glow = ctx!.createRadialGradient(0, 0, 0, 0, 0, r0 + 4)
      glow.addColorStop(0, rgba(light, 0.18 + bass * 0.25))
      glow.addColorStop(1, 'rgba(0,0,0,0)')
      ctx!.fillStyle = glow
      ctx!.beginPath(); ctx!.arc(0, 0, r0 + 4, 0, Math.PI * 2); ctx!.fill()
      ctx!.restore()
    }

    // Strip Nebula: the wobbling orb, shrunk and slowly drifting across the band.
    function drawBlobStrip(vib: Rgb, light: Rgb, dark: Rgb) {
      const base = h * 0.28
      const cx = w / 2 + Math.sin(phase * 0.006) * Math.max(0, w / 2 - base * 3)
      const cy = h / 2
      const lobes = 6
      ctx!.beginPath()
      for (let i = 0; i <= 80; i++) {
        const a = (i / 80) * Math.PI * 2
        const bandIdx = Math.floor((i / 80) * bands.length) % bands.length
        const wobble = Math.sin(a * lobes + phase * 0.6) * (0.08 + bands[bandIdx]! * 0.5)
        const r = base * (1 + wobble + bass * 0.5)
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r
        i === 0 ? ctx!.moveTo(x, y) : ctx!.lineTo(x, y)
      }
      ctx!.closePath()
      const grad = ctx!.createRadialGradient(cx, cy, base * 0.2, cx, cy, base * 2)
      grad.addColorStop(0, rgba(light, 0.85))
      grad.addColorStop(0.5, rgba(vib, 0.6))
      grad.addColorStop(1, rgba(dark, 0.05))
      ctx!.fillStyle = grad
      ctx!.shadowColor = rgba(vib, 0.9)
      ctx!.shadowBlur = 10 + bass * 18
      ctx!.fill()
      ctx!.shadowBlur = 0
    }

    function drawFan(vib: Rgb, light: Rgb, dark: Rgb, corners: Rgb[], pk: number[] | null, prog: number) {
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
      const lead = start + (pk ? Math.min(1, Math.max(0, prog)) : phase * 0.0007 % 1) * Math.PI * 2
      ctx!.strokeStyle = 'rgba(255,255,255,0.16)'
      ctx!.lineWidth = 1.5
      ctx!.beginPath(); ctx!.moveTo(0, 0)
      ctx!.lineTo(Math.cos(lead) * Math.max(w, h), Math.sin(lead) * Math.max(w, h)); ctx!.stroke()

      const shades = [dark, corners[2] ?? dark, vib, corners[1] ?? mixRgb(vib, light, 0.5), light]
      let max = 1
      if (pk) for (const v of pk) if (v > max) max = v

      const drawn = pk ? Math.ceil(Math.min(1, Math.max(0, prog)) * N) : N
      for (let i = 0; i < drawn; i++) {
        const a0 = start + i * step
        let level: number
        if (pk) {
          // Peak of the envelope inside this wedge's time slice.
          const lo = Math.floor((i / N) * pk.length)
          const hi = Math.max(lo + 1, Math.floor(((i + 1) / N) * pk.length))
          let p = 0
          for (let j = lo; j < hi && j < pk.length; j++) p = Math.max(p, pk[j]!)
          level = p / max
        } else {
          level = bands[(i * 7 + 3) % bands.length]!
        }
        // The freshest wedge breathes with the live signal so "now" feels alive.
        if (pk && i === drawn - 1) level = Math.min(1, level * (0.85 + bass * 0.4))
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
        ctx!.strokeStyle = rgba(mixRgb(vib, light, t), 0.9)
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

    function drawScene() {
      const { variant, mode, palette, peaks, progress } = stateRef.current
      const strip = mode === 'strip'
      const vib = hexToRgb(palette.vibrant)
      const light = hexToRgb(palette.light)
      const dark = hexToRgb(palette.dark)
      const corners = palette.corners.map(hexToRgb)

      ctx!.clearRect(0, 0, w, h)
      if (variant === 'aurora') drawAurora(vib, light, dark)
      else if (variant === 'blob') (strip ? drawBlobStrip : drawBlob)(vib, light, dark)
      else if (variant === 'radial') (strip ? drawRadialStrip : drawRadial)(vib, light)
      else if (variant === 'ribbons') drawRibbons(vib, light, dark, corners, strip)
      else if (variant === 'dots') drawDots(vib, light, strip)
      else if (variant === 'fan') (strip ? drawFanStrip : drawFan)(vib, light, dark, corners, peaks, progress)
      else if (strip) drawStripBars(hexToRgb(accentOf(palette)), dark)
      else drawBars(vib, light)
    }

    let raf = 0
    function frame() {
      const { mode, getAnalyser, active } = stateRef.current
      const analyser = active ? getAnalyser() : null
      const moving = sample(analyser)
      phase += 1
      drawScene()

      // Parking: hidden tabs never animate; an inactive strip parks once settled (full
      // mode keeps its ambient drift while visible, e.g. aurora's slow color field).
      if (document.hidden) return
      if (mode === 'strip' && !active && !moving) return
      raf = requestAnimationFrame(frame)
    }

    function kick() {
      if (reduced) return
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(frame)
    }
    kickRef.current = kick

    resize()
    if (reduced) {
      // One calm static frame, no motion.
      sample(null)
      drawScene()
    } else {
      raf = requestAnimationFrame(frame)
    }

    const onVisibility = () => { if (!document.hidden) kick() }
    document.addEventListener('visibilitychange', onVisibility)
    const ro = new ResizeObserver(() => { resize(); if (!reduced) kick() })
    ro.observe(cv)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      kickRef.current = () => {}
    }
  }, [])

  // Wake a parked loop when playback resumes or the scene/style changes.
  useEffect(() => { kickRef.current() }, [active, variant, mode])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={cn('pointer-events-none block size-full', className)}
      style={{
        opacity,
        // design-ok(hex-in-tsx): mask alpha ramp, #000 is a mask value not a color
        ...(fade ? { maskImage: 'linear-gradient(90deg,transparent,#000 12%,#000 88%,transparent)', WebkitMaskImage: 'linear-gradient(90deg,transparent,#000 12%,#000 88%,transparent)' } : {}),
      }}
    />
  )
}
