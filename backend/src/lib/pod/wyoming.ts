// Wyoming protocol codec — https://github.com/OHF-Voice/wyoming
//
// Wire format (binary-safe, stream-framed over TCP):
//
//   {"type":"...","data_length":N,"payload_length":M}\n   <- newline-terminated JSON header
//   <N bytes of JSON metadata>                            <- optional (data_length)
//   <M bytes of raw binary>                               <- optional (payload_length)
//
// `data` (decoded metadata) is carried length-prefixed AFTER the header line, and
// the binary `payload` (e.g. raw PCM) follows it. This is the canonical framing
// `wyoming-satellite` and Home Assistant speak.

export interface WyomingEvent {
  type: string
  data?: Record<string, unknown>
  payload?: Uint8Array
}

const NEWLINE = 0x0a

/** Serialize one event to its on-the-wire bytes. */
export function encodeEvent(ev: WyomingEvent): Uint8Array {
  const enc = new TextEncoder()
  const dataBytes = ev.data ? enc.encode(JSON.stringify(ev.data)) : undefined
  const header: Record<string, unknown> = { type: ev.type }
  if (dataBytes) header.data_length = dataBytes.length
  if (ev.payload && ev.payload.length) header.payload_length = ev.payload.length

  const headerLine = enc.encode(JSON.stringify(header) + '\n')
  const total = headerLine.length + (dataBytes?.length ?? 0) + (ev.payload?.length ?? 0)
  const out = new Uint8Array(total)
  let o = 0
  out.set(headerLine, o); o += headerLine.length
  if (dataBytes) { out.set(dataBytes, o); o += dataBytes.length }
  if (ev.payload && ev.payload.length) { out.set(ev.payload, o); o += ev.payload.length }
  return out
}

/**
 * Incremental decoder: feed it raw TCP chunks, get back whole events. Headers
 * and payloads split across multiple `data` callbacks are reassembled here.
 */
export class WyomingDecoder {
  // ArrayBufferLike (not ArrayBuffer) so reassigning from `.subarray()` typechecks
  // under TS's stricter typed-array generics.
  private buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0)

  push(chunk: Uint8Array): WyomingEvent[] {
    this.buf = concat(this.buf, chunk)
    const events: WyomingEvent[] = []

    for (;;) {
      const nl = this.buf.indexOf(NEWLINE)
      if (nl < 0) break // no complete header line yet

      let header: { type: string; data_length?: number; payload_length?: number }
      try {
        header = JSON.parse(new TextDecoder().decode(this.buf.subarray(0, nl)))
      } catch {
        // Corrupt/garbage header — resync past the newline rather than wedging.
        this.buf = this.buf.subarray(nl + 1)
        continue
      }

      const dataLen = header.data_length ?? 0
      const payloadLen = header.payload_length ?? 0
      const need = nl + 1 + dataLen + payloadLen
      if (this.buf.length < need) break // wait for the rest of the body

      let off = nl + 1
      let data: Record<string, unknown> | undefined
      if (dataLen > 0) {
        try {
          data = JSON.parse(new TextDecoder().decode(this.buf.subarray(off, off + dataLen)))
        } catch {
          data = undefined
        }
        off += dataLen
      }

      let payload: Uint8Array | undefined
      if (payloadLen > 0) {
        payload = this.buf.subarray(off, off + payloadLen).slice()
        off += payloadLen
      }

      events.push({ type: header.type, data, payload })
      this.buf = this.buf.subarray(need)
    }

    return events
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

// ── Event builders (server → satellite) ──────────────────────────────────────

export function audioStart(rate: number, width = 2, channels = 1): WyomingEvent {
  return { type: 'audio-start', data: { rate, width, channels, timestamp: 0 } }
}

export function audioChunk(pcm: Uint8Array, rate: number, width = 2, channels = 1): WyomingEvent {
  return { type: 'audio-chunk', data: { rate, width, channels }, payload: pcm }
}

export function audioStop(): WyomingEvent {
  return { type: 'audio-stop', data: { timestamp: 0 } }
}

export function transcript(text: string): WyomingEvent {
  return { type: 'transcript', data: { text } }
}

/**
 * Loki Doki display extension (carried on Wyoming `user-event`): tells the Pod
 * what animation/expression the companion should show. The mouth is driven on
 * the Pod from the audio amplitude — see the "Companion face" section of
 * plans/hardware-devices/pod-wyoming-architecture.md.
 */
export function faceState(state: FaceState): WyomingEvent {
  return { type: 'user-event', data: { name: 'face.state', state } }
}

/**
 * Loki Doki config extension (Wyoming `user-event`): pushes a device's effective
 * settings (dimming, …) so the Pod applies them live. Sent on (re)connect and again
 * whenever the device's group settings change — central settings, no re-flash.
 */
export function deviceConfig(settings: Record<string, unknown>): WyomingEvent {
  return { type: 'user-event', data: { name: 'config', ...settings } }
}

/**
 * Loki Doki screen-mode extension (Wyoming `user-event`): switches a screen Pod's
 * UI between the ambient clock, the camera test, and the touch test. Pushed live
 * from Admin → Devices → Testing.
 */
export function displayMode(mode: string): WyomingEvent {
  return { type: 'user-event', data: { name: 'display.mode', mode } }
}

/**
 * Loki Doki layout extension (Wyoming `user-event`): the full slot-based dashboard
 * descriptor — which pre-built widget sits in which 3×3 slot at what size, the theme
 * tokens, and the resolved sound-pack event→URL map. Pushed on (re)connect and on any
 * template/assignment edit; the device places/themes its widgets and caches the sounds
 * (see plans/hardware-devices/tab5-slot-ui.md). `descriptor` is the resolveDeviceDescriptor() object.
 */
export function layout(descriptor: Record<string, unknown>): WyomingEvent {
  return { type: 'user-event', data: { name: 'layout', ...descriptor } }
}

/**
 * Loki Doki earcon extension (Wyoming `user-event`): asks the device to play the
 * sound mapped to a UI event in its active pack (it already cached the URL from the
 * layout descriptor). `wake` is normally played locally on-device for zero latency;
 * this is for the server-owned events (success/error/notification/…).
 */
export function soundTrigger(event: string): WyomingEvent {
  return { type: 'user-event', data: { name: 'sound', event } }
}

/**
 * Loki Doki asset-sync extension (Wyoming `user-event`): tells the device to fetch
 * the listed custom WAVs (url + sha256) to its SD card once, before a custom pack/
 * alarm tone can play. Built-in tones ship in flash and never appear here.
 */
export function assetSync(packId: string | null, files: Array<{ path: string; url: string; sha256: string }>): WyomingEvent {
  return { type: 'user-event', data: { name: 'asset_sync', pack_id: packId, files } }
}

/**
 * Loki Doki centralised-alarm extensions. `alarmFire` rings a device (label + resolved
 * tone URL + snooze minutes); `alarmStop` is the coordinated dismiss sent to the OTHER
 * targets when one device snoozes/cancels. The server owns alarm state — the device is
 * only a renderer (see §8 of the slot-UI doc).
 */
export function alarmFire(a: { alarm_id: string; label: string; tone_url: string | null; snooze_minutes: number }): WyomingEvent {
  return { type: 'user-event', data: { name: 'alarm_fire', ...a } }
}
export function alarmStop(alarmId: string): WyomingEvent {
  return { type: 'user-event', data: { name: 'alarm_stop', alarm_id: alarmId } }
}

export type FaceState = 'idle' | 'listening' | 'thinking' | 'talking' | 'sleeping'
