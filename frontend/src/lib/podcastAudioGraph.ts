// Web-Audio DSP chain for the podcast player (the speech sibling of mediaAudioGraph):
//
//   source ─┬─ dryGain ──────────────────────────┐
//           └─ highpass → compressor → makeup ─ wetGain ┴→ mix → outGain → destination
//                                                          └→ analyser (trim-silence RMS)
//
// Two features hang off it:
//   - Voice boost: broadcast-style speech leveling (compressor + makeup gain) on the wet
//     path; toggling crossfades dry/wet gains, no reconnects.
//   - Trim silence: an interval loop (NOT rAF - podcasts play in background tabs) watches
//     the analyser's RMS; ~250ms under the floor raises playbackRate to ~3x until speech
//     resumes, with a short gain crossfade-back to mask the transition. Wall-clock time
//     saved accumulates here and is flushed to the server by the playback context.
//
// Same contract as mediaAudioGraph: createMediaElementSource is once-per-element-ever, so
// the graph is built at most once (WeakMap) and never torn down; the chain is ADDITIVE -
// if attach fails, playback still works, just without boost/trim.

import { webAudioBreaksBackgroundPlayback } from '@/lib/platform'

export interface PodcastDspSettings {
  voiceBoost: boolean
  trimSilence: boolean
}

interface PodcastGraph {
  ctx: AudioContext
  dryGain: GainNode
  wetGain: GainNode
  mix: GainNode
  duckGain: GainNode
  outGain: GainNode
  analyser: AnalyserNode
}

const graphs = new WeakMap<HTMLMediaElement, PodcastGraph>()
let sharedCtx: AudioContext | null = null
let settings: PodcastDspSettings = { voiceBoost: false, trimSilence: false }

// ── Trim-silence engine state (one engine; the podcast player has one element) ──
const SILENCE_RMS = 0.01          // ~-40 dBFS floor
const SILENCE_HOLD_MS = 250       // must stay quiet this long before speeding up
const TICK_MS = 80
const FAST_FACTOR = 3             // "about 3x"
const MAX_FAST_RATE = 4           // browsers mute media elements past ~4x

let engineEl: HTMLMediaElement | null = null
let engineTimer: ReturnType<typeof setInterval> | null = null
let baseRate = 1
let fastMode = false
let quietSinceMs = 0
let savedSecUnflushed = 0
let savedSecSession = 0
const savedListeners = new Set<() => void>()

function ensureContext(): AudioContext | null {
  if (sharedCtx) return sharedCtx
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  try { sharedCtx = new Ctor() } catch { return null }
  return sharedCtx
}

// Same safety net as mediaAudioGraph: a context suspended while hidden would leave
// the podcast silent after returning to the foreground.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && sharedCtx && sharedCtx.state !== 'running') void sharedCtx.resume?.()
  })
}

const ramp = (param: AudioParam, value: number, ctx: AudioContext, tc = 0.05) => {
  try { param.setTargetAtTime(value, ctx.currentTime, tc) } catch { param.value = value }
}

function applyToGraph(g: PodcastGraph) {
  ramp(g.dryGain.gain, settings.voiceBoost ? 0 : 1, g.ctx)
  ramp(g.wetGain.gain, settings.voiceBoost ? 1 : 0, g.ctx)
}

/** Get (or build) the podcast element's graph. Call from a gesture-adjacent moment
 *  (the element's own 'play' event); safe to call repeatedly. */
