// Alarm/timer tones. A "tone" is a string: either a synthesized built-in
// ("builtin:<key>") or a saved music-engine track ("track:<id>", served from
// /api/music/tracks/:id/audio as a loopable WAV). startRinging() resolves either
// kind and loops it until the returned handle is stopped — used by the global
// TimeAlarmContext when an alarm/timer fires, and by TonePicker for previews.

export interface RingHandle {
  stop: () => void
}

interface ToneNote {
  /** Frequency in Hz. */
  f: number
  /** Start offset within the loop period, seconds. */
  t: number
  /** Duration, seconds. */
  d: number
  type?: OscillatorType
  gain?: number
}

export interface BuiltinTone {
  key: string
  label: string
  /** Seconds per loop iteration. */
  period: number
  notes: ToneNote[]
}

// A small, distinct set of synthesized ringtones. Kept deliberately simple (a few
// oscillator beeps per loop) so they need no assets and ring instantly offline.
export const BUILTIN_TONES: BuiltinTone[] = [
  {
    key: 'radar', label: 'Radar', period: 1.25,
    notes: [
      { f: 1047, t: 0.0, d: 0.12, type: 'triangle' },
      { f: 1047, t: 0.2, d: 0.12, type: 'triangle' },
      { f: 1319, t: 0.4, d: 0.12, type: 'triangle' },
      { f: 1319, t: 0.6, d: 0.18, type: 'triangle' },
    ],
  },
  {
    key: 'beacon', label: 'Beacon', period: 1.4,
    notes: [
      { f: 880, t: 0.0, d: 0.22, type: 'sine' },
      { f: 660, t: 0.45, d: 0.22, type: 'sine' },
    ],
  },
  {
    key: 'chimes', label: 'Chimes', period: 2.0,
    notes: [
      { f: 523, t: 0.0, d: 0.4, type: 'sine', gain: 0.5 },
      { f: 659, t: 0.28, d: 0.4, type: 'sine', gain: 0.5 },
      { f: 784, t: 0.56, d: 0.4, type: 'sine', gain: 0.5 },
      { f: 1047, t: 0.84, d: 0.6, type: 'sine', gain: 0.5 },
    ],
  },
  {
    key: 'bells', label: 'Bells', period: 0.9,
    notes: [
      { f: 1175, t: 0.0, d: 0.09, type: 'square', gain: 0.32 },
      { f: 880, t: 0.12, d: 0.09, type: 'square', gain: 0.32 },
      { f: 1175, t: 0.24, d: 0.09, type: 'square', gain: 0.32 },
      { f: 880, t: 0.36, d: 0.09, type: 'square', gain: 0.32 },
      { f: 1175, t: 0.48, d: 0.09, type: 'square', gain: 0.32 },
    ],
  },
  {
    key: 'pulse', label: 'Pulse', period: 0.8,
    notes: [{ f: 1000, t: 0.0, d: 0.16, type: 'sine' }],
  },
  {
    key: 'cosmic', label: 'Cosmic', period: 1.8,
    notes: [
      { f: 392, t: 0.0, d: 0.5, type: 'sawtooth', gain: 0.28 },
      { f: 523, t: 0.4, d: 0.5, type: 'sawtooth', gain: 0.28 },
      { f: 784, t: 0.8, d: 0.7, type: 'sawtooth', gain: 0.28 },
    ],
  },
]

export const DEFAULT_ALARM_TONE = 'builtin:radar'
export const DEFAULT_TIMER_TONE = 'builtin:beacon'

export function getBuiltinTone(key: string): BuiltinTone | undefined {
  return BUILTIN_TONES.find((t) => t.key === key)
}

/** Human-readable name for a tone string, preferring a stored display name. */
export function toneDisplayName(tone: string | null | undefined, storedName?: string | null): string {
  if (storedName) return storedName
  if (tone?.startsWith('builtin:')) return getBuiltinTone(tone.slice(8))?.label ?? 'Tone'
  if (tone?.startsWith('track:')) return 'Custom tone'
  return 'Tone'
}

// ── WebAudio plumbing for built-in tones ─────────────────────────────────────
let ctx: AudioContext | null = null
function audioCtx(): AudioContext {
  if (!ctx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    ctx = new Ctor()
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

function scheduleNote(ac: AudioContext, dest: GainNode, note: ToneNote, when: number): void {
  const osc = ac.createOscillator()
  const env = ac.createGain()
  osc.type = note.type ?? 'sine'
  osc.frequency.value = note.f
  const peak = note.gain ?? 0.4
  // Short attack + exponential release so each beep reads as a clean "ping".
  env.gain.setValueAtTime(0.0001, when)
  env.gain.exponentialRampToValueAtTime(peak, when + 0.01)
  env.gain.exponentialRampToValueAtTime(0.0001, when + note.d)
  osc.connect(env).connect(dest)
  osc.start(when)
  osc.stop(when + note.d + 0.02)
}

function startBuiltin(tone: BuiltinTone): RingHandle {
  const ac = audioCtx()
  const master = ac.createGain()
  master.gain.value = 0.9
  master.connect(ac.destination)

  let nextStart = ac.currentTime + 0.04
  const fireIteration = () => {
    for (const n of tone.notes) scheduleNote(ac, master, n, nextStart + n.t)
    nextStart += tone.period
  }
  fireIteration()
  const interval = window.setInterval(fireIteration, tone.period * 1000)

  return {
    stop: () => {
      window.clearInterval(interval)
      try { master.disconnect() } catch { /* already gone */ }
    },
  }
}

function startTrack(trackId: string): RingHandle {
  const el = new Audio(`/api/music/tracks/${trackId}/audio`)
  el.loop = true
  el.volume = 0.9
  void el.play().catch(() => { /* autoplay can fail if no prior gesture */ })
  return {
    stop: () => {
      el.pause()
      el.src = ''
    },
  }
}

/** Start a tone looping until the handle is stopped. */
export function startRinging(tone: string): RingHandle {
  if (tone.startsWith('track:')) return startTrack(tone.slice(6))
  const key = tone.startsWith('builtin:') ? tone.slice(8) : tone
  const builtin = getBuiltinTone(key) ?? BUILTIN_TONES[0]!
  return startBuiltin(builtin)
}

/** Play a tone as a short preview that auto-stops. Returns a handle to stop early. */
export function previewTone(tone: string, ms = 3200): RingHandle {
  const handle = startRinging(tone)
  const timer = window.setTimeout(() => handle.stop(), ms)
  return {
    stop: () => { window.clearTimeout(timer); handle.stop() },
  }
}
