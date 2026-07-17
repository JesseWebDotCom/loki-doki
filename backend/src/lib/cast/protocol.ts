// Google Cast wire protocol: the CastMessage protobuf and its 4-byte length
// framing. The schema is tiny and fixed, so it's hand-encoded rather than pulling
// in protobufjs — CastMessage has exactly seven fields, all varints or
// length-delimited strings.
//
//   message CastMessage {
//     ProtocolVersion protocol_version = 1;  // varint, always 0 (CASTV2_1_0)
//     string source_id                 = 2;
//     string destination_id            = 3;
//     string namespace                 = 4;
//     PayloadType payload_type         = 5;  // varint, 0 = STRING
//     string payload_utf8              = 6;
//     bytes  payload_binary            = 7;  // unused here
//   }

export interface CastMessage {
  sourceId: string
  destinationId: string
  namespace: string
  payloadUtf8: string
}

function writeVarint(out: number[], value: number): void {
  let v = value >>> 0
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v)
}

function writeString(out: number[], field: number, value: string): void {
  const bytes = new TextEncoder().encode(value)
  out.push((field << 3) | 2) // wire type 2 = length-delimited
  writeVarint(out, bytes.length)
  for (const b of bytes) out.push(b)
}

function writeVarintField(out: number[], field: number, value: number): void {
  out.push((field << 3) | 0) // wire type 0 = varint
  writeVarint(out, value)
}

/** Encode a CastMessage into a length-prefixed frame ready to write to the socket. */
export function encodeMessage(msg: CastMessage): Uint8Array {
  const body: number[] = []
  writeVarintField(body, 1, 0) // protocol_version = CASTV2_1_0
  writeString(body, 2, msg.sourceId)
  writeString(body, 3, msg.destinationId)
  writeString(body, 4, msg.namespace)
  writeVarintField(body, 5, 0) // payload_type = STRING
  writeString(body, 6, msg.payloadUtf8)

  const frame = new Uint8Array(4 + body.length)
  new DataView(frame.buffer).setUint32(0, body.length) // big-endian length prefix
  frame.set(body, 4)
  return frame
}

/** Incremental frame reader: feed it socket chunks, get back complete CastMessages. */
export class FrameReader {
  private buf = new Uint8Array(0)

  push(chunk: Uint8Array): CastMessage[] {
    const merged = new Uint8Array(this.buf.length + chunk.length)
    merged.set(this.buf)
    merged.set(chunk, this.buf.length)
    this.buf = merged

    const messages: CastMessage[] = []
    while (this.buf.length >= 4) {
      const len = new DataView(this.buf.buffer, this.buf.byteOffset, 4).getUint32(0)
      if (this.buf.length < 4 + len) break
      const body = this.buf.subarray(4, 4 + len)
      const parsed = decodeBody(body)
      if (parsed) messages.push(parsed)
      this.buf = this.buf.subarray(4 + len)
    }
    return messages
  }
}

function decodeBody(body: Uint8Array): CastMessage | null {
  let offset = 0
  const readVarint = (): number => {
    let result = 0
    let shift = 0
    while (offset < body.length) {
      const b = body[offset++]!
      result |= (b & 0x7f) << shift
      if ((b & 0x80) === 0) break
      shift += 7
    }
    return result >>> 0
  }
  const msg: CastMessage = { sourceId: '', destinationId: '', namespace: '', payloadUtf8: '' }
  while (offset < body.length) {
    const tag = readVarint()
    const field = tag >>> 3
    const wire = tag & 0x07
    if (wire === 0) {
      readVarint() // varint field (protocol_version / payload_type) — not needed
    } else if (wire === 2) {
      const len = readVarint()
      const slice = body.subarray(offset, offset + len)
      offset += len
      const str = new TextDecoder().decode(slice)
      if (field === 2) msg.sourceId = str
      else if (field === 3) msg.destinationId = str
      else if (field === 4) msg.namespace = str
      else if (field === 6) msg.payloadUtf8 = str
    } else {
      break // unexpected wire type; stop rather than misread
    }
  }
  return msg
}

// ── Cast namespaces ─────────────────────────────────────────────────────────
export const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
} as const

// The stock Default Media Receiver app id — plays a plain media URL, no dev account.
export const DEFAULT_MEDIA_RECEIVER_APP_ID = 'CC1AD845'
