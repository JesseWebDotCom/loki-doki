// Music Studio multitrack stem engine (AudioBuffer + SoundTouch insert).
//
// Each stem is fetched once, decoded to an AudioBuffer, and played via an
// AudioBufferSourceNode -> SoundTouchNode (time-stretch/pitch-shift insert) -> per-stem
// GainNode -> master -> analyser -> destination.
//
// Independent tempo + pitch (per @soundtouchjs/audio-worklet):
//   • TEMPO (pitch-preserved): source.playbackRate = r AND stNode.playbackRate = r
//     (the processor divides pitch by r to compensate) -> plays r× speed, same pitch.
//   • TRANSPOSE (tempo-preserved): stNode.pitchSemitones = n.
// If the worklet fails to register (old browser / load error) we fall back to plain buffer
// playback (source -> gain): tempo still works via playbackRate but couples pitch, and
// transpose is a no-op. Playback never breaks.

import { SoundTouchNode } from '@soundtouchjs/audio-worklet'
import soundtouchProcessorUrl from '@soundtouchjs/audio-worklet/processor?url'

export interface StemTrack { name: string; url: string }

export interface LoadedStem {
  name: string
  gain: GainNode
  st: SoundTouchNode | null
  buffer: AudioBuffer
  peaks: number[]
  muted: boolean
  volume: number
  source: AudioBufferSourceNode | null
}

type Listener = () => void
const WAVE_BUCKETS = 160

function computePeaks(buffer: AudioBuffer): number[] {
  const ch = buffer.getChannelData(0)
  const step = Math.max(1, Math.floor(ch.length / WAVE_BUCKETS))
  const peaks: number[] = []
  for (let b = 0; b < WAVE_BUCKETS; b++) {
    let max = 0
    const start = b * step
    for (let i = 0; i < step; i++) { const v = Math.abs(ch[start + i] ?? 0); if (v > max) max = v }
    peaks.push(max)
  }
  return peaks
}

// First moment the vocals stem clearly rises out of silence (50ms RMS windows, ~-18dB below the
// stem's own peak, sustained 150ms so a stray click/pop can't trigger it). Used to auto-align
// externally-sourced lyric timestamps - which are timed to whatever recording LRCLIB happened to
// match, not necessarily THIS edit/re-recording - to this track's actual audio. Null if nothing
// rises clearly above the noise floor (e.g. a near-silent or corrupt stem).
function detectOnsetSec(buffer: AudioBuffer): number | null {
  const ch = buffer.getChannelData(0)
  const sr = buffer.sampleRate
  const windowSize = Math.max(1, Math.round(sr * 0.05))
  const windows = Math.floor(ch.length / windowSize)
  if (windows < 4) return null
  const rms = new Array<number>(windows)
  let peak = 0
  for (let w = 0; w < windows; w++) {
    let sum = 0
    const start = w * windowSize
    for (let i = 0; i < windowSize; i++) { const v = ch[start + i] ?? 0; sum += v * v }
    const r = Math.sqrt(sum / windowSize)
    rms[w] = r
    if (r > peak) peak = r
  }
  if (peak <= 0) return null
  const threshold = peak * 0.12
  const sustain = 3
  for (let w = 0; w < windows - sustain; w++) {
    let ok = true
    for (let k = 0; k < sustain; k++) { if (rms[w + k] < threshold) { ok = false; break } }
    if (ok) return (w * windowSize) / sr
  }
  return null
}

