import { Hono } from 'hono'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { db } from '@/db'
import { wakeWordCatalog } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { wakewordDir } from '@/lib/download'
import { encodeWav } from '@/lib/voice/sttSession'
import { transcribeWav } from '@/lib/whisper'
import type { AppEnv } from '@/types'

// User-facing voice assets. The wakeword ONNX models are downloaded at runtime
// (into data/voice/wakewords), so they're served here rather than from the
// frontend's build-time public/ dir.
const voice = new Hono<AppEnv>()

// One-shot transcription of a raw f32le 16 kHz mono PCM clip. Used by the
// wakeword tester to show what was actually heard around each detection.
voice.post('/transcribe', requireAuth, async (c) => {
  const buf = await c.req.arrayBuffer()
  const pcm = new Float32Array(buf)
  if (pcm.length === 0) return c.json({ text: '' })
  // transcribeWav now throws when whisper is unreachable (to distinguish "down"
  // from "silence"); this diagnostic route doesn't need that distinction, so
  // degrade to an empty transcript instead of a 500.
  try {
    const text = await transcribeWav(encodeWav(pcm, 16_000))
    return c.json({ text })
  } catch {
    return c.json({ text: '' })
  }
})

// Serve a wakeword model file (mel/embedding/detector ONNX).
voice.get('/wakeword/:file', requireAuth, async (c) => {
  const file = basename(c.req.param('file')) // prevent path traversal
  if (!file.endsWith('.onnx')) return c.json({ error: 'not found' }, 404)
  const path = join(wakewordDir(), file)
  if (!existsSync(path)) return c.json({ error: 'not found' }, 404)
  c.header('Content-Type', 'application/octet-stream')
  c.header('Cache-Control', 'public, max-age=86400')
  return c.body(await readFile(path))
})

// List installed detectors (shared mel/embedding excluded) so the frontend
// wakeword registry can offer them. Merges catalog metadata (label/threshold)
// with the actual files present on disk.
voice.get('/wakewords', requireAuth, async (c) => {
  let files: string[] = []
  try {
    files = (await readdir(wakewordDir())).filter((f) => f.endsWith('.onnx'))
  } catch { /* dir missing → nothing installed */ }
  const detectors = files.filter((f) => f !== 'melspectrogram.onnx' && f !== 'embedding_model.onnx')
  const rows = await db.select().from(wakeWordCatalog)
  const meta = new Map(rows.map((r) => [r.assetPath ?? '', r]))

  const coreInstalled = files.includes('melspectrogram.onnx') && files.includes('embedding_model.onnx')
  return c.json({
    coreInstalled,
    detectors: detectors.map((f) => {
      const id = f.replace(/_v[\d.]+\.onnx$/, '').replace(/\.onnx$/, '')
      const m = meta.get(f)
      return {
        id,
        file: f,
        label: m?.label ?? id.replace(/_/g, ' '),
        defaultThreshold: m?.defaultThreshold ?? 0.5,
        assetUrl: `/api/voice/wakeword/${f}`,
      }
    }),
  })
})

export { voice }
