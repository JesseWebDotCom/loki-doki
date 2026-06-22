// MIDI remix — import a .mid and restyle it while staying faithful to the music.
//
// The principle (and the fix for the earlier versions): REUSE the parts already in
// the MIDI. We do NOT invent a bassline from inferred chords — most files already
// have a bass track, and inferring one just produces wrong notes. Instead we:
//   1. classify the file's pitched tracks by register — lowest = bass, highest =
//      melody, the rest = chords/harmony,
//   2. keep each part's ACTUAL notes (pitches, timing, velocity, key, tempo),
//   3. re-point each to the chosen style's instruments (the "restyle"),
//   4. add the style's drum groove underneath.
// So the melody, bass, and chords are the composer's own — only the sounds and the
// beat change. The style never imposes its own notes or key.

import { Midi } from '@tonejs/midi'
import {
  getStyle, resolveStyle, renderMidiToWav, wavDurationSec, hashStr,
  GROOVES, MUSIC_STYLES, type ResolvedArrangement, type LayerToggles,
} from '@/lib/music/engine'

// ── Parse + classify ──────────────────────────────────────────────────────────

export interface MidiAnalysis {
  name: string
  bpm: number
  keyName: string
  mode: 'major' | 'minor'
  trackCount: number
  noteCount: number
  durationSec: number
  bars: number
  hasBass: boolean
  hasHarmony: boolean
}

interface RemixNote { midi: number; time: number; duration: number; velocity: number }  // seconds, original tempo
interface ParsedMidi {
  analysis: MidiAnalysis
  melodyNotes: RemixNote[]
  bassNotes: RemixNote[]
  harmonyNotes: RemixNote[]
  bpm: number
  beatsPerBar: number
  originalBytes: Uint8Array
}

const MAX_BARS = 128
const MAJOR = [0, 2, 4, 5, 7, 9, 11]
const MINOR = [0, 2, 3, 5, 7, 8, 10]
const PC_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'A', 'Bb', 'B']
const pcToName = (pc: number) => PC_NAMES[((pc % 12) + 12) % 12]!

function detectKey(hist: number[]): { rootPc: number; mode: 'major' | 'minor' } {
  let best = { rootPc: 0, mode: 'major' as 'major' | 'minor', score: -Infinity }
  for (let root = 0; root < 12; root++) {
    for (const [mode, scale] of [['major', MAJOR], ['minor', MINOR]] as const) {
      const inScale = new Set(scale.map((d) => (d + root) % 12))
      let score = hist[root]! * 1.5 + hist[(root + 7) % 12]! * 0.8
      for (let pc = 0; pc < 12; pc++) score += inScale.has(pc) ? hist[pc]! : -hist[pc]!
      if (score > best.score) best = { rootPc: root, mode, score }
    }
  }
  return { rootPc: best.rootPc, mode: best.mode }
}

/** Parse a .mid, then split its existing pitched tracks into melody / bass / harmony
 *  by register. Everything is kept in seconds at the original tempo and key. */
export async function analyzeMidiFile(file: File): Promise<ParsedMidi> {
  const buf = await file.arrayBuffer()
  const midi = new Midi(buf)
  const bpm = Math.round(midi.header.tempos[0]?.bpm ?? 120)
  const spb = 60 / bpm
  const ts = midi.header.timeSignatures[0]?.timeSignature
  const beatsPerBar = Array.isArray(ts) && ts[0] ? ts[0] : 4
  const barSec = beatsPerBar * spb

  const pitched = midi.tracks.filter((t) => t.channel !== 9 && t.notes.length)
  const globalHist = new Array(12).fill(0)
  let noteCount = 0
  for (const tr of pitched) for (const n of tr.notes) { globalHist[n.midi % 12] += n.duration; noteCount++ }
  const { rootPc, mode } = detectKey(globalHist)

  const bars = Math.min(MAX_BARS, Math.max(1, Math.ceil((midi.duration || spb) / barSec)))
  const maxSec = bars * barSec
  const mkNote = (n: { midi: number; time: number; duration: number; velocity: number }): RemixNote =>
    ({ midi: n.midi, time: n.time, duration: Math.max(0.08, n.duration), velocity: n.velocity })

  const melodyNotes: RemixNote[] = []
  const bassNotes: RemixNote[] = []
  const harmonyNotes: RemixNote[] = []
  const avg = (tr: (typeof pitched)[number]) => tr.notes.reduce((s, n) => s + n.midi, 0) / tr.notes.length

  if (pitched.length >= 2) {
    // Multi-track: lowest-register track is the bass, highest is the melody, rest harmony.
    const sorted = [...pitched].sort((a, b) => avg(a) - avg(b))
    const bassTr = sorted[0]!
    const melTr = sorted[sorted.length - 1]!
    for (const tr of pitched) {
      const dest = tr === melTr ? melodyNotes : tr === bassTr ? bassNotes : harmonyNotes
      for (const n of tr.notes) if (n.time < maxSec) dest.push(mkNote(n))
    }
  } else if (pitched.length === 1) {
    // Single track (e.g. a piano arrangement): split by register so the existing low
    // notes become the bass and the upper line the melody.
    for (const n of pitched[0]!.notes) {
      if (n.time >= maxSec) continue
      ;(n.midi < 52 ? bassNotes : melodyNotes).push(mkNote(n))
    }
  }

  return {
    melodyNotes, bassNotes, harmonyNotes, bpm, beatsPerBar,
    originalBytes: midi.toArray(),
    analysis: {
      name: file.name, bpm, keyName: pcToName(rootPc), mode,
      trackCount: pitched.length, noteCount, durationSec: midi.duration, bars,
      hasBass: bassNotes.length > 0, hasHarmony: harmonyNotes.length > 0,
    },
  }
}

