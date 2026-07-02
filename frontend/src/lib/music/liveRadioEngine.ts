// Live internet radio playback engine — a lightweight sibling of RadioEngine (one plain
// <audio> element, no decks/DJ/mixing) that runs from a global context so a station keeps
// playing as you move around the app.
//
// Two modes:
//   'live'      — an infinite station stream proxied by /api/music/radio/live/stream/:key.
//                 Not seekable; durationSec stays 0. Pausing a live stream leaves the element
//                 buffering STALE audio, so resume re-sets the src (cache-busted) and plays —
//                 rejoining the live edge instead of replaying the buffer.
//   'recording' — a finite saved recording (Range-supported mp3). Normal pause/resume + seek.
//
// Like RadioEngine, the element is routed through a read-only Web-Audio analyser tap
// (source → destination + source → analyser) for the EQ visualizer. The bytes are same-origin
// proxied, so createMediaElementSource carries real samples (see radioEngine.ts for the full
// history of the cross-origin-silence gotcha).

export type LiveRadioMode = 'live' | 'recording'

export interface LiveStationRef { id: string; name: string; favicon?: string | null }
export interface LiveRecordingRef { id: string; title: string; stationName: string | null }

export interface LiveRadioState {
  active: boolean
  mode: LiveRadioMode
  station: LiveStationRef | null
  recording: LiveRecordingRef | null
  paused: boolean
  loading: boolean
  error: string | null
  positionSec: number
  durationSec: number
  volume: number
  muted: boolean
}

export const initialLiveRadioState: LiveRadioState = {
  active: false, mode: 'live', station: null, recording: null,
  paused: false, loading: false, error: null,
  positionSec: 0, durationSec: 0, volume: 1, muted: false,
}

export class LiveRadioEngine {
  private el: HTMLAudioElement | null = null
  private runId = 0            // bumped on stop/new-play to invalidate stale element events
  private liveSrc = ''         // base live-stream URL (re-set with a cache-bust on resume)
  private lastPosSec = -1

  // Analyser tap — same construction as RadioEngine: shared AudioContext, source →
  // destination + source → analyser. createMediaElementSource may only be called once per
  // element (even across contexts), so the tap is guarded and lives for the engine's lifetime.
  private actx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private tapped = new WeakSet<HTMLMediaElement>()

  private state: LiveRadioState = { ...initialLiveRadioState }

  constructor(private emit: (s: LiveRadioState) => void) {}

  private set(patch: Partial<LiveRadioState>) {
    this.state = { ...this.state, ...patch }
    this.emit(this.state)
  }

  private ensureAudio(): HTMLAudioElement {
    if (this.el) return this.el
    const el = new Audio()
    el.preload = 'auto'
    // Must be set BEFORE src so the (same-origin proxied) bytes aren't CORS-tainted for the tap.
    el.crossOrigin = 'anonymous'
    const runOk = (runId: number) => runId === this.runId && this.state.active
    const bind = () => {
      const runId = this.runId
      el.onerror = () => { if (runOk(runId)) this.set({ error: 'Station is not responding', loading: false }) }
      el.onstalled = () => { if (runOk(runId) && !this.state.paused) this.set({ loading: true }) }
      el.onwaiting = () => { if (runOk(runId) && !this.state.paused) this.set({ loading: true }) }
      el.onplaying = () => { if (runOk(runId)) this.set({ loading: false, error: null, paused: false }) }
      el.onended = () => { if (runOk(runId) && this.state.mode === 'recording') this.set({ paused: true, positionSec: this.state.durationSec }) }
      el.onloadedmetadata = () => {
        if (!runOk(runId) || this.state.mode !== 'recording') return
        this.set({ durationSec: Number.isFinite(el.duration) ? el.duration : 0 })
      }
      el.ontimeupdate = () => {
        if (!runOk(runId) || this.state.mode !== 'recording') return
        const sec = Math.floor(el.currentTime)
        if (sec === this.lastPosSec) return
        this.lastPosSec = sec
        this.set({ positionSec: el.currentTime, durationSec: Number.isFinite(el.duration) ? el.duration : 0 })
      }
    }
    this.rebind = bind
    bind()
    this.el = el
    this.applyVol()
    return el
  }
  private rebind: () => void = () => {}

