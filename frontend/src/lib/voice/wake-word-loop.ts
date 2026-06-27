// Continuous wake-word inference loop. Ported from v2 (zustand telemetry removed).
//
// Accumulates mic frames into 1280-sample (80 ms) wake-word frames; each flows
// through the mel/embedding/detector pipeline → per-frame score. The raw score is
// passed through a short moving average (ESPHome/microWakeWord do the same) so a
// single spurious spike can't fire — only a sustained run of high frames does.
// Hysteresis: 2 consecutive smoothed frames above threshold to fire. Post-wake
// suppression: 1 s lockout after a fire (prevents the same syllable retriggering).
// When disabled, the loop short-circuits before any inference — no CPU spent while
// hands-free is off.

import { emitWakeDetected, type WakeDetectedEvent } from "./wake-word-events"
import { getWakeWordModel, type WakeWordModelEntry } from "./wake-word-models"
import {
  EMBEDDING_DIM,
  MEL_FEATURE_DIM,
  MEL_BUFFER_SEED_FRAMES,
  RAW_AUDIO_BUFFER_SAMPLES,
  WAKE_WORD_FRAME_SAMPLES,
  WARMUP_ZERO_FRAMES,
  loadPipeline,
  seedEmbeddingBuffer,
  type WakeWordPipelineState,
} from "./wake-word-pipeline"
import { evictSession, tensorFor } from "./wake-word-runtime"

const HYSTERESIS_FRAMES_ABOVE = 2
const POST_WAKE_SUPPRESS_MS = 1000
// Moving-average window (in 80 ms frames) applied to the detector score before the
// threshold test. A short window (≈0.3 s) kills single-frame spikes — the dominant
// source of ambient false fires — while staying well within the ~4-frame run of
// high scores a completed wake phrase produces, so true detections still cross.
const SCORE_SMOOTHING_FRAMES = 4

// Verbose scores when localStorage['voice.debug'] === 'on' (reload after setting).
// Key events (model loaded, detection, errors) always log so the path is visible.
function wakeDebug(): boolean {
  try { return localStorage.getItem('voice.debug') === 'on' } catch { return false }
}

export interface WakeWordLoopOptions {
  modelId?: string
  thresholdOverride?: number | null
  randomSeed?: number
  now?: () => number
}

export class WakeWordLoop {
  private enabled = false
  private modelEntry: WakeWordModelEntry
  private thresholdOverride: number | null
  private accumulator: Float32Array = new Float32Array(WAKE_WORD_FRAME_SAMPLES)
  private accumulatorOffset = 0
  private detectorFrameIndex = 0
  private consecutiveAboveThreshold = 0
  /** Recent raw scores for the moving-average smoother (newest pushed at the end). */
  private scoreWindow: number[] = []
  private lastFireAt: number | null = null
  private inferring: Promise<void> | null = null
  private pipeline: WakeWordPipelineState | null = null
  /** Rolling raw-audio window; mel is recomputed over it each chunk. */
  private rawBuffer: Float32Array
  private rawFilled = 0
  private embeddingBuffer: Float32Array
  private now: () => number
  private inferenceErrorLogged = false
  /** Live per-frame score callback (for the diagnostic tester). */
  onScore: ((score: number, threshold: number) => void) | null = null
  /** Surface load/inference errors (for the tester). */
  onError: ((err: unknown) => void) | null = null