export class StemEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private stems: LoadedStem[] = []
  private soloName: string | null = null
  private playing = false
  private duration = 0
  private rate = 1           // tempo ratio (pitch-preserved via SoundTouch)
  private semitones = 0      // transpose
  private startAtCtxTime = 0
  private pausedPosition = 0
  private disposed = false
  private stRegistered = false   // SoundTouch worklet module registered on this ctx
  private vocalOnsetSec: number | null | undefined = undefined   // memoized; undefined = not computed yet

  private listeners = new Set<Listener>()
  onChange(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  private emit() { for (const l of this.listeners) { try { l() } catch { /* ignore */ } } }

  getAnalyser(): AnalyserNode | null { return this.analyser }
  isPlaying(): boolean { return this.playing }
  getDuration(): number { return this.duration }
  getStems(): LoadedStem[] { return this.stems }
  getSolo(): string | null { return this.soloName }
  getTempoRatio(): number { return this.rate }
  getSemitones(): number { return this.semitones }
  isDisposed(): boolean { return this.disposed }
  /** True once the SoundTouch worklet is available (independent pitch/tempo). */
  hasTimeStretch(): boolean { return this.stRegistered }

  /** Best-effort vocal onset (seconds), or null if there's no separated vocals stem loaded. */
  getVocalOnsetSec(): number | null {
    if (this.vocalOnsetSec !== undefined) return this.vocalOnsetSec
    const vocals = this.stems.find((s) => s.name === 'vocals')
    this.vocalOnsetSec = vocals ? detectOnsetSec(vocals.buffer) : null
    return this.vocalOnsetSec
  }

  getMixPeaks(): number[] {
    if (this.stems.length === 0) return []
    const n = this.stems[0].peaks.length
    const mix = new Array(n).fill(0)
    for (const s of this.stems) for (let i = 0; i < n; i++) mix[i] += s.peaks[i] ?? 0
    const max = Math.max(...mix, 0.0001)
    return mix.map((v) => v / max)
  }

  getPosition(): number {
    if (!this.ctx || !this.playing) return this.pausedPosition
    return Math.max(0, Math.min(this.duration, (this.ctx.currentTime - this.startAtCtxTime) * this.rate))
  }

  /** Create + resume the AudioContext from within a user gesture. Safari refuses to ever start
   *  a context that was first created outside a gesture (e.g. in a load effect), so callers
   *  should invoke this from the first click/tap on the page. Safe to call repeatedly. */
  unlock(): void {
    if (this.disposed) return
    const ctx = this.ensureCtx()
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
  }

  private ensureCtx(): AudioContext {
    if (this.ctx) return this.ctx
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctor()
    const master = ctx.createGain()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.55
    analyser.minDecibels = -85
    analyser.maxDecibels = -12
    master.connect(analyser)
    analyser.connect(ctx.destination)
    this.ctx = ctx; this.master = master; this.analyser = analyser
    return ctx
  }

  private async registerSoundTouch(ctx: AudioContext): Promise<void> {
    if (this.stRegistered) return
    try { await SoundTouchNode.register(ctx, soundtouchProcessorUrl); this.stRegistered = true }
    catch { this.stRegistered = false }   // fall back to coupled playback
  }

  async load(tracks: StemTrack[]): Promise<void> {
    if (this.disposed) return
    const ctx = this.ensureCtx()
    await ctx.resume().catch(() => {})
    await this.registerSoundTouch(ctx)
    if (this.disposed) return
    this.stop()
    this.disposeStems()
    this.vocalOnsetSec = undefined

    const results = await Promise.all(tracks.map(async (t) => {
      try {
        const res = await fetch(t.url, { credentials: 'include' })
        if (!res.ok) throw new Error(`stem ${t.name} HTTP ${res.status}`)
        return { name: t.name, buffer: await ctx.decodeAudioData(await res.arrayBuffer()) }
      } catch { return null }
    }))
    if (this.disposed || !this.master || ctx.state === 'closed') return

    const loaded: LoadedStem[] = []
    for (const t of tracks) {
      const r = results.find((x) => x?.name === t.name)
      if (!r) continue
      const gain = ctx.createGain()
      gain.connect(this.master)
      let st: SoundTouchNode | null = null
      if (this.stRegistered) {
        try { st = new SoundTouchNode({ context: ctx }); st.connect(gain) } catch { st = null }
      }
      loaded.push({ name: t.name, gain, st, buffer: r.buffer, peaks: computePeaks(r.buffer), muted: false, volume: 1, source: null })
    }
    this.stems = loaded
    this.duration = loaded.reduce((m, s) => Math.max(m, s.buffer.duration), 0)
    this.pausedPosition = 0
    this.soloName = null
    this.applyGains()
    this.emit()
  }

  private applyGains() {
    for (const s of this.stems) {
      const audible = this.soloName ? s.name === this.soloName : !s.muted
      s.gain.gain.value = audible ? s.volume : 0
    }
  }

  private startSources(fromPos: number) {
    if (!this.ctx) return
    const when = this.ctx.currentTime + 0.03
    this.startAtCtxTime = when - fromPos / this.rate
    // The longest stem determines when playback naturally ends.
    let longest: { s: LoadedStem; dur: number } | null = null
    for (const s of this.stems) {
      const src = this.ctx.createBufferSource()
      src.buffer = s.buffer
      src.playbackRate.value = this.rate
      if (s.st) {
        src.connect(s.st)
        s.st.playbackRate.value = this.rate       // compensate pitch for the tempo change
        s.st.pitchSemitones.value = this.semitones // transpose
      } else {
        src.connect(s.gain)
      }
      src.start(when, Math.min(fromPos, Math.max(0, s.buffer.duration - 0.01)))
      s.source = src
      if (!longest || s.buffer.duration > longest.dur) longest = { s, dur: s.buffer.duration }
    }
    // Detect natural end-of-playback: without this the transport stayed "playing" over silence,
    // the play/pause button showed Pause forever, and metronome/lyrics logic keyed on isPlaying()
    // kept running. stopSources() nulls onended before stop(), so this only fires on a real end.
    if (longest) {
      longest.s.source!.onended = () => {
        if (!this.playing || this.stems.find((x) => x.name === longest!.s.name)?.source !== longest!.s.source) return
        this.stopSources()
        this.playing = false
        this.pausedPosition = 0
        this.emit()
      }
    }
  }

  private stopSources() {
    for (const s of this.stems) {
      if (s.source) { try { s.source.onended = null; s.source.stop() } catch { /* already stopped */ } s.source = null }
    }
  }

  async play() {
    if (this.playing || this.stems.length === 0) return
    const ctx = this.ensureCtx()
    await ctx.resume().catch(() => {})
    this.startSources(this.pausedPosition)
    this.playing = true
    this.emit()
  }

  pause() {
    if (!this.playing) return
    this.pausedPosition = this.getPosition()
    this.stopSources()
    this.playing = false
    this.emit()
  }

  toggle() { this.playing ? this.pause() : void this.play() }

  seek(pos: number) {
    const p = Math.max(0, Math.min(this.duration, pos))
    if (this.playing) { this.stopSources(); this.startSources(p) }
    else this.pausedPosition = p
    this.emit()
  }

  /** Set the tempo ratio (1 = original). Pitch is preserved when the worklet is available. */
  setTempoRatio(r: number) {
    const clamped = Math.max(0.5, Math.min(2, r))
    const p = this.getPosition()
    this.rate = clamped
    if (this.ctx && this.playing) this.startAtCtxTime = this.ctx.currentTime - p / this.rate
    for (const s of this.stems) {
      if (s.source) s.source.playbackRate.value = this.rate
      if (s.st) s.st.playbackRate.value = this.rate
    }
    this.emit()
  }

  /** Transpose by `n` semitones (0 = original). No-op without the worklet. */
  setSemitones(n: number) {
    this.semitones = Math.max(-12, Math.min(12, Math.round(n)))
    for (const s of this.stems) if (s.st) s.st.pitchSemitones.value = this.semitones
    this.emit()
  }

  setStemVolume(name: string, volume: number) {
    const s = this.stems.find((x) => x.name === name); if (!s) return
    s.volume = Math.max(0, Math.min(1, volume)); this.applyGains(); this.emit()
  }
  setMuted(name: string, muted: boolean) {
    const s = this.stems.find((x) => x.name === name); if (!s) return
    s.muted = muted; this.applyGains(); this.emit()
  }
  toggleSolo(name: string) {
    this.soloName = this.soloName === name ? null : name; this.applyGains(); this.emit()
  }

  stop() {
    this.stopSources()
    this.playing = false
    this.pausedPosition = 0
    this.emit()
  }

  private disposeStems() {
    this.stopSources()
    for (const s of this.stems) { try { s.st?.disconnect() } catch { /* ignore */ } try { s.gain.disconnect() } catch { /* ignore */ } }
    this.stems = []
  }

  dispose() {
    this.disposed = true
    this.disposeStems()
    try { this.ctx?.close() } catch { /* ignore */ }
    this.ctx = null; this.master = null; this.analyser = null
    this.listeners.clear()
  }
}
