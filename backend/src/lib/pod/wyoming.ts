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

export type FaceState = 'idle' | 'listening' | 'thinking' | 'talking' | 'sleeping'
