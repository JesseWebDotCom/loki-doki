// Server-side chime/alarm-tone synthesis. A "recipe" fully describes a short sound
// (waveform + a sequence/chord of notes + an ADSR envelope + optional reverb); we
// render it to a 16 kHz mono 16-bit WAV here so the DEVICE never synthesises — it
// only plays the rendered file. Earcons and looping alarm tones share this path.
//
// 16 kHz mono matches the Pod's I2S/codec config (POD_TTS_RATE in satelliteSession),
// so a Tab5 plays it back with no resampling. Pure DSP, no external deps.

import { createHash } from 'node:crypto'

export const POD_AUDIO_RATE = 16000

export type Waveform = 'sine' | 'triangle' | 'square' | 'sawtooth' | 'fm'

export interface ChimeNote {
  freq: number       // Hz
  start_ms: number   // onset within the chime
  dur_ms: number     // sounding length (before release tail)
  gain?: number      // 0–1, default 0.8
}

export interface ChimeEnvelope {
  attack_ms?: number
  decay_ms?: number
  sustain?: number   // 0–1 level held after decay
  release_ms?: number
}

export interface ChimeEffects {
  reverb?: number    // 0–1 wet mix of a simple comb/all-pass tail
}

export interface ChimeRecipe {
  sample_rate?: number
  waveform?: Waveform
  notes?: ChimeNote[]
  envelope?: ChimeEnvelope
  effects?: ChimeEffects
  /** For alarm tones: total looped length in ms (silence-padded so the loop breathes). */
  loop_ms?: number
}

const DEFAULT_ENV: Required<ChimeEnvelope> = { attack_ms: 6, decay_ms: 50, sustain: 0.35, release_ms: 140 }

/** ADSR amplitude at time `t` (s) for a note that sounds for `dur` (s). */
function adsr(t: number, dur: number, env: Required<ChimeEnvelope>): number {
  const a = env.attack_ms / 1000
  const d = env.decay_ms / 1000
  const r = env.release_ms / 1000
  if (t < 0) return 0
  if (t < a) return t / Math.max(a, 1e-4)                       // attack
  if (t < a + d) return 1 - (1 - env.sustain) * ((t - a) / Math.max(d, 1e-4)) // decay
  if (t < dur) return env.sustain                               // sustain
  const rt = t - dur
  if (rt < r) return env.sustain * (1 - rt / Math.max(r, 1e-4)) // release
  return 0
}

/** One oscillator sample at phase θ (radians). FM adds a fixed-ratio modulator. */
function osc(wave: Waveform, theta: number): number {
  switch (wave) {
    case 'sine': return Math.sin(theta)
    case 'triangle': return (2 / Math.PI) * Math.asin(Math.sin(theta))
    case 'square': return Math.sin(theta) >= 0 ? 1 : -1
    case 'sawtooth': {
      const p = (theta / (2 * Math.PI)) % 1
      return 2 * p - 1
    }
    case 'fm': return Math.sin(theta + 2.0 * Math.sin(theta * 2)) // bright bell-ish
    default: return Math.sin(theta)
  }
}

/** Render a recipe to mono Float32 PCM (normalized to ~0.9 peak). */
export function renderChimeFloat(recipe: ChimeRecipe): Float32Array {
  const rate = recipe.sample_rate ?? POD_AUDIO_RATE
  const wave = recipe.waveform ?? 'sine'
  const env = { ...DEFAULT_ENV, ...(recipe.envelope ?? {}) }
  const notes = (recipe.notes ?? []).filter((n) => n && n.freq > 0 && n.dur_ms > 0)

  // Total length = last note end + release, then padded to loop_ms if given.
  let endMs = 0
  for (const n of notes) endMs = Math.max(endMs, n.start_ms + n.dur_ms + env.release_ms)
  const totalMs = Math.max(endMs, recipe.loop_ms ?? 0, 60)
  const N = Math.max(1, Math.ceil((totalMs / 1000) * rate))
  const out = new Float32Array(N)

  for (const n of notes) {
    const start = Math.floor((n.start_ms / 1000) * rate)
    const dur = n.dur_ms / 1000
    const tail = env.release_ms / 1000
    const len = Math.ceil((dur + tail) * rate)
    const gain = n.gain ?? 0.8
    const w = 2 * Math.PI * n.freq / rate
    for (let i = 0; i < len; i++) {
      const idx = start + i
      if (idx >= N) break
      const t = i / rate
      out[idx]! += osc(wave, w * i) * adsr(t, dur, env) * gain
    }
  }

  // Optional cheap reverb: a couple of feedback-comb taps mixed in.
  const wet = recipe.effects?.reverb ?? 0
  if (wet > 0) applyReverb(out, rate, Math.min(1, wet))

  normalize(out, 0.9)
  return out
}

/** Two short feedback combs → a simple, cheap reverb tail. Mutates `buf`. */
function applyReverb(buf: Float32Array, rate: number, wet: number): void {
  const combs: Array<{ delay: number; fb: number }> = [
    { delay: Math.floor(0.029 * rate), fb: 0.5 },
    { delay: Math.floor(0.037 * rate), fb: 0.42 },
  ]
  const dry = 1 - wet * 0.5
  const acc = new Float32Array(buf.length)
  for (const c of combs) {
    for (let i = 0; i < buf.length; i++) {
      const d = i - c.delay
      const echoed = d >= 0 ? acc[d]! * c.fb + buf[i]! : buf[i]!
      acc[i] = echoed
    }
  }
  for (let i = 0; i < buf.length; i++) buf[i] = dry * buf[i]! + wet * 0.5 * acc[i]!
}

function normalize(buf: Float32Array, peak: number): void {
  let max = 0
  for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]!); if (a > max) max = a }
  if (max < 1e-5) return
  const g = peak / max
  for (let i = 0; i < buf.length; i++) buf[i] = buf[i]! * g
}

/** Encode mono Float32 PCM as a 16-bit PCM WAV (RIFF) Buffer. */
export function encodeWav(mono: Float32Array, rate = POD_AUDIO_RATE): Buffer {
  const dataLen = mono.length * 2
  const buf = Buffer.alloc(44 + dataLen)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataLen, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)          // PCM chunk size
  buf.writeUInt16LE(1, 20)           // PCM format
  buf.writeUInt16LE(1, 22)           // mono
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)    // byte rate
  buf.writeUInt16LE(2, 32)           // block align
  buf.writeUInt16LE(16, 34)          // bits per sample
  buf.write('data', 36)
  buf.writeUInt32LE(dataLen, 40)
  let o = 44
  for (let i = 0; i < mono.length; i++) {
    let s = mono[i]!
    s = s > 1 ? 1 : s < -1 ? -1 : s
    buf.writeInt16LE(Math.round(s * 32767), o)
    o += 2
  }
  return buf
}

/** Render a recipe straight to a WAV Buffer at the device playback rate. */
export function renderChimeWav(recipe: ChimeRecipe): Buffer {
  return encodeWav(renderChimeFloat(recipe), recipe.sample_rate ?? POD_AUDIO_RATE)
}

export function wavSha256(wav: Buffer): string {
  return createHash('sha256').update(wav).digest('hex')
}
