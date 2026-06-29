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
import { ensureCompanionWakeword } from '@/lib/pod/companionWake'
import type { PodFireEvent, PodFireTarget } from '@/lib/pod/registry'

import {
  audioChunk,
  audioStart,
  audioStop,
  faceState,
  deviceConfig,
  displayMode,
  layout as layoutEvent,
  replyText,
  soundTrigger,
  alarmFire as alarmFireEvent,
  alarmStop as alarmStopEvent,
  assetSync as assetSyncEvent,
  streamDeckConfig,
  transcript,
  type FaceState,
  type StreamDeckConfigPayload,
  type WyomingEvent,
} from '@/lib/pod/wyoming'
import { effectiveSettings } from '@/lib/pod/deviceSettings'
import { getDeviceMode } from '@/lib/pod/displayMode'
import { resolveDeviceDescriptor } from '@/lib/pod/deviceStudio'
import { resolveControllerDescriptor } from '@/lib/pod/controllerStudio'
import { handleAlarmAction } from '@/lib/pod/scheduler'
import { handleButtonPress } from '@/lib/pod/controllerActions'

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
  private resolvedWakeId: string | null = null // device override → companion model → app default
  private replyStyleOverride = 'inherit'        // device-group reply-length override (server-side)
  private showReplyText = true                  // per-device: type the reply on screen?
  private replyMode: 'voice' | 'text' = 'voice' // device tells us: speak the reply, or show it as text
  private wakeResolved = false // don't load a detector until we know which model (post-auth)
  private wakeSuppressedUntil = 0 // ignore wake until this time (post-TTS self-barge guard)
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
  private captureTimer: ReturnType<typeof setTimeout> | null = null
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
        // Pod did its own (micro)wake word OR a tap-to-talk. A tap carries the device's
        // current reply mode so THIS turn honours it (robust against a separate reply_mode
        // event being lost or racing a reconnect).
        if (ev.data && typeof ev.data.reply === 'string') {
          this.replyMode = ev.data.reply === 'text' ? 'text' : 'voice'
          logger.info(`[pod] tap reply mode → ${this.replyMode}`)
        }
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
        } else if (d && d.name === 'alarm_action' && typeof d.alarm_id === 'string' && this._deviceId) {
          // A snooze/cancel tapped on this device → let the server reschedule/silence
          // and coordinate the dismiss across any other devices ringing the same alarm.
          const action = d.action === 'snooze' ? 'snooze' : 'cancel'
          void handleAlarmAction(String(d.alarm_id), action, this._deviceId)
        } else if (d && d.name === 'button_press' && this.userId && this._deviceId && typeof d.page_id === 'string') {
          void handleButtonPress(this._deviceId, String(d.page_id), Number(d.row), Number(d.col), this.userId)
        } else if (d && d.name === 'reply_mode' && typeof d.mode === 'string') {
          // Device toggled voice ↔ text reply (the bottom-right control). Text mode →
          // we type the reply on its screen instead of speaking it.
          this.replyMode = d.mode === 'text' ? 'text' : 'voice'
          logger.info(`[pod] reply mode → ${this.replyMode}`)
        } else if (d && d.name === 'stop') {
          // The on-screen Stop button — abort the in-flight turn (capture / brain / TTS /
          // typing) and go idle immediately.
          logger.info('[pod] stop pressed — aborting turn')
          this.turnAbort?.abort()
          this.capturing = false
          this.stt?.close(); this.stt = null
          // Bracket the (aborted) reply with an audio-stop so the device ends playback
          // cleanly — deliverReply's own finally skips it when the signal is aborted.
          this.send(audioStop())
          // Force-emit idle (bypassing the setState de-dupe): the device may be showing a
          // stale "thinking" pill while we already believe we're idle — in that case a
          // plain setState('idle') is a no-op and Stop would appear to do nothing.
          this.state = 'idle'
          this.send(faceState('idle'))
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

  /** Push effective settings to the device (registry → on group change / connect).
   *  `responseLength` is applied SERVER-SIDE (it overrides the companion's reply
   *  style for this device's conversations); the device ignores it. */
  applyConfig(config: Record<string, unknown>): void {
    if (this.closed) return
    if (typeof config.responseLength === 'string') this.replyStyleOverride = config.responseLength
    if (typeof config.showReplyText === 'boolean') this.showReplyText = config.showReplyText
    this.send(deviceConfig(config))
  }

  /** Switch the device's screen mode (Admin → Devices → Testing). Pushed live and
   *  re-sent on (re)connect so an offline device restores its mode when it returns. */
  setDisplayMode(mode: string): void {
    if (this.closed) return
    this.send(displayMode(mode))
  }

  /** Push the slot-based dashboard descriptor (Admin → Devices → Layouts). Sent on
   *  (re)connect and whenever the device's template/assignment changes — no re-flash. */
  applyLayout(descriptor: Record<string, unknown>): void {
    if (this.closed) return
    this.send(layoutEvent(descriptor))
  }

  /** Play a UI earcon for an event in the device's active sound pack. */
  playSound(event: string): void {
    if (this.closed) return
    this.send(soundTrigger(event))
  }

  /** Ring a centralised alarm on this device (server owns the schedule + tone). */
  fireAlarm(a: { alarm_id: string; label: string; tone_url: string | null; snooze_minutes: number }): void {
    if (this.closed) return
    this.send(alarmFireEvent(a))
    logger.info(`[pod] alarm_fire "${a.label}" → device`)
  }

  /** Coordinated dismiss — stop a ringing alarm on this device. */
  stopAlarm(alarmId: string): void {
    if (this.closed) return
    this.send(alarmStopEvent(alarmId))
  }

  /** Tell the device to fetch custom WAVs to its SD card (before a custom pack plays). */
  syncAssets(packId: string | null, files: Array<{ path: string; url: string; sha256: string }>): void {
    if (this.closed || !files.length) return
    this.send(assetSyncEvent(packId, files))
  }

  /** Push the stream deck button grid to this device (controller mode). */
  applyStreamDeckConfig(config: StreamDeckConfigPayload): void {
    if (this.closed) return
    this.send(streamDeckConfig(config))
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
    if (this.capturing) {
      // STT needs the full boost to transcribe the quiet ESP mic.
      this.stt?.pushPcm(gained(pcm, POD_MIC_GAIN))
    } else if (this.wakeEnabled && this.wake && this.state !== 'thinking' && this.state !== 'talking') {
      // Only listen for the wake word while idle, and not during the post-TTS guard
      // window — never feed our own reply (same TTS voice as the wake model) back in.
      if (Date.now() < this.wakeSuppressedUntil) return
      // Feed the wake detector a GENTLER gain than STT. The model was trained on
      // normal-amplitude audio; the full 12× boost pushes the quiet-room noise floor
      // into its fire zone and causes false triggers. A lighter gain keeps real speech
      // audible without amplifying silence into a wake.
      this.wake.push(gained(pcm, POD_WAKE_GAIN))
    }
  }

  /** Open an STT capture window (after a wake detection, or in push-to-talk mode). */
  private startCapture(): void {
    this.stt?.close()
    if (this.captureTimer) clearTimeout(this.captureTimer)
    this.stt = new SttSession(
      { sampleRate: this.inRate, silenceTimeoutS: 0.7, partialIntervalS: 0.4, hotwords: '' },
      (msg) => this.onSttEvent(msg as SttMsg),
    )
    this.capturing = true
    // Backstop: if nothing ends the capture (e.g. a false wake with no speech after it,
    // where the silence timer only arms once speech starts), force it closed so the
    // device can never get stuck in "listening" and unresponsive.
    this.captureTimer = setTimeout(() => {
      if (this.capturing) { logger.info('[pod] capture timed out (no speech) — back to idle'); this.endCapture() }
    }, MAX_CAPTURE_MS)
  }

  /** Close the capture window and return to wake-listening / idle. */
  private endCapture(): void {
    this.capturing = false
    if (this.captureTimer) { clearTimeout(this.captureTimer); this.captureTimer = null }
    this.stt?.close()
    this.stt = null
    if (this.state !== 'thinking' && this.state !== 'talking') this.setState('idle')
  }

  /** Lazily load the server-side wake detector for this connection. */
  private ensureWake(): void {
    // Hold off until authenticate() has resolved which model to load — otherwise the
    // device's audio-start (which races auth) would load the default first and we'd be
    // stuck on it (the async load can't be cleanly swapped mid-flight).
    if (!this.wakeResolved) return
    if (this.wake || this.wakeLoading) return
    if (!wakeAvailable()) {
      logger.warn('[pod] POD_WAKE_ENABLED but wake models are missing — disabling server wake')
      this.wakeEnabled = false
      return
    }
    this.wakeLoading = true
    // Prefer the resolved wake word (device override → companion's trained model);
    // otherwise the detector falls back to the app default.
    const w = new WakeDetector({ modelId: this.resolvedWakeId ?? this.wakeWord ?? undefined, hysteresis: POD_WAKE_HYSTERESIS })
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

    const tokens = runPodBrain(text, { userId, characterId: this.characterId, convId: `pod:${userId}`, replyStyleOverride: this.replyStyleOverride, signal: ac.signal })
    try {
      // The reply is ALWAYS typed onto the device screen; it's ALSO spoken aloud when
      // the device's audio output is on (replyMode 'voice'). Audio off ('text') → typed
      // only, no TTS.
      await this.deliverReply(tokens, this.replyMode === 'voice', ac.signal)
    } catch (e) {
      logger.warn(`[pod] brain/reply error: ${(e as Error).message}`)
    }
    if (!ac.signal.aborted) this.setState('idle')
  }

  /** Deliver the reply sentence-by-sentence as the LLM streams it. ALWAYS types each
   *  completed sentence onto the device's screen (one reply_text per sentence — sparse
   *  enough that the device's tiny heap doesn't OOM); ADDITIONALLY speaks it via TTS when
   *  `speak` (device audio output on). One audio-start before the first spoken sentence,
   *  one audio-stop after the last. */
  private async deliverReply(tokens: AsyncIterable<string>, speak: boolean, signal: AbortSignal): Promise<void> {
    const { voiceId } = speak ? parseVoiceId(await voiceConfig.appDefaultVoice()) : { voiceId: '' }
    let buf = ''          // trailing (incomplete) sentence
    let shown = ''        // full text typed to screen so far
    let started = false   // sent audio-start yet?

    const typeSentence = (sentence: string): void => {
      if (!this.showReplyText) return  // this display is configured voice-only
      const clean = stripForSpeech(sentence)
      if (!clean.trim() || signal.aborted) return
      if (speak) {
        // Spoken: PAGINATE — show only the sentence currently being read aloud (the
        // device replaces the previous one), so long replies don't overflow the panel.
        this.send(replyText(clean.trim()))
      } else {
        // Text-only: build up the whole reply so it can be read top-to-bottom.
        shown = (shown ? shown + ' ' : '') + clean.trim()
        this.send(replyText(shown))
      }
    }
    const speakSentence = async (sentence: string): Promise<void> => {
      const clean = stripForSpeech(sentence)
      if (!clean.trim() || signal.aborted) return
      let payload
      try {
        payload = await kokoroEngine.synthesize(clean, { voice: voiceId, speechRate: 1.0, signal })
      } catch (e) {
        logger.warn(`[pod] tts error: ${(e as Error).message}`)
        return
      }
      let pcm = base64ToBytes(payload.pcm_b64)
      if (payload.sample_rate !== POD_TTS_RATE) pcm = resamplePcm16(pcm, payload.sample_rate, POD_TTS_RATE)
      if (!started) { this.setState('talking'); this.send(audioStart(POD_TTS_RATE)); started = true }
      const CHUNK = 2048
      for (let off = 0; off < pcm.length; off += CHUNK) {
        if (signal.aborted) return
        this.send(audioChunk(pcm.subarray(off, Math.min(off + CHUNK, pcm.length)).slice(), POD_TTS_RATE))
      }
    }
    const deliver = async (sentence: string): Promise<void> => {
      typeSentence(sentence)            // always show on screen
      if (speak) await speakSentence(sentence)
    }

    try {
      for await (const tok of tokens) {
        if (signal.aborted) return
        buf += tok
        // Emit complete sentences; keep the trailing (possibly partial) one buffered.
        const segs = segmentSentences(buf)
        if (segs.length > 1) {
          buf = segs[segs.length - 1] ?? ''
          for (const s of segs.slice(0, -1)) { if (signal.aborted) return; await deliver(s) }
        }
      }
      if (!signal.aborted && buf.trim()) await deliver(buf)
    } finally {
      if (started && !signal.aborted) this.send(audioStop())
    }
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

    // Resolve which wake word this device answers to: an explicit per-device override,
    // else its companion's trained model (auto-trained from the companion's phrase on
    // first use), else the app default. The device's auth + audio-start race, so if the
    // detector already loaded with the wrong model, swap it for the resolved one.
    this.resolvedWakeId = this.wakeWord ?? (this.characterId ? await ensureCompanionWakeword(this.characterId) : null)
    // Now that the model is known, release the detector load (held back above).
    this.wakeResolved = true
    if (this.wakeEnabled && !this.closed) this.ensureWake()
    // Push this device's effective settings (group overrides + Default) now that we
    // know its group — this is how an offline-then-online device auto-syncs the latest.
    effectiveSettings(device.groupId).then((s) => this.applyConfig(s as unknown as Record<string, unknown>)).catch(() => {})
    // Restore this device's screen mode (normal/camera-test/touch-test) — an offline
    // device that was put in a test mode picks it back up the instant it reconnects.
    this.setDisplayMode(getDeviceMode(device.id))
    // Re-assert the current conversation state so a reconnecting device can't keep
    // showing a stale "thinking"/"talking" pill from before the drop. setState() dedupes
    // (it won't re-send the state it already holds), so push it explicitly here.
    this.send(faceState(this.state))
    // Push the device's slot-based dashboard descriptor (assigned template or the
    // built-in default) + resolved sound map — this is how a layout/colour/sound edit
    // reaches a device that was offline when it was changed. Fire-and-forget.
    resolveDeviceDescriptor(device.id)
      .then((desc) => { if (desc && !this.closed) this.applyLayout(desc as unknown as Record<string, unknown>) })
      .catch(() => {})
    // Push controller layout alongside display layout on connect.
    resolveControllerDescriptor(device.id, device.userId)
      .then((cfg) => { if (!this.closed) this.applyStreamDeckConfig(cfg) })
      .catch(() => {})
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
    const wasSpeaking = this.state === 'talking'
    this.state = state
    this.send(faceState(state))
    // Self-barge-in guard: the device's reply is the same TTS voice the wake model was
    // trained on, so the tail of its own speech (heard the instant the mic re-enables)
    // can score ~1.0 and self-trigger. When we stop speaking, clear the detector and
    // suppress wake briefly so it can't hear itself.
    if (wasSpeaking && state === 'idle') {
      this.wake?.reset()
      this.wakeSuppressedUntil = Date.now() + WAKE_SUPPRESS_AFTER_TTS_MS
    }
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

// Gentler gain for the wake detector than for STT (see onAudioChunk): the full STT
// boost amplifies the quiet-room noise floor into false wake fires.
const POD_WAKE_GAIN = (() => {
  const g = Number(process.env.POD_WAKE_GAIN)
  return Number.isFinite(g) && g > 0 ? g : 4
})()

// Consecutive frames above threshold required to fire the wake on a device. Higher
// than the browser default to reject the isolated noise spikes the quiet ESP mic
// produces, while a real wake word (which scores high for several frames) still fires.
const POD_WAKE_HYSTERESIS = (() => {
  const v = Number(process.env.POD_WAKE_HYSTERESIS)
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 4
})()

/** Multiply mono Float32 PCM by a gain, in place, soft-clipped to [-1, 1]. */
function gained(pcm: Float32Array, gain: number): Float32Array {
  if (gain === 1) return pcm
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i]! * gain
    pcm[i] = v > 1 ? 1 : v < -1 ? -1 : v
  }
  return pcm
}

// How long to ignore the wake word AFTER the device finishes speaking, so it can't
// self-trigger on the tail of its own TTS reply. Tunable via env (set very high to
// effectively disable wake-after-speech while testing).
const WAKE_SUPPRESS_AFTER_TTS_MS = (() => {
  const v = Number(process.env.POD_WAKE_TTS_SUPPRESS_MS)
  return Number.isFinite(v) && v >= 0 ? v : 2000
})()

// Hard cap on a single STT capture window, so a wake with no speech after it can't
// leave the device stuck in "listening" forever.
const MAX_CAPTURE_MS = (() => {
  const v = Number(process.env.POD_MAX_CAPTURE_MS)
  return Number.isFinite(v) && v > 0 ? v : 9000
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
