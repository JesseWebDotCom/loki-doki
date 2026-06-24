// Audio normalization helpers: TTS sidecars hand back WAV; the frontend
// scheduler wants base64 signed-16-bit-LE mono PCM + a sample rate.
//
// Supports PCM (fmt 1) 8/16/32-bit and IEEE float (fmt 3) 32-bit WAV. Stereo is
// downmixed to mono by averaging channels.

export interface PcmResult {
  pcmB64: string
  sampleRate: number
}

/**
 * Parse a WAV container into mono int16 PCM, base64-encoded. An optional linear
 * `gain` (default 1) scales amplitude before quantization — used for emote-driven
 * loudness (whisper ≈ 0.55, emphatic ≈ 1.1). Hard-clamped; a soft limiter is a
 * later refinement.
 */
export function wavToPcm(buf: ArrayBuffer, opts?: { gain?: number }): PcmResult {
  const { samples, sampleRate } = wavToInt16(buf, opts)
  return { pcmB64: int16ToB64(samples), sampleRate }
}

/** Like {@link wavToPcm} but returns the raw mono int16 samples (no base64 round-trip) —
 *  used when the caller needs to splice/concatenate PCM before re-encoding. */
export function wavToInt16(buf: ArrayBuffer, opts?: { gain?: number }): { samples: Int16Array; sampleRate: number } {
  const gain = opts?.gain ?? 1
  const view = new DataView(buf)
  if (view.byteLength < 12 || str(view, 0, 4) !== 'RIFF' || str(view, 8, 4) !== 'WAVE') {
    throw new Error('not_a_wav')
  }

  let offset = 12
  let sampleRate = 22050
  let channels = 1
  let bitsPerSample = 16
  let audioFormat = 1
  let dataOffset = -1
  let dataLength = 0

  while (offset + 8 <= view.byteLength) {
    const id = str(view, offset, 4)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      audioFormat = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitsPerSample = view.getUint16(body + 14, true)
    } else if (id === 'data') {
      dataOffset = body
      dataLength = size
    }
    offset = body + size + (size % 2) // chunks are word-aligned
  }

  if (dataOffset < 0) throw new Error('wav_missing_data')

  const bytesPerSample = bitsPerSample / 8
  const frameCount = Math.floor(dataLength / (bytesPerSample * channels))
  const mono = new Int16Array(frameCount)

  for (let f = 0; f < frameCount; f++) {
    let acc = 0
    for (let ch = 0; ch < channels; ch++) {
      const p = dataOffset + (f * channels + ch) * bytesPerSample
      acc += readSampleInt16(view, p, audioFormat, bitsPerSample)
    }
    mono[f] = softClip((acc / channels) * gain)
  }

  return { samples: mono, sampleRate }
}

/** Wrap mono int16 PCM in a minimal 44-byte WAV container (the inverse of {@link wavToInt16}). */
export function pcmToWav(pcm: Int16Array, sampleRate: number): Buffer {
  const dataSize = pcm.byteLength
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)                 // PCM
  header.writeUInt16LE(1, 22)                 // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)    // byteRate = rate * channels * bytesPerSample
  header.writeUInt16LE(2, 32)                 // block align = channels * bytesPerSample
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)])
}

function readSampleInt16(view: DataView, p: number, fmt: number, bits: number): number {
  if (fmt === 3 && bits === 32) return clampInt16(view.getFloat32(p, true) * 32767)
  if (bits === 16) return view.getInt16(p, true)
  if (bits === 32) return clampInt16(view.getInt32(p, true) / 65536)
  if (bits === 8) return clampInt16((view.getUint8(p) - 128) * 256) // 8-bit WAV is unsigned
  throw new Error(`unsupported_wav_bits:${bits}`)
}

function clampInt16(v: number): number {
  const r = Math.round(v)
  return r > 32767 ? 32767 : r < -32768 ? -32768 : r
}

// Soft-knee limiter: below the knee, samples pass through linearly; above it,
// a tanh curve compresses toward the ceiling so emote gain (>1) can't hard-clip
// loud passages into buzzy distortion. In-range samples take the fast path.
const PEAK = 32767
const KNEE = 0.85 * PEAK
function softClip(v: number): number {
  const a = v < 0 ? -v : v
  if (a <= KNEE) return clampInt16(v)
  const over = (a - KNEE) / (PEAK - KNEE)
  const shaped = KNEE + (PEAK - KNEE) * Math.tanh(over)
  return clampInt16(v < 0 ? -shaped : shaped)
}

/** Base64-encode an Int16Array as little-endian bytes. */
export function int16ToB64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
  return Buffer.from(bytes).toString('base64')
}

function str(view: DataView, off: number, len: number): string {
  let s = ''
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i))
  return s
}
