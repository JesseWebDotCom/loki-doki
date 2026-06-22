// Offline music engine (`midi-offline`) — the shared core behind both the podcast
// intro/outro stinger picker and the Music app.
//
// Composition is pure music theory (tonal) rendered to multi-track MIDI
// (@tonejs/midi); rendering is a pure-JS SoundFont synth (spessasynth_core) driven
// offline at 24 kHz mono — matching the podcast episode pipeline exactly. The
// SoundFont is fetched once from the backend (which downloads it on first use), so
// the whole thing works fully offline after that first fetch. No native binaries,
// no per-OS assets.
//
// Each style is a *pool* (tempo range, key pool, several progressions, instrument
// alternatives, a groove). A seeded PRNG resolves one concrete arrangement per
// take, so "Regenerate" yields genuinely different — but still on-brand — music.
//
// This module was extracted from podcast/stinger.ts so a general-purpose music
// generator and the stinger picker share one engine. `arrange()` is parameterized
// by a `structure` (intro / outro / loop / bed-friendly full track); the original
// 2-bar intro / 1-bar outro behavior is preserved exactly for the podcast path.

import { Midi } from '@tonejs/midi'
import { Chord, Note, Progression, Scale } from 'tonal'
import {
  audioToWav,
  BasicMIDI,
  SoundBankLoader,
  SpessaSynthProcessor,
  SpessaSynthSequencer,
  type BasicSoundBank,
} from 'spessasynth_core'

export const MUSIC_SAMPLE_RATE = 24000

// ── Seeded randomness (deterministic per take, so intro+outro match) ──────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
const pick = <T>(arr: T[], r: () => number): T => arr[Math.floor(r() * arr.length) % arr.length]!
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

// ── Drum grooves (16-step bar; values are GM note→velocity scalars) ───────────

export type Groove = 'fourfloor' | 'backbeat' | 'boombap' | 'driving' | 'soft' | 'halftime' | 'funk'
const KICK = 36, SNARE = 38, CHH = 42, OHH = 46, CLAP = 39, RIDE = 51, CRASH = 49, TOM = 45

interface DrumLane { note: number; steps: number[]; vel: number }
export const GROOVES: Record<Groove, DrumLane[]> = {
  fourfloor: [
    { note: KICK, steps: [0, 4, 8, 12], vel: 0.95 },
    { note: CLAP, steps: [4, 12], vel: 0.7 },
    { note: CHH, steps: [2, 6, 10, 14], vel: 0.45 },
    { note: OHH, steps: [14], vel: 0.4 },
  ],
  backbeat: [
    { note: KICK, steps: [0, 8, 10], vel: 0.9 },
    { note: SNARE, steps: [4, 12], vel: 0.8 },
    { note: CHH, steps: [0, 2, 4, 6, 8, 10, 12, 14], vel: 0.4 },
  ],
  boombap: [
    { note: KICK, steps: [0, 7, 10], vel: 0.92 },
    { note: SNARE, steps: [4, 12], vel: 0.85 },
    { note: CHH, steps: [0, 2, 4, 6, 8, 10, 12, 14], vel: 0.38 },
  ],
  driving: [
    { note: KICK, steps: [0, 2, 4, 6, 8, 10, 12, 14], vel: 0.85 },
    { note: SNARE, steps: [4, 12], vel: 0.75 },
    { note: CHH, steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], vel: 0.3 },
  ],
  soft: [
    { note: KICK, steps: [0, 8], vel: 0.6 },
    { note: SNARE, steps: [4, 12], vel: 0.4 },
    { note: RIDE, steps: [0, 4, 8, 12], vel: 0.35 },
  ],
  halftime: [
    { note: KICK, steps: [0], vel: 0.95 },
    { note: SNARE, steps: [8], vel: 0.85 },
    { note: CHH, steps: [0, 2, 4, 6, 8, 10, 12, 14], vel: 0.4 },
  ],
  funk: [
    { note: KICK, steps: [0, 6, 10], vel: 0.9 },
    { note: SNARE, steps: [4, 12], vel: 0.8 },
    { note: CHH, steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], vel: 0.32 },
    { note: OHH, steps: [3, 11], vel: 0.45 },
  ],
}
// Where the bassline lands within a bar (16-step), plus which chord tone (0=root,
// 7=octave up, -5=root + 7 semitones).
export const BASS_PATTERNS: Record<Groove, { step: number; tone: 0 | 7 | -5 }[]> = {
  fourfloor: [{ step: 0, tone: 0 }, { step: 4, tone: 0 }, { step: 8, tone: 0 }, { step: 12, tone: 0 }],
  backbeat: [{ step: 0, tone: 0 }, { step: 6, tone: 7 }, { step: 8, tone: 0 }, { step: 14, tone: -5 }],
  boombap: [{ step: 0, tone: 0 }, { step: 10, tone: 0 }, { step: 6, tone: 7 }],
  driving: [{ step: 0, tone: 0 }, { step: 2, tone: 0 }, { step: 4, tone: 0 }, { step: 6, tone: 0 }, { step: 8, tone: 0 }, { step: 10, tone: 0 }, { step: 12, tone: 0 }, { step: 14, tone: 0 }],
  soft: [{ step: 0, tone: 0 }, { step: 8, tone: 7 }],
  halftime: [{ step: 0, tone: 0 }, { step: 8, tone: 0 }],
  funk: [{ step: 0, tone: 0 }, { step: 3, tone: 7 }, { step: 6, tone: 0 }, { step: 7, tone: 7 }, { step: 10, tone: 0 }, { step: 14, tone: -5 }],
}

