// Server-side STT endpointing. Buffers f32le PCM frames from the browser mic,
// runs a simple RMS VAD, and on end-of-speech (silence > timeout) POSTs the
// utterance WAV to whisper.cpp. Emits the v2 wire dialect (ready/vad/partial/
// final/no_speech) so the ported frontend works unchanged.
//
// whisper.cpp has no native streaming partials, so partials re-transcribe the
// growing buffer at partial_interval_s. If that lags on a slow machine, the FSM
// and captions still work on finals alone.

import { transcribeWav } from '@/lib/whisper'

export interface SttSessionConfig {
  sampleRate: number
  silenceTimeoutS: number
  partialIntervalS: number
  hotwords: string
}

const VAD_ONSET_RMS = 0.02
const VAD_OFFSET_RMS = 0.012 // hysteresis: lower bar to KEEP speaking
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

  constructor(cfg: SttSessionConfig, send: (msg: object) => void) {
    this.cfg = cfg
    this.send = send
  }

  pushPcm(samples: Float32Array): void {
    if (this.closed || this.finalizing) return
    const rms = computeRms(samples)
    const threshold = this.speaking ? VAD_OFFSET_RMS : VAD_ONSET_RMS
    const voiced = rms >= threshold

    if (voiced) {
      if (!this.speaking) {
        this.speaking = true
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
    }

    // Force-finalize if the buffer has grown past the hard cap, regardless of
    // whether the VAD ever saw an offset (guards against unbounded noise).
    if (this.speaking && this.speechLen >= MAX_SPEECH_SECONDS * this.cfg.sampleRate) {
      void this.finalize()
    }
  }

  /** Client asked to flush (e.g. end of turn) — finalize whatever we have. */
  end(): void {
    if (this.speaking) void this.finalize()
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
