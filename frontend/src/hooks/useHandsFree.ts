import { useCallback, useEffect, useRef, useState } from 'react'
import { startMicCapture, type MicCaptureHandle } from '@/lib/voice/mic-capture'
import { WakeWordLoop } from '@/lib/voice/wake-word-loop'
import { WhisperWakewordLoop } from '@/lib/voice/whisper-wakeword-loop'
import { onWakeDetected, logActivation } from '@/lib/voice/wake-word-events'
import { DEFAULT_WAKE_WORD_MODEL_ID, loadInstalledWakewords, listWakeWordModels, getWakewordCoreInstalled } from '@/lib/voice/wake-word-models'
import { SttCapture } from '@/lib/voice/stt-capture'
import { transition, type HandsFreeState } from '@/lib/voice/handsfree-state-machine'
import { getVoicePlayback, stopSpeech } from '@/lib/voice/voicePlaybackStore'
import { getSileroVad, type SileroVadStream } from '@/lib/voice/silero-vad'
import { cleanTranscript } from '@/lib/voice/cleanTranscript'

// Hands-free conversation loop:
//   idle → (wake word) → capturing → (whisper final) → submit → replying →
//   (TTS playback ends) → post-reply-listen → (VAD onset) → capturing → …
//
// Barge-in: the barge-in RMS VAD runs only while TTS is playing
// (ttsMutedRef = true), matching v2's barge-in-monitor pattern. Browser
// echoCancellation removes the speaker signal from the mic before we see
// it; residual leakage (~0.01–0.02 RMS) is well below BARGE_IN_THRESHOLD.
// After barge-in the TTS mute grace is skipped (user already speaking).
//
// Continued conversation: after TTS ends the loop stays in post-reply-listen
// with an open STT session for POST_REPLY_TIMEOUT_MS (8 s). VAD onset within
// that window continues without re-requiring the wake word.
//
// Wakeword precedence: a trained ONNX model (wakeWordModelId) always takes
// priority. WhisperWakewordLoop (wakeWordPhrase) is only a fallback when no
// usable model is assigned; so any arbitrary text can be a wake word with no
// training, but a leftover phrase can never shadow a trained model.

const TTS_MUTE_GRACE_MS = 400
// Dead-reply guard only (a reply that NEVER produces audio). Cancelled the moment
// audio starts, so it can't truncate a working reply — generous enough to outlast a
// cold model load (20–30s to first token) before any audio has played.
const REPLY_SAFETY_MS = 45000
// Wake-word-free continuation window after a reply. Shortened from 8s to 4s (design
// P1.4): the long window let TV/other-people speech land a fresh turn well after the
// companion finished, which read as a false wake. A real follow-up comes promptly.
const POST_REPLY_TIMEOUT_MS = 4000
// VAD gate for the trained ONNX wake path (design P1.2): a classifier fire is only
// accepted if it coincides with recent speech (Silero), which rejects the non-speech
// transients the model mis-scores. Fail-open when Silero isn't loaded. The Whisper
// path is inherently speech-gated (it needs a transcript) so it isn't gated here.
const WAKE_VAD_WINDOW_MS = 1200
const WAKE_VAD_PROB = 0.4
// While a staged action awaits confirmation, the wake-word-free follow-up
// window stays open much longer so a considered "yes" still lands.
const POST_REPLY_HOLD_MS = 30_000
// Phrase wake delivers the command via its own session; if the user says only
// the wake phrase (no command), fall back to idle after this long.
const WAKE_CAPTURE_TIMEOUT_MS = 7000

