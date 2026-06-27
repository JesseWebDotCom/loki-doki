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
import { addPending, removePending } from '@/lib/pod/pending'
import { evictForDevice } from '@/lib/pod/registry'
import type { PodFireEvent, PodFireTarget } from '@/lib/pod/registry'

// Per-device cooldown for the spoken "Connected and ready" greeting. A device
// re-authenticates on every reconnect (network blip, server restart), and greeting
// each time is noisy — only speak it after a real gap (a genuine power-cycle).
const lastAnnounceAt = new Map<string, number>()
const ANNOUNCE_COOLDOWN_MS = 15 * 60 * 1000
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

export class SatelliteSession implements PodFireTarget {
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
  private _deviceId: string | null = null
  private hwid: string | null = null
  // Wake mode: ON by default (the Pod streams continuously; the Host runs
  // openWakeWord and opens an STT capture window after each detection — this is
  // what enables repeated, hands-free "Hey Jarvis …" turns). Opt out with
  // POD_WAKE_ENABLED=0, in which case the incoming stream IS a single utterance
  // (push-to-talk / on-device wake / the test harness).
  private wakeEnabled = process.env.POD_WAKE_ENABLED !== '0'
  private wake: WakeDetector | null = null
  private wakeLoading = false
  private capturing = false
  // Temporary diagnostics: track incoming audio level so we can tell a silent mic
  // (RMS ≈ 0) from a working mic where the wake word just isn't matching.
  private diagN = 0
  private diagRms = 0

  constructor(send: Send) {
    this.send = send
    this.setState('idle')
  }

