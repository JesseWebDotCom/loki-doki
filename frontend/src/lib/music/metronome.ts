// Smart metronome for the Studio: a Web-Audio click locked to the analysed beat grid.
//
// Rather than run its own tempo clock (which would drift against playback), it reads the
// live playback position from a getter each animation frame and fires a click whenever the
// position crosses the next beat time. That keeps it in sync through seeks and tempo
// changes for free - the beat grid IS the schedule. Downbeats get an accented (higher,
// louder) click. Subdivision inserts/deletes beats: 2× clicks the midpoints, 0.5× clicks
// every other beat.

export interface Beat { time: number; downbeat?: boolean }

export type Subdivision = 0.5 | 1 | 2

export class Metronome {
  private ctx: AudioContext | null = null
  private pan: StereoPannerNode | null = null
  private out: GainNode | null = null
  private raf = 0
  private lastIdx = -1
  private grid: number[] = []          // expanded beat times (with subdivision)
  private downbeatSet = new Set<number>()

  private beats: Beat[] = []
  private subdivision: Subdivision = 1
  private volume = 0.7
  private panValue = 0                 // -1 L .. +1 R
  private enabled = false

  constructor(private getPosition: () => number, private isPlaying: () => boolean) {}

  setBeats(beats: Beat[]) { this.beats = beats ?? []; this.rebuildGrid() }
  setSubdivision(s: Subdivision) { this.subdivision = s; this.rebuildGrid() }
  setVolume(v: number) { this.volume = Math.max(0, Math.min(1, v)); if (this.out) this.out.gain.value = this.volume }
  setPan(p: number) { this.panValue = Math.max(-1, Math.min(1, p)); if (this.pan) this.pan.pan.value = this.panValue }
  isEnabled() { return this.enabled }

  private rebuildGrid() {
    const times = this.beats.map((b) => b.time)
    const down = new Set(this.beats.filter((b) => b.downbeat).map((b) => b.time))
    let grid: number[] = []
    if (this.subdivision === 1) grid = times
    else if (this.subdivision === 0.5) grid = times.filter((_, i) => i % 2 === 0)
    else {
      // 2×: original beats + midpoints between consecutive beats
      for (let i = 0; i < times.length; i++) {
        grid.push(times[i])
        if (i + 1 < times.length) grid.push((times[i] + times[i + 1]) / 2)
      }
    }
    this.grid = grid
    this.downbeatSet = down
    // Reset crossing index to wherever we are now.
    this.lastIdx = this.indexBefore(this.getPosition())
  }

  private indexBefore(pos: number): number {
    let idx = -1
    for (let i = 0; i < this.grid.length; i++) { if (this.grid[i] <= pos) idx = i; else break }
    return idx
  }

  private ensureCtx() {
    if (this.ctx) return
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    this.ctx = new Ctor()
    this.out = this.ctx.createGain()
    this.out.gain.value = this.volume
    this.pan = this.ctx.createStereoPanner()
    this.pan.pan.value = this.panValue
    this.out.connect(this.pan)
    this.pan.connect(this.ctx.destination)
  }

  private click(accent: boolean) {
    if (!this.ctx || !this.out) return
    const t = this.ctx.currentTime
    const osc = this.ctx.createOscillator()
    const env = this.ctx.createGain()
    osc.frequency.value = accent ? 2000 : 1200
    const peak = accent ? 1 : 0.6
    env.gain.setValueAtTime(0.0001, t)
    env.gain.exponentialRampToValueAtTime(peak, t + 0.001)
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.05)
    osc.connect(env); env.connect(this.out)
    osc.start(t); osc.stop(t + 0.06)
  }

  private loop = () => {
    if (!this.enabled) return
    if (this.isPlaying()) {
      const pos = this.getPosition()
      const idx = this.indexBefore(pos)
      if (idx > this.lastIdx && idx >= 0 && idx < this.grid.length) {
        // Fire any beats we just crossed (usually exactly one).
        for (let i = this.lastIdx + 1; i <= idx; i++) {
          const time = this.grid[i]
          this.click(this.downbeatSet.has(time))
        }
      } else if (idx < this.lastIdx) {
        // Seeked backwards.
        this.lastIdx = idx
      }
      this.lastIdx = idx
    }
    this.raf = requestAnimationFrame(this.loop)
  }

  enable() {
    if (this.enabled) return
    this.ensureCtx()
    void this.ctx?.resume()
    this.enabled = true
    this.lastIdx = this.indexBefore(this.getPosition())
    this.raf = requestAnimationFrame(this.loop)
  }

  disable() {
    this.enabled = false
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private disposed = false
  isDisposed() { return this.disposed }
  dispose() {
    this.disposed = true
    this.disable()
    try { this.ctx?.close() } catch { /* ignore */ }
    this.ctx = null; this.out = null; this.pan = null
  }
}