// Barge-in must tell the USER talking over the companion apart from the
// companion's OWN TTS bleeding speaker→mic (AEC only partially removes it). The
// old 0.07 / 10-frame gate tripped on that echo and cut replies off after the
// first word. Require a LOUDER, more SUSTAINED signal, and only arm barge-in
// AFTER the echo-heavy TTS onset.
//
// With Silero VAD loaded the gate becomes energy AND speech-probability: Silero
// rejects loud non-speech (barks, dish clatter, music), which lets the energy
// floor drop to 0.04 so quiet/distant speech can interrupt. The floor can never
// go near the echo residual though — the residual IS speech (the companion's
// own voice), so Silero passes it and only the energy floor rejects it.
const BARGE_IN_RMS_THRESHOLD = 0.10 // legacy energy-only gate (silero unavailable)
const BARGE_IN_RMS_FLOOR_NEURAL = 0.04 // with silero: still 2-3x above AEC echo residual (~0.01-0.02)
const BARGE_IN_PROB_THRESHOLD = 0.60 // silero chunk prob for "this is speech"
const BARGE_IN_CONSEC_FRAMES = 12   // ~95 ms of sustained voiced energy (~3 silero chunks)
const BARGE_IN_ARM_MS = 700         // ignore the first 700 ms of playback (onset echo)
const PREROLL_SAMPLES = 4800        // ~300ms @ 16kHz — rolling pre-roll during the reply
                                    // (captures the onset of an interrupting word).
const PREROLL_MAX_SAMPLES = 24000   // ~1.5s hard cap once barge-in has fired (covers the
                                    // gap until the STT socket opens, without growing forever).

// Continued conversation: cap auto-continuations so a background voice (TV, other
// people) can't keep the loop alive forever. After this many follow-ups without a
// fresh wake word, return to idle and require the wake word again. Lowered from 3 to
// 1 (design P1.4): one prompt follow-up is the natural conversational case; more than
// that is where background speech hijacks the loop.
const MAX_CONTINUATIONS = 1

// Stop commands end the turn immediately — kill TTS + exit to idle. Matched only
// on short utterances so "stop by the store" isn't treated as a stop.
const STOP_RE = /\b(stop|cancel|quiet|enough|nevermind|never mind|shut up|go away)\b/
export function isStopCommand(text: string): boolean {
  const t = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  return !!t && t.split(' ').length <= 4 && STOP_RE.test(t)
}

export interface UseHandsFreeOptions {
  enabled: boolean
  characterId: string | null | undefined
  wakeWordModelId?: string | null
  wakeWordPhrase?: string | null
  /** `whispered`: this utterance was auto-detected as spoken quietly (design:
   *  keen-percolating-swan); callers thread this to the eventual reply's TTS
   *  gain via useCompanionVoice's `hushedThisTurn`. Never true for typed input. */
  submit: (text: string, whispered?: boolean) => void
  /** Hold the post-reply (wake-word-free) listening window open for
   *  POST_REPLY_HOLD_MS instead of the normal timeout, e.g. while a staged
   *  action awaits a spoken confirmation. Re-arms live on change. */
  holdFollowUp?: boolean
  onEngageFailed?: (reason: 'mic-denied' | 'models-missing') => void
  /** Called when a stop command is recognised. `wasTalking` is true if TTS was
   *  actively playing at the moment "stop" was heard (so callers can distinguish
   *  "stop the companion" from "stop the music/video"). */
  onStopCommand?: (wasTalking: boolean) => void
}

export interface UseHandsFreeResult {
  state: HandsFreeState
  partial: string
  listening: boolean
}