  /** Lazily build the shared AudioContext + AnalyserNode. Call from a user gesture (play)
   *  so the context isn't born suspended. */
  private ensureAnalyser() {
    if (this.analyser || !this.el) return
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      this.actx = new Ctor()
      this.analyser = this.actx.createAnalyser()
      this.analyser.fftSize = 512
      this.analyser.smoothingTimeConstant = 0.55
      this.analyser.minDecibels = -85
      this.analyser.maxDecibels = -12
      void this.actx.resume?.()   // inside the play() click gesture
      this.tap(this.el)
    } catch { this.actx = null; this.analyser = null }
  }

  /** Route the element through Web Audio: source → destination (audio) + source → analyser.
   *  Idempotent per element (createMediaElementSource throws on a second call). */
  private tap(el: HTMLMediaElement) {
    if (!this.analyser || !this.actx || this.tapped.has(el)) return
    try {
      const src = this.actx.createMediaElementSource(el)
      src.connect(this.actx.destination)  // keep it audible
      src.connect(this.analyser)          // parallel read tap
      this.tapped.add(el)
    } catch { /* already sourced or unsupported */ }
  }

  /** The live AnalyserNode for real-time frequency data, or null if analysis isn't available. */
  getAnalyser(): AnalyserNode | null { return this.analyser }

  private play(el: HTMLAudioElement) {
    void this.actx?.resume?.()
    void el.play().then(() => this.tap(el)).catch(() => { /* AbortError on rapid switch, or blocked */ })
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  /** Tune into a live stream. `station.id` is a saved library row id, or 'rb:<uuid>' to
   *  preview a radio-browser search result before adding it. */
  playLive(station: LiveStationRef & { preview?: boolean }) {
    const el = this.ensureAudio()
    this.runId++
    this.rebind()
    this.lastPosSec = -1
    this.set({
      active: true, mode: 'live', station: { id: station.id, name: station.name, favicon: station.favicon ?? null },
      recording: null, paused: false, loading: true, error: null, positionSec: 0, durationSec: 0,
    })
    this.ensureAnalyser()   // inside the click gesture
    this.liveSrc = `/api/music/radio/live/stream/${station.id}`
    try { el.pause() } catch { /* noop */ }
    el.src = this.liveSrc
    el.load()
    this.play(el)
  }

  /** Play a finite saved recording (seekable). */
  playRecording(rec: LiveRecordingRef) {
    const el = this.ensureAudio()
    this.runId++
    this.rebind()
    this.lastPosSec = -1
    this.set({
      active: true, mode: 'recording', station: null,
      recording: { id: rec.id, title: rec.title, stationName: rec.stationName ?? null },
      paused: false, loading: true, error: null, positionSec: 0, durationSec: 0,
    })
    this.ensureAnalyser()
    this.liveSrc = ''
    try { el.pause() } catch { /* noop */ }
    el.src = `/api/music/radio/live/recordings/${rec.id}/audio`
    el.load()
    this.play(el)
  }

  togglePause() {
    const el = this.el
    if (!el || !this.state.active) return
    if (!this.state.paused) {
      el.pause()
      this.set({ paused: true, loading: false })
      return
    }
    if (this.state.mode === 'live') {
      // Rejoin the live edge: the paused element has been buffering stale audio, so a plain
      // play() would resume in the past. Re-set the src (cache-busted) and play fresh.
      this.set({ paused: false, loading: true, error: null })
      el.src = `${this.liveSrc}?ts=${Date.now()}`
      el.load()
      this.play(el)
    } else {
      this.set({ paused: false })
      this.play(el)
    }
  }

  /** Scrub a RECORDING to an absolute position (seconds). No-op for live streams. */
  seek(sec: number) {
    const el = this.el
    if (!el || !this.state.active || this.state.mode !== 'recording') return
    const d = el.duration
    if (!Number.isFinite(d) || d <= 0) return
    const t = Math.max(0, Math.min(sec, d))
    try { el.currentTime = t } catch { return }
    this.lastPosSec = Math.floor(t)
    this.set({ positionSec: t })
  }

  stop() {
    this.runId++
    const el = this.el
    if (el) {
      try { el.pause() } catch { /* noop */ }
      el.removeAttribute('src')
      try { el.load() } catch { /* noop */ }   // actually drop the open stream connection
    }
    this.set({
      active: false, station: null, recording: null, paused: false,
      loading: false, error: null, positionSec: 0, durationSec: 0,
    })
  }

  private applyVol() {
    if (!this.el) return
    this.el.muted = this.state.muted
    this.el.volume = Math.max(0, Math.min(1, this.state.volume))
  }

  setVolume(v: number) {
    const vol = Math.max(0, Math.min(1, v))
    this.set({ volume: vol, muted: vol > 0 ? false : this.state.muted })
    this.applyVol()
  }

  toggleMute() {
    this.set({ muted: !this.state.muted })
    this.applyVol()
  }

  // Keep the Web Audio graph intact across teardown/revival (createMediaElementSource can't
  // be re-run on an element) — the engine instance is reused, so the graph persists.
  destroy() { this.stop() }
}
