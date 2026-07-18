// Voice-server sidecar — Kokoro TTS + Whisper STT, fully local via onnxruntime.
// Models auto-download from HuggingFace into the data/ cache on first load.
//
// IMPORTANT: this runs under **Node** (not Bun) — onnxruntime-node's native addon
// segfaults under Bun. It uses node:http (no Bun APIs) so it's runtime-agnostic.
// Spawned by `lib/voiceServer.ts`. Run with `warm` arg to download models + exit.
//
//   GET  /health      → { ok, kokoro, whisper }
//   GET  /voices      → { voices: [{ id, name, language, gender }] }
//   POST /synthesize  { text, voice, speed } → audio/wav   (Kokoro)
//   POST /inference   (raw WAV body) → { text }            (Whisper)

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { env, pipeline } from '@huggingface/transformers'
import { KokoroTTS } from 'kokoro-js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = parseInt(process.env.VOICE_SERVER_PORT ?? '8092')
const KOKORO_MODEL = process.env.KOKORO_MODEL ?? 'onnx-community/Kokoro-82M-v1.0-ONNX'
// base.en is the accuracy/speed sweet spot. tiny.en is faster but mis-transcribes
// real commands badly ("who is" → "was", drops leading words like "no"), which made
// both the wake phrase and the captured command unreliable. base.en (q8) is still
// near-real-time for these short utterances. Override with WHISPER_MODEL (e.g.
// onnx-community/whisper-small.en for even better accuracy, or whisper-tiny.en for speed).
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? 'onnx-community/whisper-base.en'
// Smart, multi-platform device selection. onnxruntime-node bundles the CUDA
// execution provider ONLY on Linux x64 (Windows ort-node is CPU/DirectML-only and
// macOS has no CUDA), so we offer 'cuda' exactly where the runtime can actually use
// it, and run 'cpu' everywhere else. CPU is also the right default on a shared box:
// the GPU stays free for the LLM (the 8GB prod card is LLM-first). VOICE_DEVICE
// overrides the auto-pick. If a GPU load fails at runtime (CUDA runtime missing,
// OOM), loadWithFallback() demotes to CPU so the sidecar never hard-crashes.
// Native GPU paths for Windows (whisper.cpp CUDA / DirectML) and Mac (Metal/CoreML)
// need separate sidecar binaries and are tracked as prod-gated work in
// docs/internal/voice-latency.md.
type VoiceDevice = 'cpu' | 'cuda' | 'wasm'

function hasNvidiaGpu(): boolean {
  try {
    execFileSync('nvidia-smi', ['-L'], { stdio: 'ignore', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

function detectDevice(): VoiceDevice {
  const explicit = process.env.VOICE_DEVICE as VoiceDevice | undefined
  if (explicit) return explicit
  if (process.platform === 'linux' && process.arch === 'x64' && hasNvidiaGpu()) return 'cuda'
  return 'cpu'
}

// `let`, not `const`: a failed non-CPU init demotes this to 'cpu' for the process.
let DEVICE: VoiceDevice = detectDevice()

// Load a model on the selected device, and on failure of a non-CPU device retry
// once on CPU and demote the process default so later loads skip the dead GPU path.
async function loadWithFallback<T>(label: string, load: (device: VoiceDevice) => Promise<T>): Promise<T> {
  try {
    return await load(DEVICE)
  } catch (err) {
    if (DEVICE !== 'cpu') {
      console.warn(`[voice-server] ${label} failed on device=${DEVICE} (${(err as Error).message}); falling back to cpu`)
      DEVICE = 'cpu'
      return await load('cpu')
    }
    throw err
  }
}
// q4 ≈ 2× faster than q8 on CPU (~0.45s vs ~0.8s/sentence) with a small quality
// cost — the right default for snappy replies. Set KOKORO_DTYPE=q8 for max quality.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TTS_DTYPE = (process.env.KOKORO_DTYPE ?? 'q4') as any

env.cacheDir = process.env.VOICE_CACHE_DIR ?? resolve(__dirname, '../../data/voice/models')
env.allowRemoteModels = true

let kokoroPromise: Promise<KokoroTTS> | null = null
function getKokoro(): Promise<KokoroTTS> {
  // Don't cache a REJECTED load (e.g. the model was still downloading at startup) —
  // otherwise every later request returns the same failure until the process restarts.
  if (!kokoroPromise) {
    kokoroPromise = loadWithFallback('kokoro', (device) => KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: TTS_DTYPE, device }))
      .catch(err => { kokoroPromise = null; throw err })
  }
  return kokoroPromise
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let whisperPromise: Promise<any> | null = null
function getWhisper(): Promise<unknown> {
  if (!whisperPromise) {
    whisperPromise = loadWithFallback('whisper', (device) => pipeline('automatic-speech-recognition', WHISPER_MODEL, { dtype: 'q8', device }))
      .catch((err: unknown) => { whisperPromise = null; throw err })
  }
  return whisperPromise
}

// Decode 16 kHz mono int16 WAV → Float32. Handles both our own encodeWav output and
// ffmpeg's: ffmpeg streaming to a non-seekable pipe (podcast transcription's
// `-f wav pipe:1`) cannot backfill the RIFF / data-chunk sizes, so it writes a
// placeholder (0xFFFFFFFF, 0, or a value past the real end). Trusting that size walked
// the reader ~2 billion samples off the end of the buffer (RangeError: Offset is
// outside the bounds of the DataView). We clamp every size to the bytes we actually got.
function decodeWav(buf: ArrayBuffer): { audio: Float32Array; sampleRate: number } {
  const view = new DataView(buf)
  let offset = 12
  let sampleRate = 16000
  let dataOffset = -1
  let dataLen = 0
  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))
    const size = view.getUint32(offset + 4, true)
    const avail = view.byteLength - (offset + 8)
    if (id === 'fmt ') sampleRate = view.getUint32(offset + 8 + 4, true)
    else if (id === 'data') {
      dataOffset = offset + 8
      // Never trust a data size that is zero or overruns the buffer (streaming pipe).
      dataLen = size === 0 || size > avail ? avail : size
      break  // data is what we need; a bogus size would only walk us off the end
    }
    // A non-data chunk whose size overruns the buffer is corrupt/streaming: stop safely.
    if (size > avail) break
    offset += 8 + size + (size % 2)
  }
  if (dataOffset < 0) return { audio: new Float32Array(0), sampleRate }
  // Final guard: clamp the sample count to the int16s actually present.
  const n = Math.min(Math.floor(dataLen / 2), Math.floor((view.byteLength - dataOffset) / 2))
  const audio = new Float32Array(Math.max(0, n))
  for (let i = 0; i < n; i++) audio[i] = view.getInt16(dataOffset + i * 2, true) / 32768
  return { audio, sampleRate }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => res(Buffer.concat(chunks)))
    req.on('error', rej)
  })
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(s)
}