/** Render the imported MIDI as-is (its own tempo/instruments) for auditioning. */
export async function renderOriginal(parsed: ParsedMidi): Promise<Blob> {
  return renderMidiToWav(parsed.originalBytes, 0.1)
}

// ── Restyle + render ────────────────────────────────────────────────────────

export interface RemixOptions {
  styleId: string
  /** 0..1 — higher quantizes the melody to the grid (1 = tight). */
  intensity?: number
  /** Which existing parts to keep (all on by default). */
  layers?: LayerToggles
  /** Include the melody part (on by default). */
  includeMelody?: boolean
}

export interface RemixVariant {
  key: number
  styleId: string
  label: string
  bpm: number
  keyName: string
  blob: Blob
  previewUrl: string
  durationSec: number
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const CRASH = 49

/** Render one restyled take: the song's own melody/bass/harmony notes, re-pointed to
 *  the resolved style's instruments, plus the style's drum groove. */
async function renderOne(parsed: ParsedMidi, resolved: ResolvedArrangement, intensity: number, layers: LayerToggles, includeMelody: boolean): Promise<Blob> {
  const L = { pad: true, bass: true, drums: true, ...layers }
  const midi = new Midi()
  midi.header.setTempo(parsed.bpm)
  const spb = 60 / parsed.bpm
  const step16 = spb / 4
  const barSec = parsed.beatsPerBar * spb
  let a = (resolved.seed ^ 0x9e3779b1) >>> 0
  const rand = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }

  const mk = (ch: number, inst?: number) => { const t = midi.addTrack(); t.channel = ch; if (inst != null) t.instrument.number = inst; return t }

  // Re-emit a part's actual notes onto a new instrument. quantize: optional grid (sec).
  const emit = (notes: RemixNote[], ch: number, inst: number, reverb: number, vol: number, quantize = 0) => {
    if (!notes.length) return
    const tr = mk(ch, inst)
    tr.addCC({ number: 91, value: reverb, time: 0 }); tr.addCC({ number: 7, value: vol, time: 0 })
    for (const n of notes) {
      const time = quantize ? Math.round(n.time / quantize) * quantize : n.time
      tr.addNote({ midi: clamp(Math.round(n.midi), 16, 108), time: Math.max(0, time), duration: Math.max(0.06, n.duration), velocity: clamp(n.velocity, 0.2, 1) })
    }
  }

  if (L.pad) emit(parsed.harmonyNotes, 0, resolved.padInst, 0.45, 0.5)

