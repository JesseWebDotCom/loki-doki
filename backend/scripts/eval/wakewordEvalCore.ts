// Shared scoring core for the wakeword FA/recall harness — extracted from
// wakeword-fa-eval.ts so both the interactive CLI and the fleet retrain
// orchestrator (retrain-fleet-with-eval.ts) score models identically.
import { mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WakeDetector } from '@/lib/pod/wake'
import { kokoroUrl } from '@/lib/voice/config'
import { ensureWakewordNoisePack, wakewordNoiseCalibDir } from '@/lib/download'

export const BANK_DIR = process.env.WAKE_EVAL_BANK ?? join(process.cwd(), '..', 'data', 'voice', 'wake-eval-bank')
export const SR = 16_000
export const FRAME_MS = 80

// ── Bank definition ──────────────────────────────────────────────────────────

const SPEECH_VOICES = ['af_heart', 'am_michael', 'bf_emma', 'am_eric', 'af_sky', 'bm_george']
const SPEECH_TEXTS = [
  'The weather this weekend looks fantastic, with clear skies and mild temperatures across the region.',
  "I can't believe the game went into double overtime last night, that final shot was incredible.",
  'Scientists announced a breakthrough in battery technology that could double electric vehicle range.',
  'Please remember to pick up milk, eggs, and a loaf of sourdough bread on your way home today.',
  'The committee will reconvene on Thursday to discuss the proposed changes to the zoning laws.',
  'Her new novel follows three generations of a family running a lighthouse off the coast of Maine.',
  'Traffic on the interstate is backed up for six miles following an earlier accident near exit twelve.',
  'He spent the whole afternoon repotting tomatoes and pruning the apple trees in the back garden.',
  'The recipe calls for two cups of flour, a pinch of salt, and exactly three tablespoons of butter.',
  'Local officials say the new library wing will open to the public early next spring.',
  'The orchestra tuned their instruments as the conductor walked slowly to the podium.',
  'Yesterday the kids built an enormous sandcastle before the tide came in and washed it away.',
]
// Near-miss set: phonetic neighbors of "hey <name>" trigger phrases in general —
// the hardest legitimate negatives for any "hey X" detector.
const NEAR_MISS_TEXTS = [
  'hey lucky', 'hey low key', 'hey cocoa', 'hey yogi', 'hey khaki', 'hey kooky',
  'hey logan', 'hey lassie', 'hey hockey', 'okay milky', 'hey jarvie', 'hey harvest',
  'hey marvel', 'hey nova scotia', 'hey soul sister', 'hey pixie', 'hey astro turf',
]
const POSITIVE_VOICES = ['af_bella', 'am_adam', 'bf_alice', 'am_michael']
const POSITIVE_SPEEDS = [0.9, 1.0, 1.15]

// ── WAV / DSP helpers ────────────────────────────────────────────────────────

function decodeWav(buf: Buffer): { pcm: Float32Array; sr: number } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let sr = 16000, dataOffset = -1, dataLen = 0, bits = 16, offset = 12
  while (offset + 8 <= buf.byteLength) {
    const id = buf.toString('ascii', offset, offset + 4)
    const len = view.getUint32(offset + 4, true)
    if (id === 'fmt ') { sr = view.getUint32(offset + 12, true); bits = view.getUint16(offset + 22, true) }
    if (id === 'data') { dataOffset = offset + 8; dataLen = len; break }
    offset += 8 + len + (len % 2)
  }
  if (dataOffset < 0) return { pcm: new Float32Array(0), sr }
  const n = Math.floor(dataLen / (bits / 8))
  const pcm = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    pcm[i] = bits === 16 ? view.getInt16(dataOffset + i * 2, true) / 32768
      : view.getFloat32(dataOffset + i * 4, true)
  }
  return { pcm, sr }
}

function resampleTo16k(pcm: Float32Array, sr: number): Float32Array {
  if (sr === SR) return pcm
  const ratio = sr / SR
  const out = new Float32Array(Math.floor(pcm.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const src = i * ratio
    const i0 = Math.floor(src)
    const frac = src - i0
    out[i] = (pcm[i0] ?? 0) * (1 - frac) + (pcm[i0 + 1] ?? pcm[i0] ?? 0) * frac
  }
  return out
}

function pcm16Write(f32: Float32Array): Buffer {
  const buf = Buffer.alloc(44 + f32.length * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + f32.length * 2, 4); buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(f32.length * 2, 40)
  for (let i = 0; i < f32.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((f32[i] ?? 0) * 32767))), 44 + i * 2)
  return buf
}