// ── Procedural pattern generation ─────────────────────────────────────────────
// The fixed GROOVES/BASS_PATTERNS above are kept as fallbacks, but resolveStyle now
// GENERATES a fresh drum kit + bassline per seed (within the style's groove family) so
// takes stop sharing a handful of identical patterns. Seeded → intro/outro stay matched.

export type BassHit = { step: number; tone: 0 | 7 | -5 }
const choice = <T>(a: T[], r: () => number): T => a[Math.floor(r() * a.length)]!

const BASE_KICK: Record<Groove, number[]> = {
  fourfloor: [0, 4, 8, 12], driving: [0, 2, 4, 6, 8, 10, 12, 14], halftime: [0],
  funk: [0, 6, 10], boombap: [0, 7, 10], backbeat: [0, 8, 10], soft: [0, 8],
}
const HAT_DENSITIES = [
  [0, 4, 8, 12],                                                  // quarters
  [2, 6, 10, 14],                                                 // off-beat 8ths
  [0, 2, 4, 6, 8, 10, 12, 14],                                    // straight 8ths
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],        // 16ths
]

/** A drum kit for a groove family, varied per seed but genre-coherent. */
function genDrums(r: () => number, groove: Groove): DrumLane[] {
  const lanes: DrumLane[] = []
  let kick = [...BASE_KICK[groove]]
  if (groove !== 'fourfloor' && groove !== 'driving' && r() < 0.55) {
    const extra = choice([3, 6, 7, 10, 11, 14], r)
    if (!kick.includes(extra)) kick = [...kick, extra].sort((a, b) => a - b)
  }
  lanes.push({ note: KICK, steps: kick, vel: 0.92 })

  // Backbeat (snare or clap), with optional ghost-snare syncopation.
  lanes.push({ note: r() < 0.5 ? SNARE : CLAP, steps: groove === 'halftime' ? [8] : [4, 12], vel: 0.82 })
  if (r() < 0.45) {
    const ghosts = [3, 7, 11, 15].filter(() => r() < 0.4)
    if (ghosts.length) lanes.push({ note: SNARE, steps: ghosts, vel: 0.26 })
  }

  // Hats or ride at a chosen density, with optional open hats.
  const useRide = groove === 'soft' ? r() < 0.6 : r() < 0.18
  lanes.push({ note: useRide ? RIDE : CHH, steps: choice(HAT_DENSITIES, r), vel: useRide ? 0.34 : 0.4 })
  if (!useRide && r() < 0.5) {
    const oh = [3, 7, 11, 15].filter(() => r() < 0.35)
    if (oh.length) lanes.push({ note: OHH, steps: oh, vel: 0.42 })
  }
  return lanes
}

