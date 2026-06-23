// One connected Pod (Wyoming satellite). Owns the per-connection pipeline FSM and
// bridges the Wyoming wire to Loki Doki's existing voice brains:
//
//   audio-chunk (PCM in) ─▶ SttSession ─▶ transcript ─▶ runPodBrain ─▶ Kokoro TTS ─▶ audio-chunk (PCM out)
//
// Pipeline states map 1:1 onto the companion-face animations the Pod renders
// (see plans/hardware-devices/pod-wyoming-architecture.md):
//
//   idle → listening (audio streaming in) → thinking (LLM) → talking (TTS) → idle
//
// Two modes:
//   • Server wake (POD_WAKE_ENABLED=1): the Pod streams continuously; audio feeds
//     openWakeWord (pod/wake.ts) and only opens an STT capture window on a
//     detection. End-of-speech is detected by SttSession's VAD.
//   • Push-to-talk / on-device wake (default): the incoming stream IS the
//     utterance (the Pod woke itself, or the test harness sends one clip).

import { logger } from '@/lib/logger'
import { db } from '@/db'
import { users } from '@/db/schema'
import { SttSession, encodeWav } from '@/lib/voice/sttSession'
import { kokoroEngine } from '@/lib/voice/engines/kokoroEngine'
import { parseVoiceId, segmentSentences, voiceConfig } from '@/lib/voice'
import { stripForSpeech } from '@/lib/voice/speechText'
import { runPodBrain } from '@/lib/pod/brain'
import { WakeDetector, wakeAvailable } from '@/lib/pod/wake'
import { authenticateDeviceToken } from '@/lib/pod/devices'
import {
  audioChunk,
  audioStart,
  audioStop,
  faceState,
  transcript,
  type FaceState,
  type WyomingEvent,
} from '@/lib/pod/wyoming'

type Send = (ev: WyomingEvent) => void

export class SatelliteSession {
  private send: Send
  private stt: SttSession | null = null
  private inRate = 16000
  private state: FaceState = 'idle'
  private turnAbort: AbortController | null = null
  private closed = false
  // TODO(device identity): resolve the user + companion bound to this device via
  // the `devices` table + auth handshake. Until that lands, fall back to
  // POD_DEFAULT_USER_ID or the first user row so the loop works end-to-end.
  private userId: string | null = null
  private characterId: string | null = null
  private wakeWord: string | null = null
  private deviceId: string | null = null
  // Wake mode: when on, the Pod streams continuously; the Host runs openWakeWord
  // and only opens an STT capture window after a detection. When off (default —
  // and what the test harness uses), incoming audio IS the utterance (the Pod did
  // its own wake / push-to-talk).
  private wakeEnabled = process.env.POD_WAKE_ENABLED === '1'
  private wake: WakeDetector | null = null
  private wakeLoading = false
  private capturing = false

  constructor(send: Send) {
    this.send = send
    this.setState('idle')
  }

  handle(ev: WyomingEvent): void {
    if (this.closed) return
    switch (ev.type) {
      case 'describe':
        this.sendInfo()
        break
      case 'audio-start':
        this.onAudioStart(ev)
        break
      case 'audio-chunk':
        this.onAudioChunk(ev)
        break
      case 'audio-stop':
        if (this.capturing) this.stt?.end()
        break
      case 'detection':
        // Pod did its own (micro)wake word — open a capture window.
        if (!this.capturing) this.startCapture()
        break
      case 'user-event': {
        // Loki Doki extension: device auth handshake { name:'auth', token }.
        const d = ev.data
        if (d && d.name === 'auth' && typeof d.token === 'string') {
          void this.authenticate(d.token)
        }
        break
      }
      case 'run-pipeline':
      case 'run-satellite':
      case 'ping':
        // Accepted; nothing to do in the scaffold.
        break
      default:
        // Unknown/unsupported events are ignored (forward-compatible).
        break
    }
  }

  close(): void {
    this.closed = true
    this.turnAbort?.abort()
    this.stt?.close()
    this.stt = null
    if (this.wake) { this.wake.onDetect = null; this.wake = null }
  }