  constructor(options: WakeWordLoopOptions = {}) {
    this.modelEntry = getWakeWordModel(options.modelId ?? "hey_jarvis")
    this.thresholdOverride = options.thresholdOverride ?? null
    this.rawBuffer = new Float32Array(RAW_AUDIO_BUFFER_SAMPLES)
    this.embeddingBuffer = seedEmbeddingBuffer(options.randomSeed ?? 0xa17c0001)
    this.now = options.now ?? (() => Date.now())
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) { this.consecutiveAboveThreshold = 0; this.scoreWindow = [] }
  }

  setModel(modelId: string): void {
    if (this.modelEntry.id === modelId) return
    let entry
    try { entry = getWakeWordModel(modelId) } catch {
      console.warn(`[wakeword] setModel: unknown id "${modelId}" — registry not loaded yet, will retry`)
      return
    }
    const prior = this.modelEntry
    this.modelEntry = entry
    if (this.pipeline) evictSession(prior.assetPath)
    this.pipeline = null
    this.detectorFrameIndex = 0
    this.consecutiveAboveThreshold = 0
    this.scoreWindow = []
    this.rawBuffer = new Float32Array(RAW_AUDIO_BUFFER_SAMPLES)
    this.rawFilled = 0
    this.embeddingBuffer = seedEmbeddingBuffer(0xa17c0001)
  }

  setThresholdOverride(value: number | null): void {
    this.thresholdOverride = value
  }

  threshold(): number {
    const t = this.thresholdOverride ?? this.modelEntry.defaultThreshold
    // Guard: a non-numeric threshold makes `score < threshold` evaluate to
    // false on every frame, which fires the wake word on any input (any noise).
    return typeof t === 'number' && Number.isFinite(t) ? t : 0.5
  }

  async flush(): Promise<void> {
    while (this.inferring) {
      const current = this.inferring
      await current
      if (this.inferring === current) {
        this.inferring = null
        return
      }
    }
  }

  pushFrame(frame: Float32Array): void {
    if (!this.enabled) return
    let consumed = 0
    while (consumed < frame.length) {
      const remainingSpace = this.accumulator.length - this.accumulatorOffset
      const remainingFrame = frame.length - consumed
      const take = Math.min(remainingSpace, remainingFrame)
      this.accumulator.set(frame.subarray(consumed, consumed + take), this.accumulatorOffset)
      this.accumulatorOffset += take
      consumed += take
      if (this.accumulatorOffset === this.accumulator.length) {
        const wakeFrame = new Float32Array(this.accumulator)
        this.accumulatorOffset = 0
        this.runFrameSerially(wakeFrame)
      }
    }
  }

  private runFrameSerially(frame: Float32Array): void {
    const next = async () => {
      try {
        await this.runOneFrame(frame)
      } catch (err) {
        if (!this.inferenceErrorLogged) {
          this.inferenceErrorLogged = true
          console.warn("wake-word inference failed", err)
        }
        this.onError?.(err)
      }
    }
    this.inferring = this.inferring ? this.inferring.then(next) : next()
  }

  private peakScore = 0

  private async runOneFrame(frame: Float32Array): Promise<void> {
    if (!this.enabled) return
    if (!this.pipeline) {
      this.pipeline = await loadPipeline(this.modelEntry.id)
      console.info(`[wakeword] model loaded: "${this.modelEntry.id}" (threshold ${this.threshold().toFixed(2)}) — say the phrase`)
    }
    const score = await this.inferOnce(frame)
    const idx = this.detectorFrameIndex++
    const shaped = idx < WARMUP_ZERO_FRAMES ? 0 : score
    // Smooth before any thresholding so the tester, heartbeat and fire logic all
    // see the same value that actually drives detection.
    const smoothed = this.smoothScore(shaped)
    if (smoothed > this.peakScore) this.peakScore = smoothed
    this.onScore?.(smoothed, this.threshold())
    // Heartbeat every ~50 frames (~4s) so you can confirm the loop is alive and
    // watch the score climb as you speak.
    if (wakeDebug() && idx > 0 && idx % 50 === 0) {
      console.debug(`[wakeword] alive — peak score last 4s: ${this.peakScore.toFixed(3)} (fires at ≥ ${this.threshold().toFixed(2)})`)
      this.peakScore = 0
    }
    this.handleScore(smoothed, idx)
  }

  private async inferOnce(frame: Float32Array): Promise<number> {
    const pipeline = this.pipeline!
    // Append the new 80 ms chunk to the rolling raw-audio window (shift left,
    // newest at the end) — mel is recomputed over the WHOLE window so its STFT
    // frames have full inter-chunk context (matches train_wakeword.py exactly).
    appendRaw(this.rawBuffer, frame)
    this.rawFilled = Math.min(this.rawBuffer.length, this.rawFilled + frame.length)
    const valid = this.rawBuffer.subarray(this.rawBuffer.length - this.rawFilled)

    // openWakeWord's mel ONNX expects PCM in int16 range as float32.
    const scaled = new Float32Array(valid.length)
    for (let i = 0; i < valid.length; i++) scaled[i] = valid[i]! * 32767
    const melInput = await tensorFor(scaled, [1, valid.length])
    const melOut = await pipeline.mel.run({ input: melInput })
    const melRaw = firstFloat32(melOut) // (frames * 32), most recent frame last
    const totalFrames = Math.floor(melRaw.length / MEL_FEATURE_DIM)

    // Take the trailing 76 mel frames, apply openWakeWord's x/10 + 2 transform.
    // If fewer than 76 frames exist yet (buffer still filling), pad the FRONT
    // with 1.0 — the same seed train_wakeword.py uses.
    const win = new Float32Array(MEL_BUFFER_SEED_FRAMES * MEL_FEATURE_DIM)
    win.fill(1)
    const take = Math.min(MEL_BUFFER_SEED_FRAMES, totalFrames)
    const srcStart = (totalFrames - take) * MEL_FEATURE_DIM
    const dstStart = (MEL_BUFFER_SEED_FRAMES - take) * MEL_FEATURE_DIM
    for (let i = 0; i < take * MEL_FEATURE_DIM; i++) win[dstStart + i] = melRaw[srcStart + i]! / 10 + 2

    const embInput = await tensorFor(win, [1, MEL_BUFFER_SEED_FRAMES, MEL_FEATURE_DIM, 1])
    const embOut = await pipeline.embedding.run({ input_1: embInput })
    appendEmbedding(this.embeddingBuffer, firstFloat32(embOut))
    const detInput = await tensorFor(
      new Float32Array(this.embeddingBuffer.slice(-16 * EMBEDDING_DIM)),
      [1, 16, EMBEDDING_DIM],
    )
    const detOut = await pipeline.detector.run({ "x.1": detInput })
    const data = firstFloat32(detOut)
    const last = data[data.length - 1] ?? 0
    return clampScore(last)
  }

  /** Trailing moving average over the last SCORE_SMOOTHING_FRAMES raw scores. */
  private smoothScore(score: number): number {
    this.scoreWindow.push(score)
    if (this.scoreWindow.length > SCORE_SMOOTHING_FRAMES) this.scoreWindow.shift()
    let sum = 0
    for (const s of this.scoreWindow) sum += s
    return sum / this.scoreWindow.length
  }

  private handleScore(score: number, frameIndex: number): void {
    const threshold = this.threshold()
    const now = this.now()
    if (score < threshold) {
      this.consecutiveAboveThreshold = 0
      return
    }
    this.consecutiveAboveThreshold += 1
    if (this.consecutiveAboveThreshold < HYSTERESIS_FRAMES_ABOVE) return
    if (this.lastFireAt !== null && now - this.lastFireAt < POST_WAKE_SUPPRESS_MS) return
    this.lastFireAt = now
    this.consecutiveAboveThreshold = 0
    console.info(`[wakeword] ✅ DETECTED "${this.modelEntry.id}" (score ${score.toFixed(2)} ≥ ${threshold.toFixed(2)})`)
    const event: WakeDetectedEvent = {
      modelId: this.modelEntry.id,
      score,
      threshold,
      frameIndex,
      timestamp: now,
    }
    emitWakeDetected(event)
  }
}

function firstFloat32(record: Record<string, { data: unknown }>): Float32Array {
  for (const value of Object.values(record)) return value.data as Float32Array
  throw new Error("ONNX session returned no outputs")
}

function appendRaw(buffer: Float32Array, samples: Float32Array): void {
  const n = samples.length
  if (n >= buffer.length) {
    buffer.set(samples.subarray(n - buffer.length))
    return
  }
  buffer.copyWithin(0, n)                       // shift older samples left
  buffer.set(samples, buffer.length - n)        // newest at the end
}

function appendEmbedding(buffer: Float32Array, embedding: Float32Array): void {
  if (embedding.length < EMBEDDING_DIM) return
  buffer.copyWithin(0, EMBEDDING_DIM)
  buffer.set(embedding.subarray(0, EMBEDDING_DIM), buffer.length - EMBEDDING_DIM)
}

function clampScore(v: number): number {
  if (Number.isNaN(v)) return 0
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}