const BASS_ANCHORS: Record<Groove, number[]> = {
  fourfloor: [0, 4, 8, 12], driving: [0, 4, 8, 12], halftime: [0, 8],
  funk: [0, 3, 6, 10, 14], boombap: [0, 6, 10], backbeat: [0, 6, 8, 14], soft: [0, 8],
}
/** A bassline (step + chord tone: 0 root, 7 octave, -5 fifth) for a groove family. */
function genBass(r: () => number, groove: Groove): BassHit[] {
  const tones: (0 | 7 | -5)[] = [0, 0, 0, 7, -5]   // weight toward the root
  return BASS_ANCHORS[groove]
    .filter((_, i) => i === 0 || r() < 0.8)          // always keep the downbeat
    .map((step) => ({ step, tone: step === 0 ? 0 : choice(tones, r) }))
}

// Extra progressions folded into every style's own pool (by mode) for far more harmonic
// variety than the 2–3 each style ships with. Roman numerals tonal can parse.
const EXTRA_PROGS_MAJOR = [
  ['Imaj7', 'vi', 'IV', 'V'], ['I', 'V', 'vi', 'IV'], ['ii', 'V', 'Imaj7', 'vi'],
  ['I', 'IV', 'ii', 'V'], ['vi', 'IV', 'I', 'V'], ['I', 'iii', 'IV', 'V'], ['IV', 'V', 'iii', 'vi'],
]
const EXTRA_PROGS_MINOR = [
  ['i', 'VI', 'III', 'VII'], ['i', 'iv', 'VI', 'V'], ['i', 'VII', 'VI', 'VII'],
  ['i', 'v', 'VI', 'iv'], ['i', 'iv', 'i', 'V'], ['i', 'VI', 'iv', 'V'],
]
const EXTRA_PROGS_DORIAN = [
  ['i7', 'IV7'], ['i7', 'IV', 'i7', 'v'], ['i7', 'iv7', 'V7'], ['i', 'IV', 'VII', 'i'],
]
const extraProgs = (mode: MusicStyle['mode']) =>
  mode === 'minor' ? EXTRA_PROGS_MINOR : mode === 'dorian' ? EXTRA_PROGS_DORIAN : EXTRA_PROGS_MAJOR

// ── Styles (pools the resolver draws from) ────────────────────────────────────
// GM programs (0-indexed). Multiple options per role → variety across takes.

export interface MusicStyle {
  id: string
  label: string
  bpm: [number, number]
  keyPool: string[]
  mode: 'major' | 'minor' | 'dorian'
  progs: string[][]
  padInst: number[]
  bassInst: number[]
  leadInst: number[]
  keysInst?: number[]      // optional secondary chordal/arp layer
  groove: Groove
  swing?: number           // 0..0.3 — pushes off-beat 16ths late
  density?: number         // melody busyness 0..1
  useLead?: boolean
}