  handle(ev: WyomingEvent): void {
    if (this.closed) return
    if (ev.type !== 'audio-chunk') logger.info(`[pod-diag] ← ${ev.type} ${ev.data ? JSON.stringify(ev.data).slice(0, 70) : ''}`)
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
        // Loki Doki extensions:
        //   { name:'auth', token }            — a paired device binds its session
        //   { name:'hello', hwid, model, caps } — an unclaimed device announces itself
        const d = ev.data
        if (d && d.name === 'auth' && typeof d.token === 'string') {
          void this.authenticate(d.token)
        } else if (d && d.name === 'hello' && typeof d.hwid === 'string') {
          this.onHello(d.hwid, typeof d.model === 'string' ? d.model : null, d.caps ?? null)
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
    if (this.hwid) removePending(this.hwid)
    this.turnAbort?.abort()
    this.stt?.close()
    this.stt = null
    if (this.wake) { this.wake.onDetect = null; this.wake = null }
  }

  /**
   * First-boot announce from an unclaimed (screenless) device. Make it claimable in
   * the admin panel; on Claim, the server mints a token and calls back to deliver it
   * down this still-open socket — no code to type or read off the device.
   */
  private onHello(hwid: string, model: string | null, caps: unknown): void {
    this.hwid = hwid
    if (this._deviceId) return // already bound — nothing to claim
    addPending({
      hwid,
      model,
      caps,
      firstSeen: Date.now(),
      claim: async (_deviceId, token) => {
        // Hand the device its token (persisted to flash for next boot)…
        this.send({ type: 'user-event', data: { name: 'auth', token } })
        // …and bind this live session now so it works without reconnecting.
        await this.authenticate(token)
      },
    })
    logger.info(`[pod] unclaimed device announced (hwid ${hwid}${model ? `, ${model}` : ''})`)
  }

  // ── PodFireTarget: server-pushed events (scheduler / notifications) ──────────

  /** The user this connection is bound to — used by the scheduler to target Pods. */
  get boundUserId(): string | null {
    return this.userId
  }

  /** The paired device id — used by the admin panel to show live online status. */
  get deviceId(): string | null {
    return this._deviceId
  }

  /** Current conversation state — used by the admin panel's live-activity badge. */
  get activity(): FaceState {
    return this.state
  }

  /** Speak a phrase on the device on demand (the admin "Test" button) — bypasses
   *  wake/STT/LLM so we can verify the speaker/playback path directly. */
  async testSpeak(text: string): Promise<void> {
    if (this.closed) return
    this.turnAbort?.abort()
    const ac = new AbortController()
    this.turnAbort = ac
    await this.speak(text, ac.signal)
    if (!ac.signal.aborted) this.setState('idle')
  }

  /** Push an unprompted alarm/timer event. The Pod shows its ring screen + tone. */
  fire(event: PodFireEvent): void {
    if (this.closed) return
    this.send({
      type: 'user-event',
      data: { name: 'fire', kind: event.kind, label: event.label, tone: event.tone ?? null, announce: event.announce ?? true },
    })
    logger.info(`[pod] pushed ${event.kind} "${event.label}" to device`)
    // TODO(phase-1+): if event.announce, have the companion speak it (this.speak)
    // once we're confident it won't collide with an in-flight capture/turn.
  }

  // ── Inbound audio → wake/STT ────────────────────────────────────────────────

  private onAudioStart(ev: WyomingEvent): void {
    this.inRate = (ev.data?.rate as number) ?? 16000
    logger.info(`[pod-diag] audio-start rate=${this.inRate} wakeEnabled=${this.wakeEnabled}`)
    this.stt?.close()
    this.stt = null
    this.capturing = false

    if (this.wakeEnabled) {
      // In server-wake mode the mic stream is CONTINUOUS — audio-start fires once at
      // connect, it is NOT a barge-in. So don't cancel an in-flight reply (that was
      // killing the "Connected and ready" announce) and don't clobber the talking
      // state. Real barge-in is handled by a wake hit during playback.
      if (this.inRate !== 16000) {
        logger.warn(`[pod] wake needs 16 kHz audio; got ${this.inRate}Hz — detection may not fire`)
      }
      this.ensureWake()
      if (this.state !== 'talking') this.setState('idle')
    } else {
      // No server wake — each incoming stream is the utterance, so cancel any prior
      // reply and capture this one.
      this.turnAbort?.abort()
      this.startCapture()
    }
  }

  private onAudioChunk(ev: WyomingEvent): void {
    if (!ev.payload) return
    const pcm = int16ToFloat32(ev.payload)
    // diag: average incoming level every ~50 chunks
    this.diagN++
    let sum = 0
    for (let i = 0; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!
    this.diagRms += Math.sqrt(sum / Math.max(1, pcm.length))
    if (this.diagN >= 50) {
      logger.info(`[pod-diag] audio RMS ${(this.diagRms / this.diagN).toFixed(4)} (x${POD_MIC_GAIN}=${(this.diagRms / this.diagN * POD_MIC_GAIN).toFixed(3)}) state=${this.state} capturing=${this.capturing} wakeReady=${!!this.wake}`)
      this.diagN = 0; this.diagRms = 0
    }
    // Boost the quiet device mic before wake/STT (soft-clipped to avoid overflow).
    if (POD_MIC_GAIN !== 1) {
      for (let i = 0; i < pcm.length; i++) {
        const v = pcm[i]! * POD_MIC_GAIN
        pcm[i] = v > 1 ? 1 : v < -1 ? -1 : v
      }
    }
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
    try {
    for (const sentence of sentences) {
      if (signal.aborted) break
      let payload
      try {
        payload = await kokoroEngine.synthesize(sentence, { voice: voiceId, speechRate: 1.0, signal })
      } catch (e) {
        logger.warn(`[pod] tts error: ${(e as Error).message}`)
        break
      }
      // Resample Kokoro's native rate (≈24 kHz) down to POD_TTS_RATE so a Pod can
      // run ONE fixed I2S rate for both mic and speaker (the Atom Echo shares the
      // I2S peripheral; 16 kHz both ways is ESPHome's proven config). Resolves the
      // architecture doc's open-decision #1 in favour of fixed-rate playback.
      let pcm = base64ToBytes(payload.pcm_b64)
      if (payload.sample_rate !== POD_TTS_RATE) pcm = resamplePcm16(pcm, payload.sample_rate, POD_TTS_RATE)
      if (!started) {
        this.send(audioStart(POD_TTS_RATE))
        started = true
      }
      // Stream the sentence as SMALL audio packets, exactly like Home Assistant's
      // voice_assistant — never one giant frame. A tiny satellite (classic ESP32)
      // can only hold a couple of KB of inbound audio at once; a whole-sentence
      // frame would force it to buffer tens of KB and OOM-crash. 2 KB ≈ 64 ms @ 16 kHz.
      const POD_AUDIO_CHUNK = 2048
      for (let off = 0; off < pcm.length; off += POD_AUDIO_CHUNK) {
        if (signal.aborted) break
        this.send(audioChunk(pcm.subarray(off, Math.min(off + POD_AUDIO_CHUNK, pcm.length)).slice(), POD_TTS_RATE))
      }
    }
    if (started) this.send(audioStop())
    } finally {
      // Always release the "talking" state when playback ends — whether it finished
      // or was aborted. Otherwise the live activity badge stays stuck on "Speaking".
      if (this.state === 'talking') this.setState('idle')
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Bind this connection to a paired device via its token. */
  private async authenticate(token: string): Promise<void> {
    const device = await authenticateDeviceToken(token)
    if (!device || this.closed) {
      if (!device) logger.warn('[pod] device auth failed (invalid token)')
      return
    }
    this._deviceId = device.id
    this.userId = device.userId
    this.characterId = device.characterId ?? null
    this.wakeWord = device.wakeWord ?? null
    if (device.hwid) this.hwid = device.hwid
    if (this.hwid) removePending(this.hwid) // claimed/known now — drop from the discoverable list
    evictForDevice(device.id, this) // drop any stale prior session for this device
    logger.info(`[pod] authenticated device "${device.name}" (${device.kind}) → user ${device.userId}`)
    // Audibly confirm the device reached the server — a screenless satellite has no
    // other way to show it's online and working. Fire-and-forget so auth never blocks.
    void this.announceConnected()
  }

  /** Speak a short confirmation on (re)connect. Reuses the verified speak() path
   *  (same as the admin Test button); guarded so it never blocks or throws into auth. */
  private async announceConnected(): Promise<void> {
    try {
      if (this.closed || !this._deviceId) return
      // Stay quiet if we greeted this device recently — avoids re-announcing on every
      // quick reconnect / server restart. Only a real power-cycle (long gap) speaks.
      const now = Date.now()
      if (now - (lastAnnounceAt.get(this._deviceId) ?? 0) < ANNOUNCE_COOLDOWN_MS) return
      lastAnnounceAt.set(this._deviceId, now)
      this.turnAbort?.abort()
      const ac = new AbortController()
      this.turnAbort = ac
      logger.info('[pod] announcing "Connected and ready" on the device')
      await this.speak('Connected and ready.', ac.signal)
      if (!ac.signal.aborted) this.setState('idle')
    } catch (e) {
      logger.warn(`[pod] connected-announce failed: ${(e as Error).message}`)
    }
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

// Fixed playback rate pushed to Pods (one I2S rate for mic + speaker).
const POD_TTS_RATE = 16000

// The ESP32 PDM mic is quiet; boost incoming audio before wake/STT. Tunable via
// env so it can be dialed in without re-flashing the device.
const POD_MIC_GAIN = (() => {
  const g = Number(process.env.POD_MIC_GAIN)
  return Number.isFinite(g) && g > 0 ? g : 12
})()

/** Linear-interpolate mono int16 LE PCM from one sample rate to another (speech-grade). */
function resamplePcm16(bytes: Uint8Array, fromRate: number, toRate: number): Uint8Array {
  if (fromRate === toRate) return bytes
  const inView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const inLen = Math.floor(bytes.byteLength / 2)
  if (inLen === 0) return bytes
  const outLen = Math.max(1, Math.floor((inLen * toRate) / fromRate))
  const out = new Uint8Array(outLen * 2)
  const outView = new DataView(out.buffer)
  const ratio = fromRate / toRate
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio
    const i0 = Math.floor(srcPos)
    const i1 = Math.min(i0 + 1, inLen - 1)
    const frac = srcPos - i0
    const s0 = inView.getInt16(i0 * 2, true)
    const s1 = inView.getInt16(i1 * 2, true)
    outView.setInt16(i * 2, Math.round(s0 + (s1 - s0) * frac), true)
  }
  return out
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
