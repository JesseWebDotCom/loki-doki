// Silero VAD v5 (neural voice-activity detection) for the STT session's
// utterance endpointing. Runs via onnxruntime-WEB under Bun for the same reason
// as pod/wake.ts: ort-node's native addon segfaults under Bun, while the WASM EP
// runs fine (one 32 ms chunk ≈ 1 ms on CPU).
//
// Model I/O (v5): input float32 [1, 576] = 64 context samples carried from the
// previous chunk ‖ 512 new samples @ 16 kHz; state float32 [2,1,128] (RNN state,
// carried across chunks); sr int64 scalar. Outputs: output [1,1] speech
// probability, stateN [2,1,128].
//
// The SileroVadStream class body is mirrored in
// frontend/src/lib/voice/silero-vad.ts (barge-in gate) — keep them in sync.

// @ts-ignore - no resolvable .d.ts for the ort-web ESM bundle (see pod/wake.ts)
import * as ort from 'onnxruntime-web'
import type { InferenceSession } from 'onnxruntime-common'
import { readFileSync } from 'node:fs'
import { isSileroVadInstalled, sileroVadPath } from '@/lib/download'
import { logger } from '@/lib/logger'

const CHUNK = 512   // model chunk @ 16 kHz (32 ms)
const CONTEXT = 64  // samples the model wants carried over from the previous chunk

let _ortInit = false
function initOrt(): void {
  if (_ortInit) return
  ort.env.wasm.numThreads = 1
  ort.env.logLevel = 'fatal'
  _ortInit = true
}

// One session process-wide (streams hold per-utterance state, the session is
// stateless). A missing model file is NOT cached as failure — a session created
// after the background download completes picks it up without a restart. A
// corrupt/unloadable file IS sticky until process restart.
let sessionPromise: Promise<InferenceSession> | null = null
let loadFailed = false

export async function getSileroStream(): Promise<SileroVadStream | null> {
  if (loadFailed) return null
  let p = sessionPromise
  if (!p) {
    if (!isSileroVadInstalled()) return null
    initOrt()
    const created: Promise<InferenceSession> = ort.InferenceSession.create(
      new Uint8Array(readFileSync(sileroVadPath())),
      { executionProviders: ['wasm'] },
    )
    p = created
    sessionPromise = created
  }
  try {
    return new SileroVadStream(await p)
  } catch (e) {
    loadFailed = true
    logger.warn(`[stt] silero vad failed to load (${(e as Error).message}) — falling back to RMS VAD`)
    return null
  }
}

export class SileroVadStream {
  private session: InferenceSession
  private pending: Float32Array[] = []
  private pendingLen = 0
  private context = new Float32Array(CONTEXT)
  private state = new Float32Array(2 * 1 * 128)
  private chain: Promise<unknown> = Promise.resolve()
  private _lastProb = 0
  private _failed = false

  constructor(session: InferenceSession) {
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
    } catch (e) {
      this._failed = true
      logger.warn(`[stt] silero vad inference failed (${(e as Error).message}) — falling back to RMS VAD`)
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
      input: new ort.Tensor('float32', input, [1, CONTEXT + CHUNK]),
      state: new ort.Tensor('float32', this.state, [2, 1, 128]),
      sr: new ort.Tensor('int64', BigInt64Array.from([16000n]), []),
    })
    this.state.set(out.stateN!.data as Float32Array)
    this.context.set(chunk.subarray(CHUNK - CONTEXT))
    const prob = Number((out.output!.data as Float32Array)[0])
    this._lastProb = prob
    return prob
  }
}
