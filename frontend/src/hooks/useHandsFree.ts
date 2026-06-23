import { useCallback, useEffect, useRef, useState } from 'react'
import { startMicCapture, type MicCaptureHandle } from '@/lib/voice/mic-capture'
import { WakeWordLoop } from '@/lib/voice/wake-word-loop'
import { WhisperWakewordLoop } from '@/lib/voice/whisper-wakeword-loop'
import { onWakeDetected } from '@/lib/voice/wake-word-events'
import { DEFAULT_WAKE_WORD_MODEL_ID, loadInstalledWakewords, listWakeWordModels, getWakewordCoreInstalled } from '@/lib/voice/wake-word-models'
import { SttCapture } from '@/lib/voice/stt-capture'
import { transition, type HandsFreeState } from '@/lib/voice/handsfree-state-machine'
import { getVoicePlayback, stopSpeech } from '@/lib/voice/voicePlaybackStore'

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
// usable model is assigned — so any arbitrary text can be a wake word with no
// training, but a leftover phrase can never shadow a trained model.

const TTS_MUTE_GRACE_MS = 400
// Dead-reply guard only (a reply that NEVER produces audio). Cancelled the moment
// audio starts, so it can't truncate a working reply — generous enough to outlast a
// cold model load (20–30s to first token) before any audio has played.
const REPLY_SAFETY_MS = 45000
const POST_REPLY_TIMEOUT_MS = 8000
// Phrase wake delivers the command via its own session; if the user says only
// the wake phrase (no command), fall back to idle after this long.
const WAKE_CAPTURE_TIMEOUT_MS = 7000

// Barge-in must tell the USER talking over the companion apart from the
// companion's OWN TTS bleeding speaker→mic (AEC only partially removes it). The
// old 0.07 / 10-frame gate tripped on that echo and cut replies off after the
// first word. Require a LOUDER, more SUSTAINED signal, and only arm barge-in
// AFTER the echo-heavy TTS onset.
const BARGE_IN_RMS_THRESHOLD = 0.16
const BARGE_IN_CONSEC_FRAMES = 22   // ~175 ms of sustained voiced energy
const BARGE_IN_ARM_MS = 700         // ignore the first 700 ms of playback (onset echo)

// Continued conversation: cap auto-continuations so a background voice (TV, other
// people) can't keep the loop alive forever. After this many follow-ups without a
// fresh wake word, return to idle and require the wake word again.
const MAX_CONTINUATIONS = 3

// Stop commands end the turn immediately — kill TTS + exit to idle. Matched only
// on short utterances so "stop by the store" isn't treated as a stop.
const STOP_RE = /\b(stop|cancel|quiet|enough|nevermind|never mind|shut up|go away)\b/
function isStopCommand(text: string): boolean {
  const t = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  return !!t && t.split(' ').length <= 4 && STOP_RE.test(t)
}

export interface UseHandsFreeOptions {
  enabled: boolean
  characterId: string | null | undefined
  wakeWordModelId?: string | null
  wakeWordPhrase?: string | null
  submit: (text: string) => void
  onEngageFailed?: (reason: 'mic-denied' | 'models-missing') => void
}

export interface UseHandsFreeResult {
  state: HandsFreeState
  partial: string
  listening: boolean
}

export function useHandsFree(opts: UseHandsFreeOptions): UseHandsFreeResult {
  const { enabled, characterId, wakeWordModelId, wakeWordPhrase, submit, onEngageFailed } = opts
  const onEngageFailedRef = useRef(onEngageFailed)
  onEngageFailedRef.current = onEngageFailed
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
  const openStt = useCallback(() => {
    if (sttRef.current?.isOpen) return
    const stt = new SttCapture()
    sttRef.current = stt
    const ok = stt.open(
      {
        onReady: () => {
          // capture_open only applies from wake-detected state.
          if (stateRef.current === 'wake-detected') dispatch({ type: 'capture_open' })
        },
        onPartial: (t) => { setPartial(t) },
        onFinal: (text) => {
          setPartial('')
          // Stop command — works in any active state: kill TTS + exit to idle.
          if (isStopCommand(text)) {
            stopSpeech()
            continuationCountRef.current = 0
            dispatch({ type: 'stop_command' })
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
            submitRef.current(text)
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
      wl.onCommand = (cmd) => {
        const st = stateRef.current
        if (st !== 'wake-detected' && st !== 'capturing') return
        if (captureTimeoutRef.current) { clearTimeout(captureTimeoutRef.current); captureTimeoutRef.current = null }
        closeStt()
        setPartial('')
        if (st === 'wake-detected') dispatch({ type: 'capture_open' })
        dispatch({ type: 'stt_final' })
        submitRef.current(cmd)
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
          if (!ttsMutedRef.current) wakeRef.current?.pushFrame(samples)

          // STT: send frames during capturing and post-reply-listen.
          if (sttRef.current?.isOpen && (st === 'capturing' || st === 'post-reply-listen')) {
            sttRef.current.sendFrame(samples)
          }

          // Barge-in energy VAD — runs ONLY while TTS is playing so AEC
          // residual (which clears after TTS ends) never trips it.
          if (st === 'replying' && ttsMutedRef.current && bargeInArmedRef.current) {
            let sumSq = 0
            for (let i = 0; i < samples.length; i++) sumSq += samples[i]! * samples[i]!
            const rms = Math.sqrt(sumSq / Math.max(1, samples.length))
            if (rms >= BARGE_IN_RMS_THRESHOLD) {
              bargeInCountRef.current++
              if (bargeInCountRef.current >= BARGE_IN_CONSEC_FRAMES) {
                bargeInCountRef.current = 0
                bargeInFiredRef.current = true
                stopSpeech()
                dispatch({ type: 'barge_in' })
                openStt()
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
    const off = onWakeDetected(() => {
      if (stateRef.current !== 'idle') return
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

  // ── TTS echo guard + post-TTS continued listening ─────────────────────────
  useEffect(() => {
    const pb = getVoicePlayback()
    const offStart = pb.onPlaybackStart(() => {
      ttsMutedRef.current = true
      bargeInCountRef.current = 0
      // Audio is now playing → the reply works; cancel the dead-reply safety so it
      // can never abort a reply that's actively producing speech (the slow cold-start
      // first reply was being truncated by this at 20s).
      if (replySafetyRef.current) { clearTimeout(replySafetyRef.current); replySafetyRef.current = null }
      // Arm barge-in only AFTER the echo-heavy onset so the companion's own TTS
      // ramp can't trip it. A genuine interruption (user talks over it) almost
      // never lands in the first 700 ms anyway.
      bargeInArmedRef.current = false
      if (bargeInArmTimerRef.current) clearTimeout(bargeInArmTimerRef.current)
      bargeInArmTimerRef.current = setTimeout(() => { bargeInArmedRef.current = true }, BARGE_IN_ARM_MS)
      if (graceRef.current) {
        clearTimeout(graceRef.current)
        graceRef.current = null
      }
    })
    const offEnd = pb.onPlaybackEnd(() => {
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
          postReplyRef.current = setTimeout(() => {
            if (stateRef.current === 'post-reply-listen') {
              closeStt()
              dispatch({ type: 'post_reply_timeout' }) // → idle
            }
          }, POST_REPLY_TIMEOUT_MS)
        }
      }, graceMs)
    })
    return () => {
      offStart()
      offEnd()
    }
  }, [dispatch, openStt, closeStt])

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
    if (!enabled && micRef.current) disengage()
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
