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
// Node uses onnxruntime-node, whose device is 'cpu'. Overridable via VOICE_DEVICE.
const DEVICE = (process.env.VOICE_DEVICE ?? 'cpu') as 'cpu' | 'wasm'
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
    kokoroPromise = KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: TTS_DTYPE, device: DEVICE })
      .catch(err => { kokoroPromise = null; throw err })
  }
  return kokoroPromise
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let whisperPromise: Promise<any> | null = null
function getWhisper(): Promise<unknown> {
  if (!whisperPromise) {
    whisperPromise = pipeline('automatic-speech-recognition', WHISPER_MODEL, { dtype: 'q8', device: DEVICE })
      .catch((err: unknown) => { whisperPromise = null; throw err })
  }
  return whisperPromise
}

// Decode our own 16 kHz mono int16 WAV (from sttSession.encodeWav) → Float32.
function decodeWav(buf: ArrayBuffer): { audio: Float32Array; sampleRate: number } {
  const view = new DataView(buf)
  let offset = 12
  let sampleRate = 16000
  let dataOffset = -1
  let dataLen = 0
  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ') sampleRate = view.getUint32(offset + 8 + 4, true)
    else if (id === 'data') { dataOffset = offset + 8; dataLen = size }
    offset += 8 + size + (size % 2)
  }
  if (dataOffset < 0) return { audio: new Float32Array(0), sampleRate }
  const n = Math.floor(dataLen / 2)
  const audio = new Float32Array(n)
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
    if (url === '/health') return json(res, 200, { ok: true, kokoro: kokoroPromise !== null, whisper: whisperPromise !== null })

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

    if (url === '/inference' && req.method === 'POST') {
      const body = await readBody(req)
      const { audio } = decodeWav(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength))
      if (audio.length === 0) return json(res, 200, { text: '' })
      const transcriber = await getWhisper()
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
  process.stdout.write(`[voice-server] listening on http://localhost:${PORT}\n`)
  // Warm models in the background at startup so the first user reply isn't a
  // cold start (model load + graph compile would otherwise add 1–2s).
  void warm(true).catch((e) => process.stdout.write(`[voice-server] warmup failed: ${e}\n`))
})
