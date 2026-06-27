// Server-side openWakeWord detection for streaming Pods.
//
// WHY THIS RUNS HERE (and via onnxruntime-WEB, not -node): openWakeWord's
// embedding CNN computes measurably differently under onnxruntime-node vs
// onnxruntime-web (~25/dim), so a detector only fires when train and inference
// share a runtime. The browser uses ort-web (WASM); detectors are trained against
// ort-web (see scripts/wake_embed_ortweb.mjs). So the Host must ALSO use ort-web —
// which, conveniently, runs fine under Bun (WASM, no native addon). This is a
// faithful port of frontend/src/lib/voice/wake-word-loop.ts.
//
// Pipeline (16 kHz mono Float32, 80 ms / 1280-sample frames):
//   rolling raw window → mel.onnx → trailing 76 mel frames (x/10+2) →
//   embedding_model.onnx → rolling 16-embedding window → detector.onnx → score.

// onnxruntime-web's ESM bundle ships no types resolvable under `bundler` module
// resolution, so borrow the value at runtime here and the types from the typed
// `onnxruntime-common` core (which ort-web re-exports).
// @ts-ignore - no resolvable .d.ts for the ort-web ESM bundle
import * as ort from 'onnxruntime-web'
import type { InferenceSession } from 'onnxruntime-common'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { wakeWordCatalog } from '@/db/schema'
import { wakewordDir } from '@/lib/download'
import { appDefaultWakeword } from '@/lib/voice/config'
import { logger } from '@/lib/logger'

const FRAME = 1280            // 80 ms @ 16 kHz
const MEL_DIM = 32
const MEL_BUF = 76
const EMB_DIM = 96
const RAW_BUF = 35_200        // MUST match RAW_AUDIO_BUFFER_SAMPLES / train_wakeword.py
const EMB_BUF_FRAMES = 50     // round(4s * 16000 / 1280)
const DET_FRAMES = 16
const WARMUP_ZERO_FRAMES = 5
const HYSTERESIS_FRAMES = 2
const POST_WAKE_SUPPRESS_MS = 1000
const WAKE_SAMPLE_RATE = 16_000

let _ortInit = false
function initOrt(): void {
  if (_ortInit) return
  ort.env.wasm.numThreads = 1
  ort.env.logLevel = 'fatal'
  _ortInit = true
}

// mel + embedding are shared across all detectors/connections; the detector swaps
// per model. Cache sessions process-wide so N Pods share one set.
const sessionCache = new Map<string, Promise<InferenceSession>>()
function session(path: string): Promise<InferenceSession> {
  const cached = sessionCache.get(path)
  if (cached) return cached
  const p: Promise<InferenceSession> = ort.InferenceSession.create(
    new Uint8Array(readFileSync(path)),
    { executionProviders: ['wasm'] },
  )
  sessionCache.set(path, p)
  return p
}

/** Are the shared mel+embedding models present on disk? */
export function wakeAvailable(): boolean {
  try {
    const files = readdirSync(wakewordDir())
    return files.includes('melspectrogram.onnx') && files.includes('embedding_model.onnx')
  } catch {
    return false
  }
}

/** Map a wakeword id (e.g. "hey_jarvis") to its detector .onnx on disk. */
function resolveDetectorPath(id: string): string | null {
  let files: string[]
  try {
    files = readdirSync(wakewordDir()).filter((f) => f.endsWith('.onnx'))
  } catch {
    return null
  }
  const f = files.find(
    (name) =>
      name !== 'melspectrogram.onnx' &&
      name !== 'embedding_model.onnx' &&
      (name === `${id}.onnx` || name.startsWith(`${id}_`)),
  )
  return f ? join(wakewordDir(), f) : null
}

export interface WakeDetectorOptions {
  modelId?: string
  threshold?: number
  /** Consecutive frames above threshold required to fire. Higher = more robust to
   *  isolated noise spikes (the device's quiet mic produces occasional ones). */
  hysteresis?: number
}

export class WakeDetector {
  modelId: string | null
  /** Explicit per-instance/env override; null → use the model's calibrated threshold. */
  private thresholdOverride: number | null
  private threshold = 0.5
  private mel: InferenceSession | null = null
  private emb: InferenceSession | null = null
  private det: InferenceSession | null = null
  private melIn = 'input'
  private embIn = 'input_1'
  private detIn = 'x.1'