export const MUSIC_STYLES: MusicStyle[] = [
  { id: 'warm',      label: 'Warm',      bpm: [88, 100],  keyPool: ['C', 'F', 'G'],  mode: 'major', progs: [['IVmaj7', 'V', 'Imaj7'], ['Imaj7', 'vi', 'IV', 'V'], ['IV', 'I', 'V', 'vi']], padInst: [89, 91], bassInst: [33, 32], leadInst: [4, 5], keysInst: [4], groove: 'soft', density: 0.4 },
  { id: 'newsy',     label: 'Newsy',     bpm: [120, 138], keyPool: ['D', 'G', 'A'],  mode: 'major', progs: [['I', 'IV', 'V'], ['I', 'V', 'IV', 'V'], ['I', 'vi', 'IV', 'V']], padInst: [48, 49], bassInst: [32, 43], leadInst: [56, 60, 61], groove: 'driving', density: 0.55 },
  { id: 'upbeat',    label: 'Upbeat',    bpm: [118, 130], keyPool: ['G', 'C', 'D'],  mode: 'major', progs: [['I', 'V', 'vi', 'IV'], ['vi', 'IV', 'I', 'V'], ['I', 'IV', 'vi', 'V']], padInst: [90, 81], bassInst: [38, 39], leadInst: [81, 80], keysInst: [11], groove: 'fourfloor', density: 0.6 },
  { id: 'lofi',      label: 'Lo-fi',     bpm: [72, 86],   keyPool: ['F', 'Bb', 'Eb'], mode: 'minor', progs: [['i7', 'iv7', 'VII'], ['ii7', 'V7', 'Imaj7'], ['i', 'VI', 'III', 'VII']], padInst: [4, 5], bassInst: [33, 32], leadInst: [4, 11], keysInst: [11], groove: 'boombap', swing: 0.22, density: 0.45 },
  { id: 'cinematic', label: 'Cinematic', bpm: [70, 86],   keyPool: ['A', 'D', 'E'],  mode: 'minor', progs: [['i', 'VI', 'III', 'VII'], ['i', 'iv', 'VII', 'III'], ['VI', 'VII', 'i']], padInst: [49, 50], bassInst: [32, 43], leadInst: [49, 48, 73], keysInst: [46], groove: 'halftime', density: 0.4 },
  { id: 'tech',      label: 'Tech',      bpm: [122, 132], keyPool: ['E', 'A', 'B'],  mode: 'minor', progs: [['i', 'VII', 'VI'], ['i', 'v', 'VI', 'VII'], ['i', 'III', 'VII', 'VI']], padInst: [88, 90], bassInst: [38, 39], leadInst: [80, 81, 82], groove: 'fourfloor', density: 0.65 },
  { id: 'synthwave', label: 'Synthwave', bpm: [100, 112], keyPool: ['A', 'D', 'F#'], mode: 'minor', progs: [['vi', 'IV', 'I', 'V'], ['i', 'VI', 'III', 'VII'], ['i', 'VII', 'VI', 'V']], padInst: [90, 88], bassInst: [38, 39], leadInst: [81, 82], keysInst: [80], groove: 'fourfloor', density: 0.6 },
  { id: 'funk',      label: 'Funk',      bpm: [104, 116], keyPool: ['E', 'G', 'C'],  mode: 'dorian', progs: [['i7', 'IV7'], ['i7', 'iv7', 'i7', 'V7'], ['i9', 'IV9']], padInst: [17, 18], bassInst: [36, 38], leadInst: [27, 30], keysInst: [7], groove: 'funk', swing: 0.12, density: 0.7 },
  { id: 'ambient',   label: 'Ambient',   bpm: [64, 78],   keyPool: ['C', 'D', 'G'],  mode: 'major', progs: [['Imaj7', 'IVmaj7'], ['vi', 'IV'], ['Imaj7', 'iii', 'IV']], padInst: [89, 95, 91], bassInst: [89, 32], leadInst: [73, 74], keysInst: [98], groove: 'soft', density: 0.25, useLead: true },
  { id: 'playful',   label: 'Playful',   bpm: [110, 124], keyPool: ['C', 'G', 'D'],  mode: 'major', progs: [['I', 'V', 'vi', 'IV'], ['I', 'IV', 'V'], ['I', 'vi', 'ii', 'V']], padInst: [12, 11], bassInst: [33, 32], leadInst: [12, 13, 9], keysInst: [114], groove: 'backbeat', density: 0.65 },
  { id: 'corporate', label: 'Corporate', bpm: [100, 116], keyPool: ['C', 'D', 'A'],  mode: 'major', progs: [['I', 'V', 'vi', 'IV'], ['IV', 'I', 'V', 'vi'], ['I', 'IV', 'V']], padInst: [48, 49], bassInst: [32, 33], leadInst: [0, 11, 12], keysInst: [0], groove: 'fourfloor', density: 0.5 },
  { id: 'hiphop',    label: 'Hip-hop',   bpm: [82, 94],   keyPool: ['F', 'C', 'Bb'], mode: 'minor', progs: [['i', 'VI', 'III', 'VII'], ['i7', 'iv7'], ['i', 'v', 'VI']], padInst: [4, 50], bassInst: [38, 36], leadInst: [11, 4], keysInst: [11], groove: 'boombap', swing: 0.16, density: 0.4 },
]

export const getStyle = (id: string): MusicStyle | undefined => MUSIC_STYLES.find((s) => s.id === id)

// ── Resolver: pool → one concrete arrangement ─────────────────────────────────

export interface ResolvedArrangement {
  styleId: string
  label: string
  bpm: number
  keyName: string
  mode: MusicStyle['mode']
  chordSyms: string[]
  scaleNotes: string[]
  padInst: number
  bassInst: number
  leadInst: number
  keysInst: number | null
  groove: Groove
  swing: number
  density: number
  useLead: boolean
  /** Procedurally generated per seed (within the groove family) for real variety. */
  drumLanes: DrumLane[]
  bassPat: BassHit[]
  seed: number
}

