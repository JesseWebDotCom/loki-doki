// Server-side STT endpointing. Buffers f32le PCM frames from the browser mic,
// runs VAD, and on end-of-speech (silence > timeout) POSTs the utterance WAV to
// whisper.cpp. Emits the v2 wire dialect (ready/vad/partial/final/no_speech) so
// the ported frontend works unchanged.
//
// VAD is Silero (neural, via sileroVad.ts) gated by a cheap RMS pre-check, so
// typing/music/fan noise never opens an utterance and steady noise can't grow
// the buffer to the 30 s force-flush. Falls back to the original pure-RMS
// thresholds when the model isn't installed yet (boot before background
// download), the session isn't 16 kHz, or inference fails.
//
// whisper.cpp has no native streaming partials, so partials re-transcribe the
// growing buffer at partial_interval_s. If that lags on a slow machine, the FSM
// and captions still work on finals alone.

import { transcribeWav } from '@/lib/whisper'
import { getSileroStream, type SileroVadStream } from '@/lib/voice/sileroVad'

export interface SttSessionConfig {
  sampleRate: number
  silenceTimeoutS: number
  partialIntervalS: number
  hotwords: string
}

// Fallback energy thresholds (Silero unavailable).
const VAD_ONSET_RMS = 0.02
const VAD_OFFSET_RMS = 0.012 // hysteresis: lower bar to KEEP speaking
// Silero decision thresholds, applied per completed 512-sample (32 ms) chunk.
const SILERO_ONSET_PROB = 0.5 // chunk prob ≥ this while not speaking → voiced
const SILERO_OFFSET_PROB = 0.35 // < this while speaking → unvoiced (hold in between)
// Below this RMS while not speaking the room is silent: skip inference entirely
// (a stale RNN state across the gap is fine — probs re-converge within a chunk).
const PRE_GATE_RMS = 0.006
// Pre-onset rolling window prepended to the utterance at onset. Silero decides
// per 32 ms chunk and its onset probability ramps over a chunk or two, so
// without this the first phoneme would be clipped from the WAV sent to whisper.
const PREROLL_S = 0.32
const MIN_SPEECH_SAMPLES_FRAC = 0.2 // ignore bursts shorter than 0.2s
// Hard cap on buffered audio (~30s). Steady noise that never dips below the VAD
// offset threshold would otherwise grow the f32 buffer without bound; force a
// finalize once we hit this so memory stays flat.
const MAX_SPEECH_SECONDS = 30

