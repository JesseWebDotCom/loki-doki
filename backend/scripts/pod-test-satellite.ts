// $0 software satellite — validates the Pod gateway end-to-end with no hardware.
//
// Connects to the Wyoming gateway, streams a WAV utterance, prints the
// transcript + face.state events, and writes the companion's spoken reply to
// reply.wav.
//
//   bun run scripts/pod-test-satellite.ts <path-to-utterance.wav> [host] [port]
//
// The WAV should be mono PCM (any sample rate; 16 kHz mono is ideal for whisper).
// Stereo/8-bit/float WAVs are normalized to mono int16 by wavToPcm.

import { wavToPcm } from '@/lib/voice/pcm'
import { encodeWav } from '@/lib/voice/sttSession'
import { WyomingDecoder, encodeEvent, audioStart, audioChunk, audioStop } from '@/lib/pod/wyoming'

const wavPath = process.argv[2]
const host = process.argv[3] ?? '127.0.0.1'
const port = parseInt(process.argv[4] ?? process.env.POD_GATEWAY_PORT ?? '10700')

if (!wavPath) {
  console.error('usage: bun run scripts/pod-test-satellite.ts <utterance.wav> [host] [port]')
  process.exit(1)
}

const { pcmB64, sampleRate } = wavToPcm(await Bun.file(wavPath).arrayBuffer())
const utterance = Uint8Array.from(Buffer.from(pcmB64, 'base64'))

const decoder = new WyomingDecoder()
let replyPcm = new Uint8Array(0)
let replyRate = 0

const socket = await Bun.connect({
  hostname: host,
  port,
  socket: {
    open(sock) {
      console.log(`[test] connected to tcp://${host}:${port}; streaming ${utterance.length} bytes @ ${sampleRate}Hz`)
      sock.write(encodeEvent(audioStart(sampleRate)))
      // Stream in ~50ms chunks to mimic a real mic.
      const bytesPerChunk = Math.floor(sampleRate * 0.05) * 2
      for (let i = 0; i < utterance.length; i += bytesPerChunk) {
        sock.write(encodeEvent(audioChunk(utterance.subarray(i, i + bytesPerChunk), sampleRate)))
      }
      sock.write(encodeEvent(audioStop()))
      console.log('[test] utterance sent; awaiting reply…')
    },
    data(_sock, data) {
      for (const ev of decoder.push(new Uint8Array(data))) {
        if (ev.type === 'transcript') {
          console.log(`[test] 📝 transcript: ${ev.data?.text}`)
        } else if (ev.type === 'user-event' && ev.data?.name === 'face.state') {
          console.log(`[test] 🙂 face.state: ${ev.data?.state}`)
        } else if (ev.type === 'audio-start') {
          replyRate = (ev.data?.rate as number) ?? 22050
          replyPcm = new Uint8Array(0)
        } else if (ev.type === 'audio-chunk' && ev.payload) {
          const merged = new Uint8Array(replyPcm.length + ev.payload.length)
          merged.set(replyPcm, 0)
          merged.set(ev.payload, replyPcm.length)
          replyPcm = merged
        } else if (ev.type === 'audio-stop') {
          const f32 = int16ToFloat32(replyPcm)
          Bun.write('reply.wav', encodeWav(f32, replyRate))
          console.log(`[test] 🔊 wrote reply.wav (${replyPcm.length} bytes @ ${replyRate}Hz). Done.`)
          process.exit(0)
        } else {
          console.log(`[test] ← ${ev.type}`, ev.data ?? '')
        }
      }
    },
    close() {
      console.log('[test] connection closed')
    },
    error(_sock, err) {
      console.error('[test] socket error:', err)
      process.exit(1)
    },
  },
})

// Safety timeout so the script never hangs forever in CI/manual runs.
setTimeout(() => {
  console.error('[test] timed out waiting for reply (is Ollama + the voice sidecar running?)')
  socket.end()
  process.exit(1)
}, 60_000)

function int16ToFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const n = Math.floor(bytes.byteLength / 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768
  return out
}