/** User-facing overrides that pin otherwise-randomized choices (Generate tab). */
export interface ResolveOverrides { bpm?: number; keyName?: string }

export function resolveStyle(style: MusicStyle, seed: number, overrides: ResolveOverrides = {}): ResolvedArrangement {
  const r = mulberry32(seed)
  // Always draw in the same order so an override doesn't shift later RNG choices
  // (instruments/progression stay stable for a given seed).
  const drawnBpm = Math.round(style.bpm[0] + r() * (style.bpm[1] - style.bpm[0]))
  const drawnKey = pick(style.keyPool, r)
  const bpm = overrides.bpm ?? drawnBpm
  const keyName = overrides.keyName ?? drawnKey
  // Draw from the style's own progressions plus a shared mode pool, for far more
  // harmonic variety than the 2–3 each style ships with.
  const roman = pick([...style.progs, ...extraProgs(style.mode)], r)
  const chordSyms = Progression.fromRomanNumerals(keyName, roman)
  const scaleNotes = Scale.get(`${keyName} ${style.mode}`).notes
  return {
    styleId: style.id, label: style.label, bpm, keyName, mode: style.mode,
    chordSyms, scaleNotes,
    padInst: pick(style.padInst, r),
    bassInst: pick(style.bassInst, r),
    leadInst: pick(style.leadInst, r),
    keysInst: style.keysInst ? pick(style.keysInst, r) : null,
    groove: style.groove, swing: style.swing ?? 0, density: style.density ?? 0.5,
    useLead: style.useLead !== false,
    // Generate the actual patterns last (doesn't disturb the picks above).
    drumLanes: genDrums(r, style.groove),
    bassPat: genBass(r, style.groove),
    seed,
  }
}

// ── Arrangement (resolved → MIDI bytes) ───────────────────────────────────────

/** Ascending, gently-spread chord voicing starting near `baseOct`. */
export function voiceChord(sym: string, baseOct: number): number[] {
  const c = Chord.get(sym)
  const pcs = c.notes.length ? c.notes : [sym]
  const out: number[] = []
  let prev = -Infinity
  for (const pc of pcs) {
    let oct = baseOct
    let m = Note.midi(`${pc}${oct}`) ?? 60
    while (m <= prev) { oct++; m = Note.midi(`${pc}${oct}`) ?? m + 12 }
    out.push(m); prev = m
  }
  return out
}
export function rootMidi(sym: string, oct: number): number {
  const c = Chord.get(sym)
  const root = c.tonic || sym.replace(/maj7|m7|m9|m|7|9|dim|aug|sus[24]?/g, '') || 'C'
  return Note.midi(`${root}${oct}`) ?? 36
}
function scaleDegToMidi(scale: string[], deg: number, baseOct: number): number {
  const n = scale.length || 7
  const name = scale[((deg % n) + n) % n] ?? 'C'
  const oct = baseOct + Math.floor(deg / n)
  return Note.midi(`${name}${oct}`) ?? 72
}

function tonicRoman(mode: MusicStyle['mode']): string { return mode === 'major' ? 'Imaj7' : 'i' }

/** A musical structure to render. `intro`/`outro` reproduce the podcast stinger
 *  behavior exactly; `loop` is a seamless repeatable bed; `full` is a longer
 *  stand-alone piece that builds in and rings out. */
export type Structure = 'intro' | 'outro' | 'loop' | 'full'

export interface LayerToggles { pad?: boolean; bass?: boolean; lead?: boolean; keys?: boolean; drums?: boolean }

export interface ArrangeOptions {
  structure: Structure
  /** Override the bar count (defaults: intro 2, outro 1, loop 4, full 8). */
  bars?: number
  /** Mute individual layers (all on by default). */
  layers?: LayerToggles
}

const DEFAULT_BARS: Record<Structure, number> = { intro: 2, outro: 1, loop: 4, full: 8 }
const SEED_MASK: Record<Structure, number> = {
  intro: 0x9e3779b1, outro: 0x85ebca77, loop: 0xc2b2ae35, full: 0x27d4eb2f,
}
/** Sensible fade-out (seconds) for each structure; loops fade fast to stay seamless. */
export const DEFAULT_FADE: Record<Structure, number> = { intro: 0.5, outro: 0.6, loop: 0.08, full: 0.8 }