  private rawBuffer = new Float32Array(RAW_BUF)
  private rawFilled = 0
  private embeddingBuffer = seedEmbeddingBuffer(0xa17c0001)
  private accumulator = new Float32Array(FRAME)
  private accOffset = 0
  private detectorFrameIndex = 0
  // Frames to force-score 0 after a reset() while the raw/embedding buffers refill with
  // real audio (~2.2 s of raw history = ~28 frames). Without this, the half-filled
  // buffers right after a reset produce a spurious high score → a false fire.
  private postResetSuppress = 0
  private consecutive = 0
  private hysteresisFrames = HYSTERESIS_FRAMES
  private lastFireAt: number | null = null
  private inferring: Promise<void> | null = null

  /** Fired once per detection (after hysteresis + suppression). */
  onDetect: (() => void) | null = null

  constructor(opts: WakeDetectorOptions = {}) {
    this.modelId = opts.modelId ?? null
    const envT = Number(process.env.POD_WAKE_THRESHOLD)
    this.thresholdOverride = typeof opts.threshold === 'number' && Number.isFinite(opts.threshold)
      ? opts.threshold
      : Number.isFinite(envT) && envT > 0 ? envT : null
    if (typeof opts.hysteresis === 'number' && opts.hysteresis >= 1) this.hysteresisFrames = Math.floor(opts.hysteresis)
  }

  /** Load the mel/embedding/detector sessions. Returns false if models missing. */
  async load(): Promise<boolean> {
    initOrt()
    const dir = wakewordDir()
    const id = this.modelId ?? (await appDefaultWakeword())
    this.modelId = id

    // Pull the catalog row (covers pretrained AND custom-trained detectors like
    // "hey_loki"): its assetPath is the source of truth for the file, and its
    // defaultThreshold is the trainer's calibrated value for that exact phrase.
    const [row] = await db.select().from(wakeWordCatalog).where(eq(wakeWordCatalog.id, id)).limit(1)
    const detPath = row?.assetPath ? join(dir, row.assetPath) : resolveDetectorPath(id)
    this.threshold = this.thresholdOverride
      ?? (typeof row?.defaultThreshold === 'number' && Number.isFinite(row.defaultThreshold) ? row.defaultThreshold : 0.5)

    if (!detPath || !wakeAvailable()) {
      logger.warn(`[pod] wake: missing models (detector for "${id}" or shared mel/embedding)`)
      return false
    }
    try {
      ;[this.mel, this.emb, this.det] = await Promise.all([
        session(join(dir, 'melspectrogram.onnx')),
        session(join(dir, 'embedding_model.onnx')),
        session(detPath),
      ])
    } catch (e) {
      logger.warn(`[pod] wake: failed to load sessions: ${(e as Error).message}`)
      return false
    }
    this.melIn = this.mel.inputNames[0] ?? 'input'
    this.embIn = this.emb.inputNames[0] ?? 'input_1'
    this.detIn = this.det.inputNames[0] ?? 'x.1'
    return true
  }

  /** Clear all rolling state so stale or self-generated audio (e.g. the device's own
   *  TTS reply, which is the same voice the detector was trained on) can't linger in
   *  the buffers and trigger a false fire. Resetting the frame index also re-arms the
   *  warm-up window (the next few frames score 0). */
  reset(): void {
    this.rawBuffer.fill(0)
    this.rawFilled = 0
    this.embeddingBuffer = seedEmbeddingBuffer(0xa17c0001)
    this.accumulator.fill(0)
    this.accOffset = 0
    this.detectorFrameIndex = 0
    this.postResetSuppress = 30 // ~2.4 s: don't fire until the buffers refill with real audio
    this.consecutive = 0
    this.lastFireAt = null
  }

  /** Feed 16 kHz mono Float32 PCM. Accumulates into 80 ms frames, runs serially. */
  push(pcm: Float32Array): void {
    if (!this.det) return
    let consumed = 0
    while (consumed < pcm.length) {
      const space = this.accumulator.length - this.accOffset
      const take = Math.min(space, pcm.length - consumed)
      this.accumulator.set(pcm.subarray(consumed, consumed + take), this.accOffset)
      this.accOffset += take
      consumed += take
      if (this.accOffset === this.accumulator.length) {
        const frame = new Float32Array(this.accumulator)
        this.accOffset = 0
        this.runSerially(frame)
      }
    }
  }

  private runSerially(frame: Float32Array): void {
    const next = () => this.runOneFrame(frame).catch((e) => {
      logger.warn(`[pod] wake inference error: ${(e as Error).message}`)
    })
    this.inferring = this.inferring ? this.inferring.then(next) : next()
  }