  // Bass: the STYLE's rhythm pattern, but the ROOTS are pulled from the song's own
  // bass — so it grooves differently per style/seed yet stays in the original key.
  // (Replaying the bass verbatim, as before, sounded identical across every style.)
  if (L.bass && parsed.bassNotes.length) {
    const sorted = [...parsed.bassNotes].sort((x, y) => x.time - y.time)
    const rootAt = (t: number): number => {
      let root = sorted[0]!.midi
      for (const n of sorted) { if (n.time <= t + 1e-3) root = n.midi; else break }
      return root
    }
    // Keep every bass note inside the song's detected key (the raw "fifth" offset can
    // otherwise land out of scale, e.g. an F# over A-minor). Roots come from the real
    // bass so they're already diatonic; we only snap the synthesized offsets.
    const keyRootPc = PC_NAMES.indexOf(parsed.analysis.keyName)
    const inKey = new Set((parsed.analysis.mode === 'minor' ? MINOR : MAJOR).map((d) => (keyRootPc + d + 12) % 12))
    const snap = (m: number): number => {
      if (keyRootPc < 0 || inKey.has(((m % 12) + 12) % 12)) return m
      for (const d of [-1, 1, -2, 2]) if (inKey.has((((m + d) % 12) + 12) % 12)) return m + d
      return m
    }
    const fold = (m: number) => { while (m < 28) m += 12; while (m > 67) m -= 12; return m }
    // ~40% of takes play a plain root bass (rhythm only, no octave/fifth moves) for
    // variety against the busier embellished takes.
    const rootOnly = ((resolved.seed >>> 4) & 7) < 3
    const bass = mk(1, resolved.bassInst)
    bass.addCC({ number: 91, value: 0.12, time: 0 }); bass.addCC({ number: 7, value: 0.85, time: 0 })
    const windowSec = 4 * spb               // bass patterns span a 4-beat (16-step) window
    const songEnd = parsed.analysis.bars * barSec
    for (let w = 0; w * windowSec < songEnd; w++) {
      const wStart = w * windowSec
      for (const bp of resolved.bassPat) {
        const t = wStart + bp.step * step16
        if (t >= songEnd) continue
        const root = rootAt(t)
        const note = rootOnly || bp.tone === 0 ? root
          : bp.tone === 7 ? root + 12          // octave: same pitch class, always in key
          : snap(root + 7)                      // fifth: snap into the song's scale
        bass.addNote({ midi: fold(Math.round(note)), time: Math.max(0, t + (rand() - 0.5) * 0.008), duration: step16 * 2, velocity: clamp(0.74 + (rand() - 0.5) * 0.12, 0.3, 1) })
      }
    }
  }

  if (includeMelody) {
    const grid = intensity >= 0.85 ? step16 : intensity >= 0.55 ? step16 * 2 : 0
    emit(parsed.melodyNotes, 2, resolved.leadInst, 0.4, 0.8, grid)
  }

  // Drums: the style's groove, laid under the existing music bar by bar.
  if (L.drums) {
    const drums = mk(9)
    const groove = resolved.drumLanes ?? GROOVES[resolved.groove]
    for (let b = 0; b < parsed.analysis.bars; b++) {
      const barT = b * barSec
      for (const lane of groove) for (const s of lane.steps) {
        const swung = s % 2 === 1 ? resolved.swing * step16 : 0
        drums.addNote({ midi: lane.note, time: Math.max(0, barT + s * step16 + swung + (rand() - 0.5) * 0.01), duration: step16 * 1.5, velocity: clamp(lane.vel + (rand() - 0.5) * 0.1, 0.1, 1) })
      }
      if (b === 0) drums.addNote({ midi: CRASH, time: 0, duration: spb * 2, velocity: 0.5 })
    }
  }

  return renderMidiToWav(midi.toArray(), 0.3)
}

/** Render `count` restyled takes (different instrument picks per seed). */
export async function renderRemixVariants(parsed: ParsedMidi, opts: RemixOptions, count = 6): Promise<RemixVariant[]> {
  const style = getStyle(opts.styleId) ?? MUSIC_STYLES[0]!
  const intensity = opts.intensity ?? 0.3
  const layers = opts.layers ?? {}
  const includeMelody = opts.includeMelody ?? true

  const out: RemixVariant[] = []
  for (let i = 0; i < count; i++) {
    const seed = hashStr(`${style.id}:${parsed.analysis.name}:${i}`) >>> 0
    const resolved = resolveStyle(style, seed)   // used only for instruments / groove / swing
    const blob = await renderOne(parsed, resolved, intensity, layers, includeMelody)
    out.push({
      key: i, styleId: style.id,
      label: `${style.label} · ${parsed.bpm} BPM · ${parsed.analysis.keyName} ${parsed.analysis.mode}`,
      bpm: parsed.bpm, keyName: parsed.analysis.keyName,
      blob, durationSec: wavDurationSec(blob), previewUrl: URL.createObjectURL(blob),
    })
  }
  return out
}

export type { ParsedMidi }