export function useHandsFree(opts: UseHandsFreeOptions): UseHandsFreeResult {
  const { enabled, characterId, wakeWordModelId, wakeWordPhrase, submit, holdFollowUp, onEngageFailed, onStopCommand } = opts
  const onEngageFailedRef = useRef(onEngageFailed)
  onEngageFailedRef.current = onEngageFailed
  const holdFollowUpRef = useRef(!!holdFollowUp)
  holdFollowUpRef.current = !!holdFollowUp
  const onStopCommandRef = useRef(onStopCommand)
  onStopCommandRef.current = onStopCommand
  const [state, setStateRaw] = useState<HandsFreeState>('off')
  const [partial, setPartial] = useState('')

  const stateRef = useRef<HandsFreeState>('off')
  const micRef = useRef<MicCaptureHandle | null>(null)
  // Set synchronously at the top of engage() — micRef is only assigned after several
  // awaits, so two overlapping engage() calls would otherwise both acquire a MediaStream.
  const engagingRef = useRef(false)
  const wakeRef = useRef<WakeWordLoop | WhisperWakewordLoop | null>(null)
  const sttRef = useRef<SttCapture | null>(null)
  const ttsMutedRef = useRef(false)
  const graceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const postReplyRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const captureTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Tracks whether barge-in fired so we can skip the TTS mute grace.
  const bargeInFiredRef = useRef(false)
  const bargeInCountRef = useRef(0)
  const bargeInArmedRef = useRef(false)
  const bargeInArmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bargeInPeakRef = useRef(0)
  const bargeInLogRef = useRef(0)
  // Silero speech gate for barge-in; null until loaded (or forever, if the
  // model isn't installed) — the gate is energy-only until then.
  const sileroRef = useRef<SileroVadStream | null>(null)
  // Last time Silero saw speech-like audio while wake-listening; the VAD gate for
  // the ONNX wake path (P1.2) accepts a fire only if this is recent.
  const wakeLastSpeechAtRef = useRef(0)
  const prerollRef = useRef<Float32Array[]>([])
  const prerollLenRef = useRef(0)
  const replySafetyRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const continuationCountRef = useRef(0)
  const submitRef = useRef(submit)
  submitRef.current = submit

  const setState = useCallback((next: HandsFreeState) => {
    stateRef.current = next
    setStateRaw(next)
  }, [])

  const dispatch = useCallback((event: Parameters<typeof transition>[1]) => {
    const next = transition(stateRef.current, event)
    if (next !== stateRef.current) {
      const wl = wakeRef.current
      if (wl instanceof WhisperWakewordLoop) {
        // Phrase wake transcribes the command in its OWN session, so keep it
        // running through wake-detected/capturing — otherwise the start of a
        // run-on command ("hey loki what's the date") is lost. It pauses for
        // replying/post-reply (TTS) and off.
        wl.setEnabled(next === 'idle' || next === 'wake-detected' || next === 'capturing')
      } else {
        wl?.setEnabled(next === 'idle')
      }
      setState(next)
    }
  }, [setState])

  // ── STT lifecycle ────────────────────────────────────────────────────────
  const openStt = useCallback((withPreroll = false) => {
    if (sttRef.current?.isOpen) return
    const stt = new SttCapture()
    sttRef.current = stt
    const ok = stt.open(
      {
        onReady: () => {
          // Replay the pre-roll (the audio captured just before barge-in fired) so the
          // user's first interrupting word reaches STT instead of being clipped.
          if (withPreroll) for (const f of prerollRef.current) stt.sendFrame(f)
          prerollRef.current = []
          prerollLenRef.current = 0
          // capture_open only applies from wake-detected state.
          if (stateRef.current === 'wake-detected') dispatch({ type: 'capture_open' })
        },
        onPartial: (t) => { setPartial(t) },
        onFinal: (text, whispered) => {
          setPartial('')
          // Stop command — works in any active state: kill TTS + exit to idle.
          if (isStopCommand(text)) {
            const wasTalking = getVoicePlayback().isPlaying
            stopSpeech()
            continuationCountRef.current = 0
            dispatch({ type: 'stop_command' })
            onStopCommandRef.current?.(wasTalking)
            return
          }
          if (stateRef.current !== 'capturing') {
            // Spurious final during post-reply-listen monitoring — re-open.
            if (sttRef.current === stt) sttRef.current = null
            if (stateRef.current === 'post-reply-listen') openStt()
            return
          }
          if (text) {
            dispatch({ type: 'stt_final' })
            // Clean disfluencies (um/uh, false starts) before the text is shown and sent.
            // isStopCommand above deliberately ran on the raw text.
            submitRef.current(cleanTranscript(text), whispered)
          } else {
            dispatch({ type: 'stop_command' })
          }
        },
        onVad: (speaking) => {
          if (speaking && stateRef.current === 'post-reply-listen') {
            if (postReplyRef.current) clearTimeout(postReplyRef.current)
            // Bound auto-continuation so a background voice can't loop forever.
            if (continuationCountRef.current >= MAX_CONTINUATIONS) {
              sttRef.current?.close(); sttRef.current = null
              dispatch({ type: 'post_reply_timeout' }) // → idle, require wake word
              return
            }
            continuationCountRef.current++
            // This activation is a wake-word-FREE follow-up, not a wake fire, tag it
            // so it's distinguishable in diagnostics (P0.0) rather than looking like
            // the wake word triggered.
            logActivation('follow-up-vad', `continuation ${continuationCountRef.current}/${MAX_CONTINUATIONS}`)
            dispatch({ type: 'vad_onset' })
          }
        },
        onNoSpeech: () => {
          setPartial('')
          const st = stateRef.current
          if (st === 'capturing') {
            dispatch({ type: 'stop_command' })
          } else if (st === 'post-reply-listen') {
            if (sttRef.current === stt) sttRef.current = null
            openStt()
          }
        },
        onError: (m) => console.warn('[handsfree] STT error:', m),
        onClose: () => {
          if (sttRef.current === stt) sttRef.current = null
        },
      },
      { hotwords: '' },
    )
    if (!ok) console.warn('[handsfree] STT socket failed to open')
  }, [dispatch])

  const closeStt = useCallback(() => {
    sttRef.current?.close()
    sttRef.current = null
  }, [])

  // ── Engage / disengage ───────────────────────────────────────────────────
  const disengage = useCallback(() => {
    engagingRef.current = false
    if (graceRef.current) clearTimeout(graceRef.current)
    if (postReplyRef.current) clearTimeout(postReplyRef.current)
    if (captureTimeoutRef.current) clearTimeout(captureTimeoutRef.current)
    closeStt()
    wakeRef.current?.setEnabled(false)
    wakeRef.current = null
    micRef.current?.stop()
    micRef.current = null
    ttsMutedRef.current = false
    bargeInFiredRef.current = false
    bargeInCountRef.current = 0
    setPartial('')
    setState('off')
  }, [closeStt, setState])

  const engage = useCallback(async () => {
    if (micRef.current || engagingRef.current) return
    engagingRef.current = true
    setState('engaging')
    // Kick off the barge-in speech gate load in parallel with everything else;
    // non-blocking — the gate is energy-only until (unless) it resolves.
    void getSileroVad().then((s) => { sileroRef.current = s })
    await loadInstalledWakewords(true)

    // A configured trained ONNX model always wins over a free-text phrase, so a
    // stale/leftover phrase can never silently shadow a model the user trained.
    // The phrase path is only a fallback when no usable model is assigned.
    const available = new Set(listWakeWordModels().map((m) => m.id))
    const modelId = wakeWordModelId && available.has(wakeWordModelId) ? wakeWordModelId : null
    // If falling back to ONNX but the core models aren't on the server yet, bail out
    // so the user gets a clear error instead of the loop silently never detecting anything.
    if (!modelId && !wakeWordPhrase?.trim() && getWakewordCoreInstalled() === false) {
      engagingRef.current = false
      setState('off')
      onEngageFailedRef.current?.('models-missing')
      return
    }
    let wakeLoop: WakeWordLoop | WhisperWakewordLoop
    if (modelId) {
      wakeLoop = new WakeWordLoop({ modelId })
      console.info(`[handsfree] engaging — ONNX wake model "${modelId}", requesting mic…`)
    } else if (wakeWordPhrase?.trim()) {
      const wl = new WhisperWakewordLoop(wakeWordPhrase.trim())
      // Echo the live command transcript while the user is still speaking. The
      // first command partial also advances wake-detected → capturing so the
      // overlay's capture caption + active indicator light up (the ONNX path gets
      // this from its STT socket's onReady; the phrase path has no such socket).
      wl.onPartial = (cmd) => {
        const st = stateRef.current
        if (st !== 'wake-detected' && st !== 'capturing') return
        if (st === 'wake-detected') dispatch({ type: 'capture_open' })
        setPartial(cmd)
      }
      // The wake loop captured "<phrase> <command>" in one breath — submit the
      // command directly instead of opening a lossy second capture session.
      wl.onCommand = (cmd, whispered) => {
        const st = stateRef.current
        if (st !== 'wake-detected' && st !== 'capturing') return
        if (captureTimeoutRef.current) { clearTimeout(captureTimeoutRef.current); captureTimeoutRef.current = null }
        closeStt()
        setPartial('')
        if (isStopCommand(cmd)) {
          const wasTalking = getVoicePlayback().isPlaying
          stopSpeech()
          continuationCountRef.current = 0
          dispatch({ type: 'stop_command' })
          onStopCommandRef.current?.(wasTalking)
          return
        }
        if (st === 'wake-detected') dispatch({ type: 'capture_open' })
        dispatch({ type: 'stt_final' })
        submitRef.current(cleanTranscript(cmd), whispered)
      }
      wakeLoop = wl
      console.info(`[handsfree] engaging — whisper wakeword phrase "${wakeWordPhrase.trim()}"`)
    } else {
      wakeLoop = new WakeWordLoop({ modelId: DEFAULT_WAKE_WORD_MODEL_ID })
      console.info(`[handsfree] engaging — ONNX wake model "${DEFAULT_WAKE_WORD_MODEL_ID}" (default), requesting mic…`)
    }
    wakeLoop.setEnabled(false)
    wakeRef.current = wakeLoop

    let mic: MicCaptureHandle
    try {
      mic = await startMicCapture({
        onFrame: (samples) => {
          const st = stateRef.current
          if (st === 'off' || st === 'engaging') return

          // Wake loop: gated by the TTS echo guard; setEnabled ensures it
          // only runs during `idle` state.
          if (!ttsMutedRef.current) {
            wakeRef.current?.pushFrame(samples)
            // Feed Silero while wake-listening so the ONNX wake VAD gate (below, in
            // onWakeDetected) has a fresh speech signal. Cheap; fire-and-forget.
            if (st === 'idle') {
              const s = sileroRef.current && !sileroRef.current.failed ? sileroRef.current : null
              if (s) {
                void s.push(samples)
                if (s.lastProb >= WAKE_VAD_PROB) wakeLastSpeechAtRef.current = Date.now()
              }
            }
          }

          // Buffer mic audio we want but can't send yet, so barge-in never clips the
          // user's opening words. Two parts: a short rolling pre-roll DURING the reply
          // (the word onset), PLUS everything in the gap between barge-in firing and the
          // STT socket actually opening — that gap was silently dropping whole words.
          // Once barge-in has fired (st==='capturing') the TTS is stopped, so this audio
          // is clean (no echo). Flushed into STT in openStt's onReady.
          if (!sttRef.current?.isOpen && (st === 'replying' || st === 'capturing')) {
            prerollRef.current.push(samples.slice())
            prerollLenRef.current += samples.length
            // Trim to a short rolling window WHILE PLAYING; once capturing, keep all
            // frames (up to a hard cap) so nothing in the gap is lost.
            const cap = st === 'replying' ? PREROLL_SAMPLES : PREROLL_MAX_SAMPLES
            while (prerollLenRef.current > cap && prerollRef.current.length > 1) {
              prerollLenRef.current -= prerollRef.current.shift()!.length
            }
          }

          // STT: send frames during capturing and post-reply-listen.
          if (sttRef.current?.isOpen && (st === 'capturing' || st === 'post-reply-listen')) {
            sttRef.current.sendFrame(samples)
          }

          // Barge-in VAD — runs ONLY while TTS is playing so AEC residual
          // (which clears after TTS ends) never trips it. Energy-only until
          // Silero loads; then energy AND speech-probability (see constants).
          if (st === 'replying' && ttsMutedRef.current) {
            let sumSq = 0
            for (let i = 0; i < samples.length; i++) sumSq += samples[i]! * samples[i]!
            const rms = Math.sqrt(sumSq / Math.max(1, samples.length))
            if (rms > bargeInPeakRef.current) bargeInPeakRef.current = rms
            // Feed the speech gate ONLY in this branch (plus the reset on
            // playback start), so lastProb always reflects reply-time audio.
            // Fire-and-forget: the stream serializes internally, and a chunk
            // completes every ~4 of these ~128-sample frames — the gate below
            // reads the held probability of the most recent completed chunk.
            const silero = sileroRef.current && !sileroRef.current.failed ? sileroRef.current : null
            if (silero) void silero.push(samples)
            const hit = silero
              ? rms >= BARGE_IN_RMS_FLOOR_NEURAL && silero.lastProb >= BARGE_IN_PROB_THRESHOLD
              : rms >= BARGE_IN_RMS_THRESHOLD
            const thr = silero ? BARGE_IN_RMS_FLOOR_NEURAL : BARGE_IN_RMS_THRESHOLD
            // Live monitor (~every 25 frames ≈ 0.2s): shows whether barge-in is armed
            // and the current mic RMS vs the fire threshold, so a "barge-in not working"
            // is diagnosable from the console — is it never arming, or is your voice
            // (after echo-cancellation) just never crossing the threshold?
            if ((bargeInLogRef.current = (bargeInLogRef.current + 1) % 25) === 0) {
              console.info(`[barge-in] monitor armed=${bargeInArmedRef.current} rms=${rms.toFixed(3)} thr=${thr} prob=${silero ? silero.lastProb.toFixed(2) : 'n/a'} consec=${bargeInCountRef.current}`)
            }
            if (bargeInArmedRef.current && hit) {
              bargeInCountRef.current++
              if (bargeInCountRef.current >= BARGE_IN_CONSEC_FRAMES) {
                bargeInCountRef.current = 0
                bargeInFiredRef.current = true
                console.info(`[barge-in] FIRED — interrupting (rms=${rms.toFixed(3)} ≥ ${thr}, prob=${silero ? silero.lastProb.toFixed(2) : 'n/a'})`)
                logActivation('barge-in', `rms=${rms.toFixed(3)} prob=${silero ? silero.lastProb.toFixed(2) : 'n/a'}`)
                stopSpeech()
                dispatch({ type: 'barge_in' })
                openStt(true) // replay the pre-roll so the first interrupting word isn't lost
              }
            } else {
              bargeInCountRef.current = 0
            }
          } else {
            bargeInCountRef.current = 0
          }
        },
      })
    } catch (err) {
      console.warn('[handsfree] mic permission denied', err)
      engagingRef.current = false
      wakeRef.current = null
      setState('off')
      onEngageFailedRef.current?.('mic-denied')
      return
    }
    // If disengage() ran during the awaits above, abandon this mic instead of going live
    // (otherwise the stream leaks and the assistant stays hot after the user disengaged).
    if (!engagingRef.current) { mic.stop(); return }
    micRef.current = mic
    engagingRef.current = false
    console.info('[handsfree] mic ready — listening for the wake word')
    setState('idle')
    wakeLoop.setEnabled(true)
    // Surface ONNX inference errors (wrong model, 404, bad tensor names) so the
    // user gets a toast instead of the loop silently never detecting anything.
    if (wakeLoop instanceof WakeWordLoop) {
      let onnxErrored = false
      wakeLoop.onError = () => {
        if (onnxErrored) return
        onnxErrored = true
        onEngageFailedRef.current?.('models-missing')
        disengage()
      }
    }
  }, [setState, wakeWordModelId, wakeWordPhrase, dispatch, openStt, closeStt, disengage])

  // Wake-word detected → open STT and start capturing.
  useEffect(() => {
    const off = onWakeDetected((ev) => {
      if (stateRef.current !== 'idle') return
      // VAD gate for the trained ONNX detector (P1.2): require recent speech, which
      // rejects the non-speech transients the classifier occasionally mis-scores.
      // Fail-open when Silero isn't loaded/working. The Whisper path already needs a
      // transcript, so it's inherently gated and skips this.
      if (ev.origin === 'onnx-wake') {
        const s = sileroRef.current
        if (s && !s.failed && Date.now() - wakeLastSpeechAtRef.current > WAKE_VAD_WINDOW_MS) {
          console.info(`[wakeword] fire suppressed by VAD gate, no speech in last ${WAKE_VAD_WINDOW_MS}ms`)
          return
        }
      }
      continuationCountRef.current = 0  // fresh wake resets the continuation budget
      dispatch({ type: 'wake_detected' })
      if (wakeRef.current instanceof WhisperWakewordLoop) {
        // Phrase wake delivers the command via onCommand from the SAME session —
        // no separate capture socket (which would only catch the command's tail).
        // Fall back to idle if the user said only the phrase and no command.
        if (captureTimeoutRef.current) clearTimeout(captureTimeoutRef.current)
        captureTimeoutRef.current = setTimeout(() => {
          if (stateRef.current === 'wake-detected' || stateRef.current === 'capturing') {
            if (wakeRef.current instanceof WhisperWakewordLoop) wakeRef.current.reset()
            setPartial('')
            dispatch({ type: 'stop_command' })
          }
        }, WAKE_CAPTURE_TIMEOUT_MS)
      } else {
        openStt()
        // Watchdog: if the STT socket never opens/readies (so we never reach 'capturing'),
        // don't strand the FSM in 'wake-detected' — the wake loop is disabled outside 'idle',
        // so the assistant would go permanently deaf until a manual toggle.
        if (captureTimeoutRef.current) clearTimeout(captureTimeoutRef.current)
        captureTimeoutRef.current = setTimeout(() => {
          if (stateRef.current === 'wake-detected') {
            closeStt()
            setPartial('')
            dispatch({ type: 'stop_command' })
          }
        }, WAKE_CAPTURE_TIMEOUT_MS)
      }
    })
    return off
  }, [dispatch, openStt, closeStt])

  // Arms (or re-arms) the post-reply-listen dismissal. Duration stretches while
  // a confirmation is pending (holdFollowUp) so a spoken "yes" lands without a
  // wake word.
  const armPostReplyTimeout = useCallback(() => {
    if (postReplyRef.current) clearTimeout(postReplyRef.current)
    postReplyRef.current = setTimeout(() => {
      if (stateRef.current === 'post-reply-listen') {
        closeStt()
        dispatch({ type: 'post_reply_timeout' }) // → idle
      }
    }, holdFollowUpRef.current ? POST_REPLY_HOLD_MS : POST_REPLY_TIMEOUT_MS)
  }, [dispatch, closeStt])

  // Live re-arm: a confirmation arriving (or resolving) mid-window adjusts the
  // remaining time immediately instead of waiting for the old timer.
  useEffect(() => {
    if (stateRef.current === 'post-reply-listen') armPostReplyTimeout()
  }, [holdFollowUp, armPostReplyTimeout])

  // ── TTS echo guard + post-TTS continued listening ─────────────────────────
  useEffect(() => {
    const pb = getVoicePlayback()
    const offStart = pb.onPlaybackStart(() => {
      ttsMutedRef.current = true
      bargeInCountRef.current = 0
      bargeInPeakRef.current = 0
      // Fresh RNN state per reply — lastProb can never be stale from a
      // previous reply's audio.
      sileroRef.current?.reset()
      // Audio is now playing → the reply works; cancel the dead-reply safety so it
      // can never abort a reply that's actively producing speech (the slow cold-start
      // first reply was being truncated by this at 20s).
      if (replySafetyRef.current) { clearTimeout(replySafetyRef.current); replySafetyRef.current = null }
      // Arm barge-in only AFTER the echo-heavy onset so the companion's own TTS
      // ramp can't trip it. A genuine interruption (user talks over it) almost
      // never lands in the first 700 ms anyway.
      bargeInArmedRef.current = false
      if (bargeInArmTimerRef.current) clearTimeout(bargeInArmTimerRef.current)
      bargeInArmTimerRef.current = setTimeout(() => { bargeInArmedRef.current = true; console.info('[barge-in] armed — interruption now possible') }, BARGE_IN_ARM_MS)
      if (graceRef.current) {
        clearTimeout(graceRef.current)
        graceRef.current = null
      }
    })
    const offEnd = pb.onPlaybackEnd(() => {
      console.info(`[barge-in] reply ended — peak mic rms while speaking=${bargeInPeakRef.current.toFixed(3)} (fires at ≥${sileroRef.current && !sileroRef.current.failed ? `${BARGE_IN_RMS_FLOOR_NEURAL} + prob ≥ ${BARGE_IN_PROB_THRESHOLD}` : BARGE_IN_RMS_THRESHOLD} for ${BARGE_IN_CONSEC_FRAMES} frames)`)
      // After barge-in the user is already speaking — skip the grace period
      // so the STT socket receives their frames immediately.
      const bargeInFired = bargeInFiredRef.current
      bargeInFiredRef.current = false
      const graceMs = bargeInFired ? 0 : TTS_MUTE_GRACE_MS

      graceRef.current = setTimeout(() => {
        ttsMutedRef.current = false
        graceRef.current = null
        if (stateRef.current === 'replying') {
          dispatch({ type: 'tts_end' }) // → post-reply-listen
          openStt() // Open for continued-conversation capture
          armPostReplyTimeout()
        }
      }, graceMs)
    })
    return () => {
      offStart()
      offEnd()
    }
  }, [dispatch, openStt, closeStt, armPostReplyTimeout])

  // Safety: if a reply never produces audio (e.g. voice off), force to idle.
  useEffect(() => {
    if (state !== 'replying') return
    const t = setTimeout(() => {
      if (stateRef.current === 'replying') {
        stopSpeech()
        closeStt()
        ttsMutedRef.current = false
        dispatch({ type: 'tts_end' })
        dispatch({ type: 'post_reply_timeout' })
      }
    }, REPLY_SAFETY_MS)
    replySafetyRef.current = t
    return () => { clearTimeout(t); if (replySafetyRef.current === t) replySafetyRef.current = null }
  }, [state, dispatch, closeStt])

  // Keep wake loop pointed at the active phrase/model.
  useEffect(() => {
    const loop = wakeRef.current
    if (!loop) return
    if (wakeWordPhrase?.trim()) {
      if (loop instanceof WhisperWakewordLoop) loop.setPhrase(wakeWordPhrase.trim())
    } else if (loop instanceof WakeWordLoop) {
      const newId = wakeWordModelId || DEFAULT_WAKE_WORD_MODEL_ID
      // Force-reload registry so newly trained models are available before setModel.
      void loadInstalledWakewords(true).then(() => {
        if (wakeRef.current instanceof WakeWordLoop) wakeRef.current.setModel(newId)
      })
    }
  }, [wakeWordModelId, wakeWordPhrase])

  // Engage/disengage follows the `enabled` flag.
  useEffect(() => {
    if (enabled && !micRef.current) void engage()
    // Disengage unconditionally on !enabled — NOT gated on micRef.current. engage() only sets
    // micRef after its awaits (wakeword load, the mic-permission prompt), so a toggle-off during
    // that window would otherwise leave micRef null → disengage never runs → the mic stays live
    // and wake detection keeps running with the UI showing off. disengage() safely handles the
    // not-yet-engaged case and clears engagingRef, which engage()'s post-await check honors.
    if (!enabled) disengage()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  // Tear down on unmount.
  useEffect(() => () => disengage(), [disengage])

  // Character switch mid-session: cut in-flight audio for clean handoff.
  useEffect(() => {
    if (micRef.current && stateRef.current !== 'idle') {
      stopSpeech()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId])

  const listening = state === 'idle' || state === 'wake-detected' || state === 'capturing' || state === 'post-reply-listen'
  return { state, partial, listening }
}