/** Repeat `arr` until it has at least `len` elements, then trim to `len`. */
function tile<T>(arr: T[], len: number): T[] {
  if (arr.length >= len) return arr.slice(0, len)
  const out: T[] = []
  while (out.length < len) out.push(...arr)
  return out.slice(0, len)
}

/** Build a layered, humanized arrangement and return raw SMF bytes. */
export function arrange(R: ResolvedArrangement, opts: ArrangeOptions): Uint8Array {
  const { structure } = opts
  const midi = new Midi()
  midi.header.setTempo(R.bpm)
  const spb = 60 / R.bpm
  const step16 = spb / 4
  const r = mulberry32(R.seed ^ SEED_MASK[structure])

  const bars = opts.bars ?? DEFAULT_BARS[structure]
  const beats = bars * 4
  // Intro builds over its bars; outro is a short tag that resolves home; loop/full
  // tile the progression across the bars so it cycles musically.
  const chords =
    structure === 'outro'
      ? Progression.fromRomanNumerals(R.keyName, [tonicRoman(R.mode)])
      : structure === 'intro'
        ? R.chordSyms
        : tile(R.chordSyms, Math.max(R.chordSyms.length, Math.round(beats / 2)))
  const chordBeats = beats / chords.length

  const L = { pad: true, bass: true, lead: true, keys: true, drums: true, ...opts.layers }
  const mkTrack = (ch: number, inst?: number) => { const t = midi.addTrack(); t.channel = ch; if (inst != null) t.instrument.number = inst; return t }
  const pad = L.pad ? mkTrack(0, R.padInst) : null
  const bass = L.bass ? mkTrack(1, R.bassInst) : null
  const lead = L.lead ? mkTrack(2, R.leadInst) : null
  const keys = L.keys && R.keysInst != null ? mkTrack(3, R.keysInst) : null
  const drums = L.drums ? mkTrack(9) : null

  // Per-track space + balance. Reverb (CC91) / chorus (CC93) make it sound produced.
  pad?.addCC({ number: 91, value: 0.45, time: 0 }); pad?.addCC({ number: 93, value: 0.3, time: 0 }); pad?.addCC({ number: 7, value: 0.62, time: 0 })
  bass?.addCC({ number: 91, value: 0.1, time: 0 }); bass?.addCC({ number: 7, value: 0.8, time: 0 })
  lead?.addCC({ number: 91, value: 0.4, time: 0 }); lead?.addCC({ number: 93, value: 0.25, time: 0 }); lead?.addCC({ number: 7, value: 0.72, time: 0 })
  keys?.addCC({ number: 91, value: 0.4, time: 0 }); keys?.addCC({ number: 7, value: 0.6, time: 0 })

  type Track = ReturnType<typeof mkTrack>
  const hit = (t: Track | null, midiNote: number, time: number, dur: number, vel: number) => {
    if (!t) return
    t.addNote({
      midi: clamp(Math.round(midiNote), 24, 100),
      time: Math.max(0, time + (r() - 0.5) * 0.012),   // ±6ms human timing
      duration: Math.max(0.03, dur),
      velocity: clamp(vel + (r() - 0.5) * 0.12, 0.06, 1),
    })
  }
  const chordAt = (beat: number) => chords[clamp(Math.floor(beat / chordBeats), 0, chords.length - 1)]!

  // Pad + keys: voiced chords sustained for each chord.
  chords.forEach((sym, ci) => {
    const t0 = ci * chordBeats * spb
    const dur = chordBeats * spb * 0.98
    voiceChord(sym, 4).forEach((n) => hit(pad, n, t0, dur, 0.4))
    if (keys) voiceChord(sym, 5).forEach((n, i) => hit(keys, n, t0 + i * step16, spb * 0.6, 0.35))
  })

  // Drums + bass, looped per bar. Only the intro's first bar is sparse (build-up).
  // Procedurally-generated per take (falls back to the fixed tables if absent).
  const groove = R.drumLanes ?? GROOVES[R.groove]
  const bassPat = R.bassPat ?? BASS_PATTERNS[R.groove]
  for (let bar = 0; bar < bars; bar++) {
    const full = !(structure === 'intro' && bar === 0)   // build-up for the intro
    const barT = bar * 4 * spb
    if (full) {
      for (const lane of groove) {
        for (const s of lane.steps) {
          const swung = s % 2 === 1 ? R.swing * step16 : 0
          hit(drums, lane.note, barT + s * step16 + swung, step16 * 1.5, lane.vel)
        }
      }
    } else {
      // sparse opener: soft hat pulse only
      for (const s of [0, 4, 8, 12]) hit(drums, CHH, barT + s * step16, step16, 0.3)
    }
    for (const b of bassPat) {
      const beatHere = bar * 4 + b.step / 4
      const sym = chordAt(beatHere)
      const oct = b.tone === 7 ? 3 : 2
      const note = b.tone === -5 ? rootMidi(sym, 2) + 7 : rootMidi(sym, oct)
      hit(bass, note, barT + b.step * step16, step16 * 2, 0.7)
    }
  }

  // Lead melody: diatonic walk with a varied rhythm — each beat draws a rhythm cell
  // (quarter / two-8ths / 8th+two-16ths / dotted / a rest) so phrases breathe and differ,
  // instead of a flat 8th-note grid. Intro: only the 2nd bar onward (build).
  if (R.useLead) {
    // [offset-in-beat, length-in-beats] pairs; [] is a rest for the whole beat.
    const CELLS: [number, number][][] = [
      [[0, 1]],
      [[0, 0.5], [0.5, 0.5]],
      [[0, 0.5], [0.5, 0.25], [0.75, 0.25]],
      [[0, 0.75], [0.75, 0.25]],
      [[0, 0.25], [0.5, 0.5]],
      [],
    ]
    let deg = pick([0, 2, 4], r)
    const startBeat = structure === 'intro' ? 4 : 0
    for (let b = startBeat; b < beats; b++) {
      for (const [off, len] of pick(CELLS, r)) {
        if (r() < R.density + 0.18) {
          hit(lead, scaleDegToMidi(R.scaleNotes, deg, 5), (b + off) * spb, spb * len * 0.9, 0.5 + r() * 0.14)
        }
        // Mostly stepwise motion, with the occasional leap for shape.
        deg = clamp(deg + pick(r() < 0.18 ? [-4, -3, 3, 4] : [-2, -1, 0, 1, 2], r), -3, 10)
      }
    }
  }

  // Buttons: a crash to open; outro/full ring out on the tonic; intro adds a pickup
  // fill into the body; loops stay clean so they tile seamlessly.
  const ringOut = structure === 'outro' || structure === 'full'
  hit(drums, CRASH, 0, spb * 2, structure === 'intro' ? 0.6 : 0.75)
  if (ringOut) {
    const last = chords[chords.length - 1]!
    voiceChord(last, 4).forEach((n) => hit(pad, n, beats * spb, spb * 2.5, 0.5))
    hit(bass, rootMidi(last, 2), beats * spb, spb * 2.5, 0.7)
    hit(drums, CRASH, beats * spb, spb * 3, 0.6)
  } else if (structure === 'intro') {
    // pickup tom fill into the body
    for (let i = 0; i < 3; i++) hit(drums, TOM - i * 2, (beats - 0.75 + i * 0.25) * spb, step16, 0.5 + i * 0.1)
  }

  return midi.toArray()
}

