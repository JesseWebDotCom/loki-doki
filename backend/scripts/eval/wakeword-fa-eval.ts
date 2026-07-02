// Wakeword false-accept / recall regression harness.
//
// Builds a reproducible audio bank (Kokoro speech = "TV dialog" proxy, near-miss
// phrases, colored noise, silence, plus positive utterances), streams it through
// the REAL detection pipeline (lib/pod/wake.ts — the ort-web port both the
// browser loop and the Wyoming/Tab5 path share), records the smoothed score
// stream once per model, then evaluates fires offline for any threshold ×
// hysteresis combination:
//   - FA/hr at the calibrated threshold, browser params (hyst 2) vs pod (hyst 4)
//   - recall on positives at the same settings
//   - a threshold sweep with a recommendation meeting the FA target
//
// Usage:
//   bun run scripts/eval/wakeword-fa-eval.ts [modelId ...]   (default: hey_loki latest + hey_jarvis)
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WakeDetector } from '@/lib/pod/wake'
import { kokoroUrl } from '@/lib/voice/config'

const BANK_DIR = process.env.WAKE_EVAL_BANK ?? join(process.cwd(), '..', 'data', 'voice', 'wake-eval-bank')
const SR = 16_000
const FRAME_MS = 80
const TARGET_FAPH = 1.0

const modelIds = process.argv.slice(2).filter(a => !a.startsWith('--'))
if (modelIds.length === 0) modelIds.push('trained_hey_loki_mqwl8glv', 'hey_jarvis')

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
const POSITIVE_PHRASE: Record<string, string> = {} // modelId → phrase, resolved below
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
  const res = await fetch(`${base}/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, speed }),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`synthesize failed ${res.status} for "${text}"`)
  const raw = Buffer.from(await res.arrayBuffer())
  const { pcm, sr } = decodeWav(raw)
  const pcm16 = resampleTo16k(pcm, sr)
  writeFileSync(dest, pcm16Write(pcm16))
  return pcm16
}

interface Bank { label: string; audio: Float32Array }

async function buildNegativeBank(): Promise<Bank[]> {
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
  return banks
}

async function buildPositiveBank(phrase: string): Promise<Bank> {
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

function concat(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Float32Array(total)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

// ── Score-stream collection ──────────────────────────────────────────────────

async function scoreStream(modelId: string, audio: Float32Array): Promise<number[]> {
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

// Replays the exact runtime fire logic (hysteresis + 1s refractory) over a
// recorded smoothed-score stream.
function countFires(scores: number[], threshold: number, hysteresis: number): number {
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

// ── Main ─────────────────────────────────────────────────────────────────────

import { db } from '@/db'
import { wakeWordCatalog } from '@/db/schema'
import { eq } from 'drizzle-orm'

console.log('Building negative bank (cached after first run)…')
const negBanks = await buildNegativeBank()
const negTotalSec = negBanks.reduce((n, b) => n + b.audio.length, 0) / SR
console.log(`Negative bank: ${negBanks.map(b => `${b.label}=${Math.round(b.audio.length / SR)}s`).join(' ')} (total ${Math.round(negTotalSec)}s)\n`)

for (const modelId of modelIds) {
  const [row] = await db.select().from(wakeWordCatalog).where(eq(wakeWordCatalog.id, modelId)).limit(1)
  const calibrated = row?.defaultThreshold ?? 0.5
  const phrase = POSITIVE_PHRASE[modelId]
    ?? (row?.label?.toLowerCase().replace(/[^a-z ]/g, '').trim()
      || modelId.replace(/^trained_/, '').replace(/_[a-z0-9]+$/, '').replace(/_/g, ' '))

  console.log(`\n═══ ${modelId} (phrase "${phrase}", calibrated threshold ${calibrated}) ═══`)

  const negScores: Record<string, number[]> = {}
  for (const bank of negBanks) {
    const t0 = performance.now()
    negScores[bank.label] = await scoreStream(modelId, bank.audio)
    console.log(`  scored ${bank.label}: ${negScores[bank.label]!.length} frames in ${Math.round((performance.now() - t0) / 1000)}s, peak=${Math.max(...negScores[bank.label]!, 0).toFixed(3)}`)
  }
  const posBank = await buildPositiveBank(phrase)
  const posScores = await scoreStream(modelId, posBank.audio)
  const posCount = POSITIVE_VOICES.length * POSITIVE_SPEEDS.length
  console.log(`  scored positives: ${posScores.length} frames, peak=${Math.max(...posScores).toFixed(3)}`)

  const table = (threshold: number, hysteresis: number) => {
    const perBank = negBanks.map(b => countFires(negScores[b.label]!, threshold, hysteresis))
    const totalFa = perBank.reduce((a, b) => a + b, 0)
    const faPerHr = totalFa / (negTotalSec / 3600)
    const recalled = countFires(posScores, threshold, hysteresis)
    return { perBank, faPerHr, recall: recalled / posCount }
  }

  // Persist raw score streams so thresholds/hysteresis can be re-analyzed offline.
  writeFileSync(join(BANK_DIR, `scores_${modelId}.json`), JSON.stringify({ negScores, posScores, posCount, negTotalSec, calibrated }))

  console.log(`\n  ${'config'.padEnd(34)} FA/hr   recall  fires(${negBanks.map(b => b.label).join('/')})`)
  for (const [label, th, hy] of [
    [`browser (hyst 2, th ${calibrated})`, calibrated, 2],
    [`mid     (hyst 3, th ${calibrated})`, calibrated, 3],
    [`pod     (hyst 4, th ${calibrated})`, calibrated, 4],
  ] as [string, number, number][]) {
    const r = table(th, hy)
    console.log(`  ${label.padEnd(34)} ${r.faPerHr.toFixed(1).padStart(5)}   ${(r.recall * 100).toFixed(0).padStart(4)}%   ${r.perBank.join('/')}`)
  }

  console.log(`\n  threshold sweep (hysteresis 2 = browser / 3 = mid / 4 = pod):`)
  console.log(`  thr    FA/hr(h2)  rec(h2)   FA/hr(h3)  rec(h3)   FA/hr(h4)  rec(h4)`)
  let recommended: { th: number; hy: number } | null = null
  for (let th = 0.40; th <= 0.72; th += 0.02) {
    const t = Math.round(th * 100) / 100
    const h2 = table(t, 2), h3 = table(t, 3), h4 = table(t, 4)
    console.log(`  ${t.toFixed(2)}   ${h2.faPerHr.toFixed(1).padStart(7)}   ${(h2.recall * 100).toFixed(0).padStart(5)}%   ${h3.faPerHr.toFixed(1).padStart(7)}   ${(h3.recall * 100).toFixed(0).padStart(5)}%   ${h4.faPerHr.toFixed(1).padStart(7)}   ${(h4.recall * 100).toFixed(0).padStart(5)}%`)
    for (const [hy, r] of [[3, h3], [4, h4]] as [number, ReturnType<typeof table>][]) {
      if (!recommended && r.faPerHr <= TARGET_FAPH && r.recall >= 0.75) recommended = { th: t, hy }
    }
  }
  if (recommended) console.log(`\n  → recommended: threshold ${recommended.th} @ hysteresis ${recommended.hy} (≤${TARGET_FAPH} FA/hr on this bank, recall ≥75%)`)
  else console.log(`\n  → no threshold in sweep met ≤${TARGET_FAPH} FA/hr with recall ≥75% — model needs retraining`)
}
process.exit(0)