export function ensurePodcastGraph(el: HTMLMediaElement): PodcastGraph | null {
  // iOS: sourcing the element into an AudioContext kills background/lock-screen
  // playback (the context suspends when the app hides). The no-graph fallback
  // below (volume/duck/fade on the element itself) covers everything but voice
  // boost and trim silence, which quietly disable on these platforms.
  if (webAudioBreaksBackgroundPlayback()) return null
  const ctx = ensureContext()
  if (!ctx) return null
  void ctx.resume?.()
  const existing = graphs.get(el)
  if (existing) return existing
  try {
    const source = ctx.createMediaElementSource(el)

    // Dry path: untouched speech.
    const dryGain = ctx.createGain()
    dryGain.gain.value = 1

    // Wet path: rumble filter → broadcast compressor → makeup gain.
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 90
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -26
    comp.knee.value = 12
    comp.ratio.value = 4
    comp.attack.value = 0.003
    comp.release.value = 0.25
    const makeup = ctx.createGain()
    makeup.gain.value = 1.9
    const wetGain = ctx.createGain()
    wetGain.gain.value = 0

    const mix = ctx.createGain()
    // Announcement ducking rides its own node so it never fights the sleep-timer
    // fade, which owns outGain (a shared node would leave one of them stranded).
    const duckGain = ctx.createGain()
    const outGain = ctx.createGain()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.3

    source.connect(dryGain)
    dryGain.connect(mix)
    source.connect(hp)
    hp.connect(comp)
    comp.connect(makeup)
    makeup.connect(wetGain)
    wetGain.connect(mix)
    mix.connect(duckGain)
    duckGain.connect(outGain)
    outGain.connect(ctx.destination)
    mix.connect(analyser)   // pre-outGain tap so sleep fades don't read as silence

    const graph: PodcastGraph = { ctx, dryGain, wetGain, mix, duckGain, outGain, analyser }
    graphs.set(el, graph)
    applyToGraph(graph)
    startEngine(el, graph)
    return graph
  } catch {
    // Already sourced elsewhere, or Web Audio unsupported.
    return null
  }
}

/** Push new voice-boost / trim-silence settings (per-show overrides already resolved). */
export function applyPodcastDsp(next: PodcastDspSettings): void {
  settings = { ...next }
  if (engineEl) {
    const g = graphs.get(engineEl)
    if (g) applyToGraph(g)
    if (!settings.trimSilence) exitFastMode(engineEl, graphs.get(engineEl) ?? null)
  }
}

/** The player's real (user/show-chosen) rate. The engine multiplies on top of this. */
export function setPodcastBaseRate(rate: number): void {
  baseRate = Math.max(0.25, Math.min(4, rate || 1))
  if (engineEl && !fastMode) engineEl.playbackRate = baseRate
  if (engineEl && fastMode) engineEl.playbackRate = Math.min(MAX_FAST_RATE, baseRate * FAST_FACTOR)
}

/** Sleep-timer fade hook: ramp output toward `value` (0..1) over `sec`. Falls back to
 *  element volume when no graph is attached. */
export function fadePodcastVolume(el: HTMLMediaElement, value: number, sec: number): void {
  const g = graphs.get(el)
  if (g) {
    try { g.outGain.gain.setTargetAtTime(value, g.ctx.currentTime, Math.max(0.05, sec / 3)) } catch { g.outGain.gain.value = value }
  } else {
    el.volume = Math.max(0, Math.min(1, value))
  }
}

/** Cancel a sleep fade and return the element to its intended level. */
export function resetPodcastVolume(el: HTMLMediaElement): void {
  const g = graphs.get(el)
  if (g) {
    try {
      g.outGain.gain.cancelScheduledValues(g.ctx.currentTime)
      g.outGain.gain.setTargetAtTime(1, g.ctx.currentTime, 0.05)
    } catch { g.outGain.gain.value = 1 }
  }
  applyElementVolume(el)
}

// ── Volume + announcement ducking ───────────────────────────────────────────────
// Three things want to move the podcast's level: the user's volume (remote control /
// family cap), the sleep-timer fade, and companion-speech ducking. They must not fight,
// so each owns a distinct control and the element's own volume carries ONLY the base:
//   • base volume  -> element .volume (via setPodcastVolume)
//   • sleep fade   -> outGain
//   • ducking      -> duckGain
// With no graph attached (Web Audio unavailable, or the element is already sourced
// elsewhere) there is only one knob, so base and duck are multiplied onto .volume and
// the sleep fade temporarily overrides it until resetPodcastVolume restores.

const DUCK_LEVEL = 0.2
let baseVolume = 1
let duckActive = false

function applyElementVolume(el: HTMLMediaElement): void {
  // Graphed: ducking lives on duckGain, so the element carries the base level alone.
  const factor = graphs.get(el) || !duckActive ? 1 : DUCK_LEVEL
  el.volume = Math.max(0, Math.min(1, baseVolume * factor))
}