  // ── Inbound audio → wake/STT ────────────────────────────────────────────────

  private onAudioStart(ev: WyomingEvent): void {
    this.inRate = (ev.data?.rate as number) ?? 16000
    // Barge-in: a new audio stream cancels any in-flight reply.
    this.turnAbort?.abort()
    this.stt?.close()
    this.stt = null
    this.capturing = false

    if (this.wakeEnabled) {
      if (this.inRate !== 16000) {
        logger.warn(`[pod] wake needs 16 kHz audio; got ${this.inRate}Hz — detection may not fire`)
      }
      this.ensureWake()
      this.setState('idle')
    } else {
      // No server wake — the incoming stream is the utterance.
      this.startCapture()
    }
  }

  private onAudioChunk(ev: WyomingEvent): void {
    if (!ev.payload) return
    const pcm = int16ToFloat32(ev.payload)
    if (this.capturing) {
      this.stt?.pushPcm(pcm)
    } else if (this.wakeEnabled && this.wake && this.state !== 'thinking' && this.state !== 'talking') {
      // Only listen for the wake word while idle — never feed our own TTS back in.
      this.wake.push(pcm)
    }
  }

  /** Open an STT capture window (after a wake detection, or in push-to-talk mode). */
  private startCapture(): void {
    this.stt?.close()
    this.stt = new SttSession(
      { sampleRate: this.inRate, silenceTimeoutS: 0.7, partialIntervalS: 0.4, hotwords: '' },
      (msg) => this.onSttEvent(msg as SttMsg),
    )
    this.capturing = true
  }

  /** Close the capture window and return to wake-listening / idle. */
  private endCapture(): void {
    this.capturing = false
    this.stt?.close()
    this.stt = null
    if (this.state !== 'thinking' && this.state !== 'talking') this.setState('idle')
  }

  /** Lazily load the server-side wake detector for this connection. */
  private ensureWake(): void {
    if (this.wake || this.wakeLoading) return
    if (!wakeAvailable()) {
      logger.warn('[pod] POD_WAKE_ENABLED but wake models are missing — disabling server wake')
      this.wakeEnabled = false
      return
    }
    this.wakeLoading = true
    // Use the device's bound wake word (e.g. a custom-trained "hey_loki") if set;
    // otherwise the detector falls back to the app default.
    const w = new WakeDetector({ modelId: this.wakeWord ?? undefined })
    w.onDetect = () => this.onWakeDetect()
    w.load()
      .then((ok) => {
        if (ok && !this.closed) { this.wake = w; logger.info(`[pod] wake detector ready ("${w.modelId}")`) }
        else this.wakeEnabled = false
      })
      .catch((e) => { logger.warn(`[pod] wake load failed: ${(e as Error).message}`); this.wakeEnabled = false })
      .finally(() => { this.wakeLoading = false })
  }

  private onWakeDetect(): void {
    if (this.closed || this.capturing) return
    // Tell the Pod a wake fired (chime / show "listening"), then capture.
    this.send({ type: 'detection', data: { name: this.wake?.modelId ?? 'wake' } })
    this.setState('listening')
    this.startCapture()
  }

  private onSttEvent(msg: SttMsg): void {
    switch (msg.t) {
      case 'vad':
        if (msg.speaking && this.state !== 'listening') this.setState('listening')
        break
      case 'final':
        if (msg.v) void this.handleTurn(msg.v)
        else this.endCapture()
        break
      case 'no_speech':
        this.endCapture()
        break
      case 'error':
        logger.warn(`[pod] STT error: ${msg.v}`)
        this.endCapture()
        break
    }
  }

  // ── Transcript → brain → TTS ───────────────────────────────────────────────

