// Persistent embedding-feature server for wake-word training.
//
// THE WHOLE POINT: the browser runs the wake-word pipeline through
// onnxruntime-web (WASM), whose Conv kernels compute the openWakeWord embedding
// model measurably differently (~25 per dim) from native onnxruntime. A detector
// trained on native-onnxruntime embeddings is therefore fed out-of-distribution
// features at runtime and never fires. To fix it, training MUST extract its
// embeddings with the SAME runtime the browser uses — this script — so train and
// inference features are bit-for-bit the same. (The mel model matches across
// runtimes; only the embedding CNN diverges, but we run the full mel→embedding
// front-end here for exact parity with wake-word-loop.ts.)
//
// Protocol (binary, over stdin/stdout):
//   request : uint32LE numSamples, then numSamples × float32LE  (16 kHz mono PCM)
//             numSamples === 0xFFFFFFFF  → shut down
//   response: uint32LE N (embedding count), then N × 96 × float32LE
// One embedding is emitted per 1280-sample (80 ms) chunk, exactly as the runtime
// does, so N === floor(numSamples / 1280) and the caller's per-chunk RMS aligns.
//
// stdout carries ONLY framed binary; all logging is redirected to stderr so the
// protocol can't be corrupted by onnxruntime banner output.

import * as ort from 'onnxruntime-web'
import { readFileSync } from 'node:fs'

// Keep stdout pure binary — route any stray logging to stderr.
console.log = (...a) => process.stderr.write(a.join(' ') + '\n')
console.info = console.log
console.warn = console.log
ort.env.wasm.numThreads = 1
ort.env.logLevel = 'fatal'

const FRAME = 1280, MEL_DIM = 32, MEL_BUF = 76, EMB_DIM = 96
const RAW_BUF = 35200 // must equal BUF in train_wakeword.py / RAW_AUDIO_BUFFER_SAMPLES

const melPath = process.argv[2]
const embPath = process.argv[3]
if (!melPath || !embPath) { process.stderr.write('usage: wake_embed_ortweb.mjs <mel.onnx> <embedding.onnx>\n'); process.exit(2) }

const mel = await ort.InferenceSession.create(new Uint8Array(readFileSync(melPath)), { executionProviders: ['wasm'] })
const emb = await ort.InferenceSession.create(new Uint8Array(readFileSync(embPath)), { executionProviders: ['wasm'] })
const melIn = mel.inputNames[0], embIn = emb.inputNames[0]
const melOutName = mel.outputNames[0], embOutName = emb.outputNames[0]

function appendRaw(b, s) { const n = s.length; if (n >= b.length) { b.set(s.subarray(n - b.length)); return } b.copyWithin(0, n); b.set(s, b.length - n) }

async function embedAudio(audio) {
  const raw = new Float32Array(RAW_BUF)
  let filled = 0
  const out = []
  for (let end = FRAME; end <= audio.length; end += FRAME) {
    const frame = audio.subarray(end - FRAME, end)
    appendRaw(raw, frame)
    filled = Math.min(RAW_BUF, filled + frame.length)
    const valid = raw.subarray(RAW_BUF - filled)
    const scaled = new Float32Array(valid.length)
    for (let i = 0; i < valid.length; i++) scaled[i] = valid[i] * 32767
    const mo = await mel.run({ [melIn]: new ort.Tensor('float32', scaled, [1, valid.length]) })
    const melRaw = mo[melOutName].data
    const totalFrames = Math.floor(melRaw.length / MEL_DIM)
    const win = new Float32Array(MEL_BUF * MEL_DIM).fill(1)
    const take = Math.min(MEL_BUF, totalFrames)
    const srcStart = (totalFrames - take) * MEL_DIM
    const dstStart = (MEL_BUF - take) * MEL_DIM
    for (let i = 0; i < take * MEL_DIM; i++) win[dstStart + i] = melRaw[srcStart + i] / 10 + 2
    const eo = await emb.run({ [embIn]: new ort.Tensor('float32', win, [1, MEL_BUF, MEL_DIM, 1]) })
    out.push(eo[embOutName].data.slice(0, EMB_DIM))
  }
  return out
}

// ---- stdin framing -------------------------------------------------------
let buf = Buffer.alloc(0)
let want = -1 // bytes expected for the current request body (after the 4-byte header)
const queue = []
let processing = false

process.stdout.write(Buffer.from([0x4f, 0x4b, 0x0a])) // "OK\n" ready signal (3 bytes, fixed)

process.stdin.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); drain() })
process.stdin.on('end', () => process.exit(0))

function drain() {
  while (true) {
    if (want < 0) {
      if (buf.length < 4) return
      const n = buf.readUInt32LE(0)
      if (n === 0xffffffff) process.exit(0)
      want = n * 4
      buf = buf.subarray(4)
    }
    if (buf.length < want) return
    const body = buf.subarray(0, want)
    buf = buf.subarray(want)
    const samples = new Float32Array(body.buffer, body.byteOffset, body.length / 4).slice()
    want = -1
    queue.push(samples)
    void pump()
  }
}

async function pump() {
  if (processing) return
  processing = true
  while (queue.length) {
    const audio = queue.shift()
    let embs
    try { embs = await embedAudio(audio) } catch (e) { process.stderr.write('embed error: ' + e + '\n'); embs = [] }
    const header = Buffer.alloc(4); header.writeUInt32LE(embs.length, 0)
    const flat = Buffer.alloc(embs.length * EMB_DIM * 4)
    let off = 0
    for (const e of embs) { for (let i = 0; i < EMB_DIM; i++) { flat.writeFloatLE(e[i], off); off += 4 } }
    process.stdout.write(header); process.stdout.write(flat)
  }
  processing = false
}
