// One-shot dictation capture for the desktop shell's system-wide dictation hotkey.
//
// Reuses the same transport as hands-free (mic-capture → 16 kHz f32le frames →
// /api/stt/stream), but with no wake word, no FSM, and no companion submit: it just
// captures one utterance and resolves the transcript. The desktop shell then pastes
// it into whatever app has focus (see desktop/src/dictation.js).
//
// Finalize happens either when the server detects a silence gap (its silence_timeout)
// or when the caller invokes stop() (second hotkey press), whichever comes first.

import { startMicCapture, type MicCaptureHandle } from './mic-capture'
import { SttCapture } from './stt-capture'

export interface DictationSession {
  /** Force-finalize the current utterance (flush to the server for a final result). */
  stop: () => void
  /** Abort with no result (resolves done with ''). */
  cancel: () => void
  /** Resolves with the transcript ('' when nothing intelligible was heard). Never rejects for
   *  an empty/no-speech capture; rejects only when the mic or STT socket could not start. */
  done: Promise<string>
}

export interface DictationOptions {
  sttModel?: string
  /** Silence gap (seconds) that ends an utterance. Dictation uses a longer default than
   *  hands-free so natural mid-sentence pauses don't cut the capture short. */
  silenceTimeoutS?: number
}

export function startDictation(opts: DictationOptions = {}): DictationSession {
  const stt = new SttCapture()
  let mic: MicCaptureHandle | null = null
  let settled = false
  let resolveDone!: (t: string) => void
  let rejectDone!: (e: Error) => void
  const done = new Promise<string>((res, rej) => { resolveDone = res; rejectDone = rej })

  const cleanup = () => {
    try { mic?.stop() } catch { /* ignore */ }
    mic = null
    try { stt.close() } catch { /* ignore */ }
  }
  const finish = (text: string) => {
    if (settled) return
    settled = true
    cleanup()
    resolveDone(text)
  }
  const fail = (err: Error) => {
    if (settled) return
    settled = true
    cleanup()
    rejectDone(err)
  }

  const opened = stt.open(
    {
      onFinal: (text) => finish(text),
      onNoSpeech: () => finish(''),
      onError: (msg) => fail(new Error(msg)),
    },
    { sttModel: opts.sttModel, silenceTimeoutS: opts.silenceTimeoutS ?? 1.5 },
  )
  if (!opened) {
    fail(new Error('stt_unavailable'))
    return { stop: () => {}, cancel: () => {}, done }
  }

  // Feed mic frames into the socket. Frames that arrive before the ws opens are
  // dropped by SttCapture.sendFrame (a few ms of preroll), which is fine.
  void startMicCapture({ onFrame: (samples) => stt.sendFrame(samples) })
    .then((handle) => {
      if (settled) { try { handle.stop() } catch { /* ignore */ } return }
      mic = handle
    })
    .catch((err) => fail(err instanceof Error ? err : new Error('mic_failed')))

  return {
    stop: () => { try { stt.end() } catch { /* ignore */ } },
    cancel: () => finish(''),
    done,
  }
}
