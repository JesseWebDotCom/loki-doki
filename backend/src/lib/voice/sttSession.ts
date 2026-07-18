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
import { markInteractive } from '@/lib/activityGate'
import { logger } from '@/lib/logger'

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

// Auto whisper-match (design: keen-percolating-swan): an utterance is classified
// "whispered" when its average RMS across genuine speech frames (NOT the preroll
// or trailing-silence hangover, both near-silent by construction and otherwise
// dilute the average) falls below this. Deliberately a WEAK prior, not a tuned
// constant: on the primary Silero path, onset/offset is decided by voice-activity
// probability, not amplitude, so a real whisper Silero confidently detects as
// speech can register well below the other RMS constants above (which were tuned
// for onset/offset gating, not loudness classification). It also has a real
// confound: mic-capture.ts requests autoGainControl:true, which may normalize a
// deliberate whisper toward normal loudness before it ever reaches this code;
// this is the single biggest risk to the feature working reliably and needs
// real-world tuning, not just a threshold tweak.
const WHISPER_RMS_THRESHOLD = 0.01

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
  // Phase 1.1 (voice-latency): running length (samples) at the most recent VOICED
  // frame, and the last still-valid partial transcription tagged with the voiced
  // length it captured. If no voiced audio arrives after that snapshot (only
  // trailing silence, which whisper ignores), the partial already transcribes the
  // whole utterance and finalize() can skip a redundant full re-decode.
  private lastVoicedLen = 0
  private reusablePartial: { text: string; voicedLen: number } | null = null
  // Set when the voiced→silence edge wanted a full-buffer decode but a periodic
  // partial was still in flight; the partial's `finally` runs the deferred decode.
  private redecodeAtEdge = false
  // Accumulated only over genuine-speech frames (the `voiced` branch below); see
  // WHISPER_RMS_THRESHOLD's comment for why preroll/trailing-silence are excluded.
  private speechRmsSum = 0
  private speechRmsCount = 0
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
        // Live voice capture is interactive: background jobs sharing the Whisper
        // sidecar (podcast transcription) yield so live STT stays responsive.
        markInteractive()
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
      this.lastVoicedLen = this.speechLen
      this.speechRmsSum += rms
      this.speechRmsCount++
      this.samplesSincePartial += samples.length
      if (this.samplesSincePartial >= this.cfg.partialIntervalS * this.cfg.sampleRate) {
        this.samplesSincePartial = 0
        void this.emitPartial()
      }
    } else if (this.speaking) {
      // Keep trailing silence in the buffer so the word tail isn't clipped.
      const firstSilenceFrame = this.silenceSamples === 0
      this.speech.push(samples.slice())
      this.speechLen += samples.length
      this.silenceSamples += samples.length
      // Voiced→silence edge (P1.1): kick a decode of the COMPLETE speech buffer NOW
      // so it overlaps the silence-timeout wait instead of starting cold at finalize.
      // If the user really stopped, finalize() reuses this result (no voiced audio
      // arrives after, so its coverage still matches). If a periodic partial is
      // mid-flight, defer via redecodeAtEdge so a full-coverage decode still runs
      // the moment the sidecar frees up. If speech resumes, coverage won't match and
      // finalize falls back to a fresh decode: never wrong, at worst today's cost.
      if (firstSilenceFrame) {
        if (this.partialInFlight) this.redecodeAtEdge = true
        else void this.emitPartial()
      }
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
      // Snapshot the voiced length at the audio we're about to transcribe, so
      // finalize() can tell whether this partial covered the whole utterance.
      const capturedVoicedLen = this.lastVoicedLen
      try {
        const wav = encodeWav(this.flatten(), this.cfg.sampleRate)
        const text = await transcribeWav(wav, this.cfg.hotwords)
        if (text && isLikelySpeech(text)) {
          // Store for possible reuse at finalize even while finalizing (finalize
          // awaits this partial); only the live wire emit is gated on state, since
          // emitting a `partial` after `final`/close would race the FSM.
          this.reusablePartial = { text, voicedLen: capturedVoicedLen }
          if (!this.closed && !this.finalizing) this.send({ t: 'partial', v: text })
        }
      } catch {
        // whisper down: let finalize surface it; partials stay silent
      } finally {
        this.partialInFlight = false
        this.partialPromise = null
        // A silence-edge decode was requested while this one ran (P1.1). Now that the
        // sidecar is free, run the full-coverage decode, but only if we're still in
        // the trailing-silence hangover (speech didn't resume, finalize hasn't fired).
        if (this.redecodeAtEdge && !this.finalizing && !this.closed && this.speaking && this.silenceSamples > 0) {
          this.redecodeAtEdge = false
          void this.emitPartial()
        } else {
          this.redecodeAtEdge = false
        }
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

    // Captured before reset() clears the accumulators below.
    const whispered = this.speechRmsCount > 0 && (this.speechRmsSum / this.speechRmsCount) < WHISPER_RMS_THRESHOLD

    const _t0 = performance.now()
    let text = ''
    let reused = false
    const rp = this.reusablePartial
    if (rp && rp.voicedLen > 0 && rp.voicedLen === this.lastVoicedLen) {
      // No voiced audio arrived after this partial's snapshot: everything since
      // was trailing silence, which whisper ignores. The partial already
      // transcribes the whole utterance, so skip a redundant full re-decode
      // (~0.6–0.8s off the critical path). Phase 1.1, see docs/internal/voice-latency.md.
      text = rp.text
      reused = true
    } else {
      const wav = encodeWav(this.flatten(), this.cfg.sampleRate)
      try {
        text = await transcribeWav(wav, this.cfg.hotwords)
      } catch (e) {
        // Transport/HTTP failure: surface as an error so the FSM can tell "STT
        // down" from "no speech" instead of silently swallowing the utterance.
        this.reset()
        if (!this.closed) this.send({ t: 'error', v: (e as Error).message })
        return
      }
    }
    logger.info(`[VOICE-STT] final decode=${(performance.now() - _t0).toFixed(0)}ms reused=${reused} len=${(this.speechLen / this.cfg.sampleRate).toFixed(1)}s`)
    this.reset()
    if (this.closed) return
    // Only real speech becomes a turn — non-speech annotations (typing, music,
    // silence) are dropped as no_speech so the companion never replies to them.
    if (text && isLikelySpeech(text)) this.send({ t: 'final', v: text, whispered })
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
    this.lastVoicedLen = 0
    this.reusablePartial = null
    this.redecodeAtEdge = false
    this.speechRmsSum = 0
    this.speechRmsCount = 0
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