  private async runOneFrame(frame: Float32Array): Promise<void> {
    const score = await this.inferOnce(frame)
    const idx = this.detectorFrameIndex++
    let shaped = idx < WARMUP_ZERO_FRAMES ? 0 : score
    if (this.postResetSuppress > 0) { this.postResetSuppress--; shaped = 0 } // refilling after reset
    this.handleScore(shaped)
  }

  private async inferOnce(frame: Float32Array): Promise<number> {
    appendRaw(this.rawBuffer, frame)
    this.rawFilled = Math.min(this.rawBuffer.length, this.rawFilled + frame.length)
    const valid = this.rawBuffer.subarray(this.rawBuffer.length - this.rawFilled)

    // mel ONNX expects int16-range float32
    const scaled = new Float32Array(valid.length)
    for (let i = 0; i < valid.length; i++) scaled[i] = valid[i]! * 32767
    const melOut = await this.mel!.run({ [this.melIn]: new ort.Tensor('float32', scaled, [1, valid.length]) })
    const melRaw = firstFloat32(melOut)
    const totalFrames = Math.floor(melRaw.length / MEL_DIM)

    // Trailing 76 mel frames, x/10+2; front-pad with 1.0 while the buffer fills.
    const win = new Float32Array(MEL_BUF * MEL_DIM).fill(1)
    const take = Math.min(MEL_BUF, totalFrames)
    const srcStart = (totalFrames - take) * MEL_DIM
    const dstStart = (MEL_BUF - take) * MEL_DIM
    for (let i = 0; i < take * MEL_DIM; i++) win[dstStart + i] = melRaw[srcStart + i]! / 10 + 2

    const embOut = await this.emb!.run({ [this.embIn]: new ort.Tensor('float32', win, [1, MEL_BUF, MEL_DIM, 1]) })
    appendEmbedding(this.embeddingBuffer, firstFloat32(embOut))

    const detInput = new Float32Array(this.embeddingBuffer.slice(-DET_FRAMES * EMB_DIM))
    const detOut = await this.det!.run({ [this.detIn]: new ort.Tensor('float32', detInput, [1, DET_FRAMES, EMB_DIM]) })
    const data = firstFloat32(detOut)
    return clampScore(data[data.length - 1] ?? 0)
  }

  private diagPeak = 0
  private diagN = 0
  private handleScore(score: number): void {
    // diag: report the peak wake score periodically so we can see how close it gets.
    this.diagPeak = Math.max(this.diagPeak, score)
    if (++this.diagN >= 25) {
      logger.info(`[pod-wake-diag] peak score ${this.diagPeak.toFixed(3)} (fires at ${this.threshold.toFixed(2)})`)
      this.diagPeak = 0; this.diagN = 0
    }
    if (score < this.threshold) {
      this.consecutive = 0
      return
    }
    this.consecutive += 1
    if (this.consecutive < this.hysteresisFrames) return
    const now = Date.now()
    if (this.lastFireAt !== null && now - this.lastFireAt < POST_WAKE_SUPPRESS_MS) return
    this.lastFireAt = now
    this.consecutive = 0
    logger.info(`[pod] wake ✅ "${this.modelId}" (score ${score.toFixed(2)} ≥ ${this.threshold.toFixed(2)})`)
    this.onDetect?.()
  }
}

export { WAKE_SAMPLE_RATE }

// ── helpers (ported verbatim from the browser pipeline) ──────────────────────

function seedEmbeddingBuffer(seed: number): Float32Array {
  const buf = new Float32Array(EMB_BUF_FRAMES * EMB_DIM)
  let state = seed >>> 0
  for (let i = 0; i < buf.length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0
    buf[i] = (state / 0xffffffff - 0.5) * 0.02
  }
  return buf
}

function appendRaw(buffer: Float32Array, samples: Float32Array): void {
  const n = samples.length
  if (n >= buffer.length) {
    buffer.set(samples.subarray(n - buffer.length))
    return
  }
  buffer.copyWithin(0, n)
  buffer.set(samples, buffer.length - n)
}

function appendEmbedding(buffer: Float32Array, embedding: Float32Array): void {
  if (embedding.length < EMB_DIM) return
  buffer.copyWithin(0, EMB_DIM)
  buffer.set(embedding.subarray(0, EMB_DIM), buffer.length - EMB_DIM)
}

function firstFloat32(record: Record<string, { data: unknown }>): Float32Array {
  for (const value of Object.values(record)) return value.data as Float32Array
  throw new Error('ONNX session returned no outputs')
}

function clampScore(v: number): number {
  if (Number.isNaN(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}