/** The player's user-facing 0..1 level. Called by PodcastPlaybackContext.setVolume,
 *  which is the public API remote control and the family volume cap drive. */
export function setPodcastVolume(el: HTMLMediaElement | null, v: number): void {
  baseVolume = Math.max(0, Math.min(1, v))
  if (el) applyElementVolume(el)
}

export function duckPodcastForSpeech(): void {
  duckActive = true
  const el = engineEl
  if (!el) return
  const g = graphs.get(el)
  if (g) {
    try { g.duckGain.gain.setTargetAtTime(DUCK_LEVEL, g.ctx.currentTime, 0.05) } catch { g.duckGain.gain.value = DUCK_LEVEL }
  } else {
    applyElementVolume(el)
  }
}

export function unduckPodcastAfterSpeech(): void {
  duckActive = false
  const el = engineEl
  if (!el) return
  const g = graphs.get(el)
  if (g) {
    // ~0.5s restore: setTargetAtTime is exponential, so a 0.17 time constant lands
    // within about a percent of target by 500ms.
    try { g.duckGain.gain.setTargetAtTime(1, g.ctx.currentTime, 0.17) } catch { g.duckGain.gain.value = 1 }
  } else {
    applyElementVolume(el)
  }
}

// ── Trim-silence engine ────────────────────────────────────────────────────────────

function rmsOf(analyser: AnalyserNode, buf: Float32Array): number {
  analyser.getFloatTimeDomainData(buf)
  let sum = 0
  for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!
  return Math.sqrt(sum / buf.length)
}

function exitFastMode(el: HTMLMediaElement, g: PodcastGraph | null): void {
  if (!fastMode) return
  fastMode = false
  el.playbackRate = baseRate
  // Short crossfade-back: dip the mix and recover over ~150ms to mask the rate jump.
  if (g) {
    try {
      g.mix.gain.cancelScheduledValues(g.ctx.currentTime)
      g.mix.gain.setValueAtTime(0.35, g.ctx.currentTime)
      g.mix.gain.setTargetAtTime(1, g.ctx.currentTime, 0.05)
    } catch { g.mix.gain.value = 1 }
  }
}

function startEngine(el: HTMLMediaElement, g: PodcastGraph): void {
  engineEl = el
  if (engineTimer) clearInterval(engineTimer)
  const buf = new Float32Array(g.analyser.fftSize)
  let lastTick = performance.now()
  engineTimer = setInterval(() => {
    const now = performance.now()
    const dt = (now - lastTick) / 1000
    lastTick = now
    if (!settings.trimSilence || el.paused || el.ended) {
      if (fastMode) exitFastMode(el, g)
      quietSinceMs = 0
      return
    }
    const rms = rmsOf(g.analyser, buf)
    if (rms < SILENCE_RMS) {
      if (!quietSinceMs) quietSinceMs = now
      if (!fastMode && now - quietSinceMs >= SILENCE_HOLD_MS) {
        fastMode = true
        el.playbackRate = Math.min(MAX_FAST_RATE, baseRate * FAST_FACTOR)
      }
    } else {
      quietSinceMs = 0
      if (fastMode) exitFastMode(el, g)
    }
    if (fastMode) {
      // Wall time saved vs. playing this stretch at the base rate.
      const factor = Math.min(MAX_FAST_RATE, baseRate * FAST_FACTOR) / baseRate
      const saved = dt * (factor - 1)
      savedSecUnflushed += saved
      savedSecSession += saved
      for (const fn of savedListeners) fn()
    }
  }, TICK_MS)
}

/** Seconds saved since the last takeSavedSeconds() call (for server flush). */
export function takeSavedSeconds(): number {
  const v = savedSecUnflushed
  savedSecUnflushed = 0
  return v
}

/** Seconds saved this browser session (for optimistic "time saved" display). */
export function getSessionSavedSeconds(): number {
  return savedSecSession
}

export function subscribeSavedSeconds(fn: () => void): () => void {
  savedListeners.add(fn)
  return () => { savedListeners.delete(fn) }
}
