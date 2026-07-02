// Silero VAD v5 (neural voice-activity detection) for the hands-free barge-in
// gate: "is this mic energy actually speech?". Lazy-loads onnxruntime-web the
// same way wake-word-runtime.ts does (bundled WASM under /ort/, no CDN), but
// with its own session — the wake-word SessionFactory hardcodes float32 tensors
// and Silero needs an int64 `sr` input.
//
// Model I/O (v5): input float32 [1, 576] = 64 context samples carried from the
// previous chunk ‖ 512 new samples @ 16 kHz; state float32 [2,1,128] (RNN state,
// carried across chunks); sr int64 scalar. Outputs: output [1,1] speech
// probability, stateN [2,1,128].
//
// The SileroVadStream class body is mirrored in
// backend/src/lib/voice/sileroVad.ts (STT endpointing) — keep them in sync.

import type { InferenceSession, Tensor } from "onnxruntime-web"

const MODEL_URL = "/api/voice/vad-model"
const CHUNK = 512 // model chunk @ 16 kHz (32 ms)
const CONTEXT = 64 // samples the model wants carried over from the previous chunk

type OrtModule = typeof import("onnxruntime-web")

// One attempt per page load, success or failure — never retried per frame. A
// null resolution (model not installed yet / load error) means callers keep
// their energy-only gate; a page reload after the background download lands
// picks the model up.
let loading: Promise<SileroVadStream | null> | null = null

export function getSileroVad(): Promise<SileroVadStream | null> {
  if (!loading) {
    loading = (async () => {
      try {
        const res = await fetch(MODEL_URL, { credentials: "include" })
        if (!res.ok) {
          console.warn("[barge-in] silero vad unavailable — falling back to energy-only gate")
          return null
        }
        const bytes = new Uint8Array(await res.arrayBuffer())
        const ort = await import("onnxruntime-web")
        // Bundle-served WASM: see frontend/public/ort/. No CDN (offline-first).
        // Idempotent with wake-word-runtime.ts setting the same values.
        ort.env.wasm.wasmPaths = "/ort/"
        ort.env.wasm.numThreads = 1
        const session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] })
        return new SileroVadStream(ort, session)
      } catch (err) {
        console.warn("[barge-in] silero vad failed to load — falling back to energy-only gate", err)
        return null
      }
    })()
  }
  return loading
}

export class SileroVadStream {
  private ort: OrtModule
  private session: InferenceSession
  private pending: Float32Array[] = []
  private pendingLen = 0
  private context = new Float32Array(CONTEXT)
  private state = new Float32Array(2 * 1 * 128)
  private chain: Promise<unknown> = Promise.resolve()
  private _lastProb = 0
  private _failed = false

  constructor(ort: OrtModule, session: InferenceSession) {
    this.ort = ort
    this.session = session
  }

  /** Probability of the most recently completed chunk; 0 after reset(). */
  get lastProb(): number {
    return this._lastProb
  }

  /** True once inference has errored — permanent for this stream; callers
   *  should drop to their energy-only fallback. */
  get failed(): boolean {
    return this._failed
  }

  /**
   * Feed arbitrary-length 16 kHz mono f32 samples. Resolves with the
   * probabilities of all 512-sample chunks completed by this call (possibly
   * empty — mic frames are ~128 samples, so most calls just accumulate).
   * Serialized internally so overlapping calls can't interleave RNN state.
   * Never rejects; on inference error sets `failed` and returns what it has.
   */
  push(samples: Float32Array): Promise<number[]> {
    const result = this.chain.then(() => this.process(samples))
    this.chain = result.catch(() => {})
    return result
  }

  /** Zero the RNN state, carried context, pending buffer, and lastProb.
   *  Call when a new logical audio stream starts. */
  reset(): void {
    this.pending = []
    this.pendingLen = 0
    this.context.fill(0)
    this.state.fill(0)
    this._lastProb = 0
  }

  private async process(samples: Float32Array): Promise<number[]> {
    if (this._failed) return []
    this.pending.push(samples)
    this.pendingLen += samples.length
    if (this.pendingLen < CHUNK) return []

    const flat = new Float32Array(this.pendingLen)
    let off = 0
    for (const part of this.pending) {
      flat.set(part, off)
      off += part.length
    }

    const probs: number[] = []
    let consumed = 0
    try {
      while (this.pendingLen - consumed >= CHUNK) {
        probs.push(await this.runChunk(flat.subarray(consumed, consumed + CHUNK)))
        consumed += CHUNK
      }
    } catch (err) {
      this._failed = true
      console.warn("[barge-in] silero vad inference failed — falling back to energy-only gate", err)
      return probs
    }
    const rest = flat.subarray(consumed)
    this.pending = rest.length ? [new Float32Array(rest)] : []
    this.pendingLen = rest.length
    return probs
  }

  private async runChunk(chunk: Float32Array): Promise<number> {
    const input = new Float32Array(CONTEXT + CHUNK)
    input.set(this.context, 0)
    input.set(chunk, CONTEXT)
    const out = await this.session.run({
      input: new this.ort.Tensor("float32", input, [1, CONTEXT + CHUNK]),
      state: new this.ort.Tensor("float32", this.state, [2, 1, 128]),
      sr: new this.ort.Tensor("int64", BigInt64Array.from([16000n]), []),
    })
    this.state.set((out.stateN as Tensor).data as Float32Array)
    this.context.set(chunk.subarray(CHUNK - CONTEXT))
    const prob = Number(((out.output as Tensor).data as Float32Array)[0])
    this._lastProb = prob
    return prob
  }
}