  private async handleTurn(text: string): Promise<void> {
    // The transcript is in — close the capture window. Wake stays suppressed
    // while thinking/talking (see onAudioChunk), then resumes when we hit idle.
    this.capturing = false
    this.stt?.close()
    this.stt = null

    this.send(transcript(text))
    this.setState('thinking')

    const userId = await this.ensureUser()
    if (!userId) {
      logger.warn('[pod] no user bound to this device; cannot run a turn')
      this.setState('idle')
      return
    }

    const ac = new AbortController()
    this.turnAbort = ac

    // SCAFFOLD: collect the full reply, then synthesize sentence-by-sentence.
    // TODO(phase-1+): synthesize each sentence as the LLM emits it (mirror the
    // chat→tts streaming in routes/chat.ts) to cut time-to-first-word.
    let reply = ''
    try {
      for await (const tok of runPodBrain(text, {
        userId,
        characterId: this.characterId,
        convId: `pod:${userId}`,
        signal: ac.signal,
      })) {
        if (ac.signal.aborted) return
        reply += tok
      }
    } catch (e) {
      logger.warn(`[pod] brain error: ${(e as Error).message}`)
      this.setState('idle')
      return
    }

    if (ac.signal.aborted) return
    await this.speak(reply, ac.signal)
    if (!ac.signal.aborted) this.setState('idle')
  }

  private async speak(text: string, signal: AbortSignal): Promise<void> {
    const clean = stripForSpeech(text)
    const sentences = segmentSentences(clean)
    if (sentences.length === 0) return

    const { voiceId } = parseVoiceId(await voiceConfig.appDefaultVoice())
    this.setState('talking')

    let started = false
    let rate = 0
    for (const sentence of sentences) {
      if (signal.aborted) break
      let payload
      try {
        payload = await kokoroEngine.synthesize(sentence, { voice: voiceId, speechRate: 1.0, signal })
      } catch (e) {
        logger.warn(`[pod] tts error: ${(e as Error).message}`)
        break
      }
      const pcm = base64ToBytes(payload.pcm_b64)
      if (!started) {
        rate = payload.sample_rate
        this.send(audioStart(rate))
        started = true
      }
      // TODO(open decision #1): optionally resample rate→16000 here for a single
      // fixed Pod playback rate. For now we forward Kokoro's native rate and let
      // the Pod handle it (Wyoming audio-chunk carries the rate).
      this.send(audioChunk(pcm, payload.sample_rate))
    }
    if (started) this.send(audioStop())
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Bind this connection to a paired device via its token. */
  private async authenticate(token: string): Promise<void> {
    const device = await authenticateDeviceToken(token)
    if (!device || this.closed) {
      if (!device) logger.warn('[pod] device auth failed (invalid token)')
      return
    }
    this.deviceId = device.id
    this.userId = device.userId
    this.characterId = device.characterId ?? null
    this.wakeWord = device.wakeWord ?? null
    logger.info(`[pod] authenticated device "${device.name}" (${device.kind}) → user ${device.userId}`)
  }

  private async ensureUser(): Promise<string | null> {
    // Prefer the authenticated device's user (set in authenticate()).
    if (this.userId) return this.userId
    // Dev fallback until a device pairs: POD_DEFAULT_USER_ID, else the first user.
    const envUser = process.env.POD_DEFAULT_USER_ID
    if (envUser) { this.userId = envUser; return this.userId }
    const [row] = await db.select({ id: users.id }).from(users).limit(1)
    this.userId = row?.id ?? null
    return this.userId
  }

  private setState(state: FaceState): void {
    if (state === this.state) return
    this.state = state
    this.send(faceState(state))
  }

  private sendInfo(): void {
    // Advertise capabilities (minimal). Real services list models/voices here.
    this.send({
      type: 'info',
      data: {
        asr: [{ name: 'whisper' }],
        tts: [{ name: 'kokoro' }],
        handle: [{ name: 'loki-doki' }],
        satellite: { name: 'loki-doki-pod' },
      },
    })
  }
}

interface SttMsg {
  t: 'ready' | 'vad' | 'partial' | 'final' | 'no_speech' | 'error'
  v?: string
  speaking?: boolean
}

/** Wyoming PCM is signed 16-bit LE; SttSession wants normalized Float32. */
function int16ToFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const n = Math.floor(bytes.byteLength / 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768
  return out
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, 'base64'))
}

// Re-exported so the test harness can write received PCM to a .wav.
export { encodeWav }