// ── Rendering (MIDI + SoundFont → WAV, offline) ───────────────────────────────

let bankPromise: Promise<BasicSoundBank> | null = null
/** Fetch + parse the shared SoundFont once; cached for all renders this session. */
export async function getSoundBank(): Promise<BasicSoundBank> {
  if (!bankPromise) {
    bankPromise = (async () => {
      const r = await fetch('/api/podcasts/soundfont', { credentials: 'include' })
      if (!r.ok) throw new Error('soundfont')
      return SoundBankLoader.fromArrayBuffer(await r.arrayBuffer())
    })().catch((e) => { bankPromise = null; throw e })
  }
  return bankPromise
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

/** Peak-normalize to ~0.85 FS and encode mono WAV. `normalizeAudio:false` is
 *  required — audioToWav otherwise rescales the loudest sample to full scale,
 *  erasing our headroom and making a hot multi-layer mix sit louder than speech. */
export function encodeMonoWav(mono: Float32Array, targetPeak = 0.85): Blob {
  let peak = 1e-6
  for (let i = 0; i < mono.length; i++) { const a = Math.abs(mono[i]!); if (a > peak) peak = a }
  // Cap the boost (synth has no real noise floor, so a high cap is safe) but enough
  // to bring soft pad-only takes up to level too.
  const gain = peak < 1e-3 ? 1 : Math.min(12, targetPeak / peak)
  for (let i = 0; i < mono.length; i++) mono[i] = Math.max(-1, Math.min(1, mono[i]! * gain))
  return new Blob([audioToWav([mono], MUSIC_SAMPLE_RATE, { normalizeAudio: false })], { type: 'audio/wav' })
}

/** Render SMF bytes to a 24 kHz mono WAV Blob via the offline SoundFont synth. */
export async function renderMidiToWav(smf: Uint8Array, fadeOutSec: number): Promise<Blob> {
  const bank = await getSoundBank()
  const midi = BasicMIDI.fromArrayBuffer(toArrayBuffer(smf))

  const synth = new SpessaSynthProcessor(MUSIC_SAMPLE_RATE, { eventsEnabled: false })
  synth.soundBankManager.addSoundBank(bank, 'main')
  await synth.processorInitialized
  synth.setSystemParameter('autoAllocateVoices', true)

  const seq = new SpessaSynthSequencer(synth)
  seq.loadNewSongList([midi])
  seq.play()

  const tailSec = 1.3
  const sampleCount = Math.ceil(MUSIC_SAMPLE_RATE * (midi.duration + tailSec))
  const left = new Float32Array(sampleCount)
  const right = new Float32Array(sampleCount)
  let filled = 0
  const BUF = 128
  while (filled < sampleCount) {
    seq.processTick()
    const n = Math.min(BUF, sampleCount - filled)
    synth.process(left, right, filled, n)
    filled += n
  }

  // Downmix to mono + fade, then peak-normalize for clean headroom.
  const mono = new Float32Array(sampleCount)
  const fin = Math.floor(0.02 * MUSIC_SAMPLE_RATE)
  const fout = Math.floor(fadeOutSec * MUSIC_SAMPLE_RATE)
  for (let i = 0; i < sampleCount; i++) {
    let s = (left[i]! + right[i]!) * 0.5
    if (i < fin) s *= i / fin
    if (i > sampleCount - fout) s *= (sampleCount - i) / fout
    mono[i] = s
  }
  return encodeMonoWav(mono)
}

/** Convenience: resolve → arrange → render in one call. */
export async function renderArrangement(R: ResolvedArrangement, opts: ArrangeOptions, fadeOutSec?: number): Promise<Blob> {
  return renderMidiToWav(arrange(R, opts), fadeOutSec ?? DEFAULT_FADE[opts.structure])
}

/** Transcode an uploaded audio file to a 24 kHz mono WAV, clamped to `maxSec`. */
export async function fileToWav(file: File, maxSec = 6): Promise<Blob> {
  const arr = await file.arrayBuffer()
  const AC: typeof AudioContext = window.AudioContext ?? (window as any).webkitAudioContext
  const ac = new AC()
  let decoded: AudioBuffer
  try { decoded = await ac.decodeAudioData(arr) } finally { void ac.close() }

  const dur = Math.min(decoded.duration, maxSec)
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(dur * MUSIC_SAMPLE_RATE)), MUSIC_SAMPLE_RATE)
  const src = off.createBufferSource()
  src.buffer = decoded
  src.connect(off.destination)
  src.start(0, 0, dur)
  const rendered = await off.startRendering()

  const mono = new Float32Array(rendered.length)
  rendered.copyFromChannel(mono, 0)
  return encodeMonoWav(mono)
}

/** Exact duration (seconds) of a 24 kHz mono 16-bit WAV blob from its byte size. */
export function wavDurationSec(blob: Blob): number {
  return Math.max(0, (blob.size - 44) / 2 / MUSIC_SAMPLE_RATE)
}

/** Available keys + modes for the Generate UI (drawn from the styles' key pools). */
export const MUSIC_KEYS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'A', 'Bb', 'B'] as const