// whisper.cpp transcribes non-speech sounds (typing, clicks, music, breathing)
// as bracketed/parenthetical annotations — "[BLANK_AUDIO]", "(keyboard
// clicking)", "(typing)", "♪♪♪", "*sighs*". The energy VAD can't tell these
// from speech, so without this filter a few keystrokes become a "turn". Strip
// those annotations; if no actual letters survive, it wasn't speech.
function speechContent(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, ' ')     // [BLANK_AUDIO], [ Silence ]
    .replace(/\([^)]*\)/g, ' ')      // (keyboard clicking), (typing)
    .replace(/\*[^*]*\*/g, ' ')      // *clears throat*
    .replace(/♪[^♪]*♪|♪+/g, ' ')     // ♪ music ♪
    .replace(/[^\p{L}\p{N}\s'’]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isLikelySpeech(text: string): boolean {
  return /\p{L}/u.test(speechContent(text))
}

export class SttSession {
  private cfg: SttSessionConfig
  private send: (msg: object) => void
  private speech: Float32Array[] = []
  private speechLen = 0
  private speaking = false
  private silenceSamples = 0
  private samplesSincePartial = 0
  private partialInFlight = false
  private partialPromise: Promise<void> | null = null
  private finalizing = false
  private closed = false
  private silero: SileroVadStream | null = null
  private sileroVoiced = false
  private preroll: Float32Array[] = []
  private prerollLen = 0
  // Serializes frame processing: Silero inference is async, but wire messages
  // (vad/partial/final) must go out in frame-arrival order.
  private chain: Promise<void> = Promise.resolve()

  constructor(cfg: SttSessionConfig, send: (msg: object) => void) {
    this.cfg = cfg
    this.send = send
    // Silero runs at 16 kHz only (the hello default); other negotiated rates
    // stay on the RMS path. Non-blocking: frames arriving before the session
    // loads (or before the model is downloaded) use the RMS fallback.
    if (cfg.sampleRate === 16_000) {
      void getSileroStream().then((s) => {
        if (!this.closed) this.silero = s
      })
    }
  }

  pushPcm(samples: Float32Array): void {
    if (this.closed || this.finalizing) return
    this.chain = this.chain
      .then(() => this.processFrame(samples))
      .catch(() => {/* processFrame handles its own errors; never break the chain */})
  }

  private async processFrame(samples: Float32Array): Promise<void> {
    // Re-check: these may have flipped while the frame sat in the queue.
    if (this.closed || this.finalizing) return
    const rms = computeRms(samples)
    let voiced: boolean
    const silero = this.silero && !this.silero.failed ? this.silero : null

    if (silero) {
      if (!this.speaking && rms < PRE_GATE_RMS) {
        // Room-silent fast path: no inference while nothing is happening.
        this.sileroVoiced = false
      } else {
        for (const prob of await silero.push(samples)) {
          if (prob >= SILERO_ONSET_PROB) this.sileroVoiced = true
          else if (prob < SILERO_OFFSET_PROB) this.sileroVoiced = false
          // In between: hold the previous decision (hysteresis).
        }
        // Frames that complete no 512-sample chunk keep the previous decision;
        // silence accounting below stays per-sample regardless.
      }
      voiced = this.sileroVoiced
    } else {
      const threshold = this.speaking ? VAD_OFFSET_RMS : VAD_ONSET_RMS
      voiced = rms >= threshold
    }

    if (voiced) {
      if (!this.speaking) {
        this.speaking = true
        // Prepend the pre-onset window so Silero's chunk-granular decision
        // latency doesn't clip the first phoneme. (Silero path only — preroll
        // is never buffered on the RMS fallback, keeping it identical to the
        // original behavior. Note the min-speech check in finalize() now sees
        // preroll + speech; isLikelySpeech() still guards the final text.)
        for (const p of this.preroll) {
          this.speech.push(p)
          this.speechLen += p.length
        }
        this.preroll = []
        this.prerollLen = 0
        this.send({ t: 'vad', speaking: true, rms })
      }
      this.silenceSamples = 0
      this.speech.push(samples.slice())
      this.speechLen += samples.length
      this.samplesSincePartial += samples.length
      if (this.samplesSincePartial >= this.cfg.partialIntervalS * this.cfg.sampleRate) {
        this.samplesSincePartial = 0
        void this.emitPartial()
      }
    } else if (this.speaking) {
      // Keep trailing silence in the buffer so the word tail isn't clipped.
      this.speech.push(samples.slice())
      this.speechLen += samples.length
      this.silenceSamples += samples.length
      if (this.silenceSamples >= this.cfg.silenceTimeoutS * this.cfg.sampleRate) {
        void this.finalize()
      }
    } else if (silero) {
      // Not speaking: maintain the rolling pre-onset window.
      this.preroll.push(samples.slice())
      this.prerollLen += samples.length
      const cap = PREROLL_S * this.cfg.sampleRate
      while (this.prerollLen > cap && this.preroll.length > 1) {
        this.prerollLen -= this.preroll.shift()!.length
      }
    }

    // Force-finalize if the buffer has grown past the hard cap, regardless of
    // whether the VAD ever saw an offset (guards against unbounded noise).
    if (this.speaking && this.speechLen >= MAX_SPEECH_SECONDS * this.cfg.sampleRate) {
      void this.finalize()
    }
  }

  /** Client asked to flush (e.g. end of turn) — finalize whatever we have.
   *  Routed through the chain so a queued frame can't race it. */
  end(): void {
    this.chain = this.chain
      .then(() => {
        if (!this.closed && this.speaking) void this.finalize()
      })
      .catch(() => {})
  }

  close(): void {
    this.closed = true
    this.speech = []
  }

  private emitPartial(): Promise<void> {
    if (this.partialInFlight || this.speechLen === 0) return Promise.resolve()
    this.partialInFlight = true
    const run = async () => {
      try {
        const wav = encodeWav(this.flatten(), this.cfg.sampleRate)
        const text = await transcribeWav(wav, this.cfg.hotwords)
        // Re-check state after the await: never emit a partial once the session
        // is closing or has already started finalizing (would race a `final`).
        if (!this.closed && !this.finalizing && text && isLikelySpeech(text)) {
          this.send({ t: 'partial', v: text })
        }
      } catch {
        // whisper down: let finalize surface it; partials stay silent
      } finally {
        this.partialInFlight = false
        this.partialPromise = null
      }
    }
    this.partialPromise = run()
    return this.partialPromise
  }

  private async finalize(): Promise<void> {
    if (this.finalizing) return
    this.finalizing = true
    this.send({ t: 'vad', speaking: false, rms: 0 })

    // Let any in-flight partial transcription settle first. `finalizing` is now
    // set, so that partial re-checks and won't emit after the final below.
    if (this.partialPromise) {
      try { await this.partialPromise } catch { /* ignored */ }
    }
    if (this.closed) { this.reset(); return }

    const minSamples = MIN_SPEECH_SAMPLES_FRAC * this.cfg.sampleRate
    if (this.speechLen < minSamples) {
      this.reset()
      this.send({ t: 'no_speech' })
      return
    }

    const wav = encodeWav(this.flatten(), this.cfg.sampleRate)
    let text = ''
    try {
      text = await transcribeWav(wav, this.cfg.hotwords)
    } catch (e) {
      // Transport/HTTP failure: surface as an error so the FSM can tell "STT
      // down" from "no speech" instead of silently swallowing the utterance.
      this.reset()
      if (!this.closed) this.send({ t: 'error', v: (e as Error).message })
      return
    }
    this.reset()
    if (this.closed) return
    // Only real speech becomes a turn — non-speech annotations (typing, music,
    // silence) are dropped as no_speech so the companion never replies to them.
    if (text && isLikelySpeech(text)) this.send({ t: 'final', v: text })
    else this.send({ t: 'no_speech' })
  }

  private flatten(): Float32Array {
    const out = new Float32Array(this.speechLen)
    let off = 0
    for (const chunk of this.speech) {
      out.set(chunk, off)
      off += chunk.length
    }
    return out
  }

  private reset(): void {
    this.speech = []
    this.speechLen = 0
    this.speaking = false
    this.silenceSamples = 0
    this.samplesSincePartial = 0
    this.finalizing = false
    this.sileroVoiced = false
    this.preroll = []
    this.prerollLen = 0
    // Fresh RNN state for the next utterance in this WS session.
    this.silero?.reset()
  }
}

function computeRms(pcm: Float32Array): number {
  let sumSq = 0
  for (let i = 0; i < pcm.length; i++) sumSq += pcm[i]! * pcm[i]!
  return Math.sqrt(sumSq / Math.max(1, pcm.length))
}

/** Encode mono Float32 PCM as a 16-bit WAV container. */
export function encodeWav(pcm: Float32Array, sampleRate: number): Uint8Array {
  const dataLen = pcm.length * 2
  const buf = new ArrayBuffer(44 + dataLen)
  const view = new DataView(buf)
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataLen, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, dataLen, true)
  let off = 44
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]!))
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    off += 2
  }
  return new Uint8Array(buf)
}