async function warm(runSynth = false): Promise<void> {
  process.stdout.write('[voice-server] warming Kokoro…\n')
  const tts = await getKokoro()
  if (runSynth) {
    // A throwaway synth JITs the inference graph so the FIRST real request pays
    // only synth time, not graph compilation.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { await tts.generate('Hello.', { voice: 'af_heart' as any }) } catch { /* ignore */ }
  }
  process.stdout.write('[voice-server] warming Whisper…\n')
  await getWhisper()
  process.stdout.write('[voice-server] models ready\n')
}

if (process.argv.includes('warm')) {
  await warm()
  process.exit(0)
}

const server = createServer(async (req, res) => {
  try {
    const url = req.url ?? '/'
    if (url === '/health') return json(res, 200, { ok: true, kokoro: kokoroPromise !== null, whisper: whisperPromise !== null, device: DEVICE, platform: process.platform, arch: process.arch })

    if (url === '/voices') {
      const tts = await getKokoro()
      const voices = Object.entries(tts.voices as Record<string, { name?: string; language?: string; gender?: string }>).map(
        ([id, v]) => ({ id, name: v.name ?? id, language: v.language ?? '', gender: v.gender ?? '' }),
      )
      return json(res, 200, { voices })
    }

    if (url === '/synthesize' && req.method === 'POST') {
      const { text, voice, speed } = JSON.parse((await readBody(req)).toString('utf8')) as { text: string; voice?: string; speed?: number }
      const tts = await getKokoro()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const audio = await tts.generate(text, { voice: (voice ?? 'af_heart') as any, speed: speed ?? 1.0 })
      const wav = Buffer.from(await audio.toBlob().arrayBuffer())
      res.writeHead(200, { 'Content-Type': 'audio/wav' })
      return res.end(wav)
    }

    if ((url === '/inference' || url.startsWith('/inference?')) && req.method === 'POST') {
      // ?timestamps=1 → long-form mode: transformers.js chunks past Whisper's 30s
      // receptive window (30s chunks, 5s stride) and returns per-chunk timestamps.
      // Used by podcast transcription; the live-mic path keeps the plain fast call.
      const wantTimestamps = url.includes('timestamps=1')
      const body = await readBody(req)
      const { audio } = decodeWav(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength))
      if (audio.length === 0) return json(res, 200, wantTimestamps ? { text: '', segments: [] } : { text: '' })
      const transcriber = await getWhisper()
      if (wantTimestamps) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const out = (await (transcriber as any)(audio, { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 })) as {
          text?: string
          chunks?: Array<{ timestamp?: [number, number | null]; text?: string }>
        }
        const durationSec = audio.length / 16000
        const segments = (out.chunks ?? [])
          .map((ch) => {
            const start = Number(ch.timestamp?.[0] ?? 0)
            const rawEnd = ch.timestamp?.[1]
            // The final chunk's end timestamp can be null, so close it at the audio end.
            const end = rawEnd == null || !Number.isFinite(Number(rawEnd)) ? durationSec : Number(rawEnd)
            return { start, end: Math.max(end, start), text: String(ch.text ?? '').trim() }
          })
          .filter((s) => s.text && Number.isFinite(s.start))
        return json(res, 200, { text: (out.text ?? '').trim(), segments })
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = (await (transcriber as any)(audio)) as { text?: string }
      return json(res, 200, { text: (out.text ?? '').trim() })
    }

    res.writeHead(404); res.end('not found')
  } catch (err) {
    json(res, 500, { error: String(err) })
  }
})

server.listen(PORT, () => {
  process.stdout.write(`[voice-server] listening on http://localhost:${PORT} (device=${DEVICE} platform=${process.platform}/${process.arch})\n`)
  // Warm models in the background at startup so the first user reply isn't a
  // cold start (model load + graph compile would otherwise add 1–2s).
  void warm(true).catch((e) => process.stdout.write(`[voice-server] warmup failed: ${e}\n`))
})