function silence(seconds: number): Float32Array { return new Float32Array(Math.round(seconds * SR)) }

// Deterministic PRNG so the noise bank is identical run-to-run.
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function coloredNoise(seconds: number, kind: 'white' | 'pink' | 'brown', gain: number, seed: number): Float32Array {
  const rand = mulberry32(seed)
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  let b0 = 0, b1 = 0, b2 = 0, brown = 0
  for (let i = 0; i < n; i++) {
    const w = rand() * 2 - 1
    if (kind === 'white') out[i] = w * gain
    else if (kind === 'brown') { brown = (brown + 0.02 * w) / 1.02; out[i] = brown * 3.5 * gain }
    else { b0 = 0.997 * b0 + 0.0290 * w; b1 = 0.985 * b1 + 0.0570 * w; b2 = 0.950 * b2 + 0.1090 * w; out[i] = (b0 + b1 + b2) * 1.3 * gain }
  }
  return out
}

// ── Bank synthesis (cached on disk) ──────────────────────────────────────────

async function synthClip(base: string, text: string, voice: string, speed: number, dest: string): Promise<Float32Array> {
  if (existsSync(dest)) {
    const { pcm, sr } = decodeWav(readFileSync(dest))
    return resampleTo16k(pcm, sr)
  }
  // Retry with backoff — the Kokoro sidecar transiently drops connections on
  // restart (concurrent dev hot-reload), and eval scoring runs inside the
  // multi-hour fleet retrain; a single blip must not fail a whole companion's
  // eval. Mirrors the trainer's synthesize() retry.
  let raw: Buffer | undefined
  let lastErr: unknown
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`${base}/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice, speed }),
        signal: AbortSignal.timeout(30000),
      })
      if (!res.ok) throw new Error(`synthesize failed ${res.status} for "${text}"`)
      raw = Buffer.from(await res.arrayBuffer())
      break
    } catch (err) {
      lastErr = err
      if (attempt < 5) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)))
    }
  }
  if (!raw) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  const { pcm, sr } = decodeWav(raw)
  const pcm16 = resampleTo16k(pcm, sr)
  writeFileSync(dest, pcm16Write(pcm16))
  return pcm16
}

export interface Bank { label: string; audio: Float32Array }

// Real-world room recordings (MS-SNSD, downloaded on demand) — the actual FP
// source is a room (TV, family conversation, kitchen/living-room noise), which
// the synthetic Kokoro-speech + procedural-noise banks above only approximate.
// Reads the HELD-OUT calib split (disjoint from the files the trainer mixes
// into training negatives, see wakewordTrainer.ts writeRealNoiseNegatives) so
// this number is never inflated by scoring audio the model already trained on.
// Capped so eval runtime stays bounded even though MS-SNSD clips run long.
const REAL_BANK_CAP_SEC = 360

async function buildRealBank(): Promise<Bank | null> {
  try {
    await ensureWakewordNoisePack()
  } catch (e) {
    console.log(`Real-noise pack unavailable (${e instanceof Error ? e.message : e}) — skipping "real" eval category`)
    return null
  }
  const dir = wakewordNoiseCalibDir()
  const files = readdirSync(dir).filter((f) => f.endsWith('.wav'))
  if (!files.length) return null
  const capSamples = REAL_BANK_CAP_SEC * SR
  const parts: Float32Array[] = []
  let total = 0
  for (const f of files) {
    if (total >= capSamples) break
    const { pcm, sr } = decodeWav(readFileSync(join(dir, f)))
    const clip = resampleTo16k(pcm, sr)
    const remaining = capSamples - total
    const slice = clip.length > remaining ? clip.subarray(0, remaining) : clip
    parts.push(slice)
    total += slice.length
  }
  return { label: 'real', audio: concat(parts) }
}

export async function buildNegativeBank(): Promise<Bank[]> {
  mkdirSync(BANK_DIR, { recursive: true })
  const base = await kokoroUrl()
  const gap = silence(0.5)
  const banks: Bank[] = []

  const speechParts: Float32Array[] = []
  let i = 0
  for (const voice of SPEECH_VOICES) {
    for (const text of SPEECH_TEXTS) {
      const clip = await synthClip(base, text, voice, 1.0, join(BANK_DIR, `speech_${voice}_${i++}.wav`))
      speechParts.push(clip, gap)
    }
  }
  banks.push({ label: 'speech', audio: concat(speechParts) })

  const nearParts: Float32Array[] = []
  i = 0
  for (const text of NEAR_MISS_TEXTS) {
    for (const voice of ['af_heart', 'am_michael']) {
      const clip = await synthClip(base, text, voice, 1.0, join(BANK_DIR, `near_${voice}_${i}.wav`))
      nearParts.push(clip, gap)
    }
    i++
  }
  banks.push({ label: 'near-miss', audio: concat(nearParts) })

  const noiseParts: Float32Array[] = []
  let seed = 42
  for (const kind of ['white', 'pink', 'brown'] as const) {
    for (const gain of [0.02, 0.08, 0.2]) noiseParts.push(coloredNoise(8, kind, gain, seed++))
  }
  banks.push({ label: 'noise', audio: concat(noiseParts) })
  banks.push({ label: 'silence', audio: silence(20) })

  const real = await buildRealBank()
  if (real) banks.push(real)

  return banks
}

export async function buildPositiveBank(phrase: string): Promise<Bank> {
  const base = await kokoroUrl()
  const gap = silence(1.2) // long gap so each utterance is an independent detection
  const parts: Float32Array[] = []
  let i = 0
  for (const voice of POSITIVE_VOICES) {
    for (const speed of POSITIVE_SPEEDS) {
      const clip = await synthClip(base, phrase, voice, speed, join(BANK_DIR, `pos_${phrase.replace(/\W+/g, '_')}_${voice}_${i++}.wav`))
      parts.push(gap, clip)
    }
  }
  parts.push(gap)
  return { label: `positive("${phrase}")`, audio: concat(parts) }
}

export const POSITIVE_COUNT = POSITIVE_VOICES.length * POSITIVE_SPEEDS.length

function concat(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Float32Array(total)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

// ── Score-stream collection ──────────────────────────────────────────────────

export async function scoreStream(modelId: string, audio: Float32Array): Promise<number[]> {
  const det = new WakeDetector({ modelId, threshold: 2 }) // threshold 2 = never fires; we only record scores
  if (!(await det.load())) throw new Error(`could not load ${modelId}`)
  const scores: number[] = []
  det.onScore = (s) => scores.push(s)
  const CHUNK = 1280
  for (let o = 0; o < audio.length; o += CHUNK) {
    det.push(audio.subarray(o, Math.min(audio.length, o + CHUNK)))
    // drain the serial inference chain periodically so memory stays flat
    if ((o / CHUNK) % 50 === 0) await (det as unknown as { inferring: Promise<void> | null }).inferring
  }
  await (det as unknown as { inferring: Promise<void> | null }).inferring
  return scores
}

// Score one model against the full negative bank + a phrase's positive bank at
// a single threshold/hysteresis config — the summary numbers used by the fleet
// retrain orchestrator to decide candidate vs. champion (see retrain-fleet-with-eval.ts).
export async function scoreModelAt(
  modelId: string,
  threshold: number,
  hysteresis: number,
  negBanks: Bank[],
  negTotalSec: number,
  posBank: Bank,
): Promise<{ faPerHr: number; recall: number }> {
  let totalFa = 0
  for (const bank of negBanks) {
    const scores = await scoreStream(modelId, bank.audio)
    totalFa += countFires(scores, threshold, hysteresis)
  }
  const posScores = await scoreStream(modelId, posBank.audio)
  const recalled = countFires(posScores, threshold, hysteresis)
  return { faPerHr: totalFa / (negTotalSec / 3600), recall: recalled / POSITIVE_COUNT }
}

// Replays the exact runtime fire logic (hysteresis + 1s refractory) over a
// recorded smoothed-score stream.
export function countFires(scores: number[], threshold: number, hysteresis: number): number {
  let fires = 0, consecutive = 0, lastFire = -Infinity
  for (let i = 0; i < scores.length; i++) {
    if ((scores[i] ?? 0) < threshold) { consecutive = 0; continue }
    consecutive++
    if (consecutive < hysteresis) continue
    const tMs = i * FRAME_MS
    if (tMs - lastFire < 1000) continue
    lastFire = tMs
    consecutive = 0
    fires++
  }
  return fires
}
