import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { wakeWordCatalog, characters } from '@/db/schema'
import { requireAdmin } from '@/middleware/auth'
import { wakewordDir, downloadWakewordModel, downloadWakewordCore, isWakewordCoreInstalled, isWakewordTrainInstalled } from '@/lib/download'
import { isGloballyOffline, isDownloadBlocked } from '@/lib/connectivity'
import { trainWakeword } from '@/lib/voice/wakewordTrainer'
import { ollamaUrl } from '@/llm/ollama'
import { getModel } from '@/lib/models'
import type { AppEnv } from '@/types'

// Admin-only OpenWakeWord browser: a curated catalog of pretrained detectors that
// download into data/voice/wakewords (served by /api/voice/wakeword). Mirrors the
// LoRA browser pattern (catalog → SSE download-to-disk → DB row).
const adminWakewords = new Hono<AppEnv>()

interface CatalogEntry {
  id: string
  file: string
  label: string
  description: string
  approxBytes: number
}

// Official OpenWakeWord pretrained detectors (v0.5.1 release).
const CATALOG: CatalogEntry[] = [
  { id: 'hey_jarvis', file: 'hey_jarvis_v0.1.onnx', label: 'Hey Jarvis', description: 'Default wake phrase', approxBytes: 2_000_000 },
  { id: 'alexa', file: 'alexa_v0.1.onnx', label: 'Alexa', description: 'Say “Alexa” to wake', approxBytes: 2_000_000 },
  { id: 'hey_mycroft', file: 'hey_mycroft_v0.1.onnx', label: 'Hey Mycroft', description: 'Open-source assistant phrase', approxBytes: 2_000_000 },
  { id: 'hey_rhasspy', file: 'hey_rhasspy_v0.1.onnx', label: 'Hey Rhasspy', description: 'Rhasspy wake phrase', approxBytes: 2_000_000 },
  { id: 'timer', file: 'timer_v0.1.onnx', label: 'Timer', description: '“Set a timer” trigger', approxBytes: 2_000_000 },
  { id: 'weather', file: 'weather_v0.1.onnx', label: 'Weather', description: '“What’s the weather” trigger', approxBytes: 2_000_000 },
]

adminWakewords.get('/catalog', requireAdmin, async (c) => {
  const trainedRows = await db.select().from(wakeWordCatalog).where(eq(wakeWordCatalog.kind, 'trained'))
  return c.json({
    coreInstalled:
      existsSync(join(wakewordDir(), 'melspectrogram.onnx')) &&
      existsSync(join(wakewordDir(), 'embedding_model.onnx')),
    trainInstalled: isWakewordTrainInstalled(),
    entries: CATALOG.map((e) => ({ ...e, installed: existsSync(join(wakewordDir(), e.file)) })),
    trained: trainedRows.map((r) => ({
      id: r.id,
      label: r.label,
      installed: r.assetPath ? existsSync(join(wakewordDir(), r.assetPath)) : false,
    })),
  })
})

// SSE download of a detector → file on disk + wake_word_catalog row.
adminWakewords.post('/import', requireAdmin, async (c) => {
  if (await isDownloadBlocked()) return c.json({ error: 'Offline mode is active — downloads are unavailable.' }, 503)
  const { id } = (await c.req.json()) as { id: string }
  const entry = CATALOG.find((e) => e.id === id)

  return streamSSE(c, async (stream) => {
    const ctrl = new AbortController()
    stream.onAbort(() => ctrl.abort())
    const emit = (event: string, extra?: object) => stream.writeSSE({ event, data: JSON.stringify({ id, ...extra }) })

    if (!entry) {
      await emit('error', { status: 'error', error: `Unknown wakeword: ${id}` })
      return
    }
    // Silently ensure the shared core models (mel + embedding) are present —
    // the detector is useless without them and this is the first place a user
    // might trigger an install even when wakeword-core was skipped in setup.
    if (!isWakewordCoreInstalled()) {
      await emit('start', { status: 'downloading-core', label: 'Downloading OpenWakeWord core…' })
      try {
        await downloadWakewordCore(async (p) => emit('progress', p), ctrl.signal)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') { await emit('cancelled', { status: 'cancelled' }); return }
        await emit('error', { status: 'error', error: `Core download failed: ${String(err)}` }); return
      }
    }
    await emit('start', { status: 'downloading', fileName: entry.file })
    try {
      await downloadWakewordModel(entry.file, async (p) => emit('progress', p), ctrl.signal)
      const now = new Date()
      await db
        .insert(wakeWordCatalog)
        .values({ id: entry.id, label: entry.label, kind: 'pretrained', assetPath: entry.file, defaultThreshold: 0.5, characterId: null, enabled: true, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: wakeWordCatalog.id, set: { label: entry.label, assetPath: entry.file, updatedAt: now } })
      await emit('complete', { status: 'complete' })
      await stream.writeSSE({ event: 'done', data: '{}' })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        await emit('cancelled', { status: 'cancelled' })
        return
      }
      await emit('error', { status: 'error', error: String(err) })
    }
  })
})

// LLM-powered phonetic suggestion — returns 3 plain-English pronunciation
// variants for a wake phrase so the user can pick what sounds right before
// committing to a training run. Falls back gracefully if Ollama is offline.
adminWakewords.post('/phonetics', requireAdmin, async (c) => {
  const { phrase } = (await c.req.json()) as { phrase: string }
  if (!phrase?.trim()) return c.json({ error: 'phrase required' }, 400)

  try {
    const model = await getModel()
    const res = await fetch(`${ollamaUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: `You generate phonetic pronunciations for voice assistant wake phrases.
Respond ONLY with valid JSON matching: {"options":["phonetic1","phonetic2","phonetic3"]}
Rules:
- Plain English only, no IPA
- CAPITALIZE the stressed syllable in each word
- Hyphens between syllables (e.g. "hey LOH-kee", "hey LOW-ky", "hey lah-KEE")
- Give exactly 3 variations covering plausible pronunciations
- Preserve the exact same number of words as the input phrase`,
          },
          { role: 'user', content: phrase.trim() },
        ],
        format: 'json',
        stream: false,
        keep_alive: -1,
        options: { temperature: 0.4, num_predict: 120 },
        think: false,
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error('ollama unavailable')
    const data = (await res.json()) as { message?: { content?: string } }
    const parsed = JSON.parse(data.message?.content ?? '{}') as { options?: unknown[] }
    const options = (parsed.options ?? []).filter((o): o is string => typeof o === 'string').slice(0, 3)
    if (options.length < 1) throw new Error('empty')
    return c.json({ options })
  } catch {
    // LLM offline or parse failure — caller handles gracefully
    return c.json({ options: [] }, 503)
  }
})

// SSE training endpoint — synthesizes samples via Kokoro, trains a logistic
// regression on openWakeWord embeddings, exports ONNX, inserts catalog row.
adminWakewords.post('/train', requireAdmin, async (c) => {
  const { phrase, label, characterId, trainingVoice } = (await c.req.json()) as { phrase: string; label?: string; characterId?: string; trainingVoice?: string }
  if (!phrase?.trim()) return c.json({ error: 'phrase required' }, 400)

  const displayLabel = (label ?? phrase).trim()
  const slug = displayLabel.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const id   = `trained_${slug}_${Date.now().toString(36)}`

  return streamSSE(c, async (stream) => {
    const ctrl = new AbortController()
    stream.onAbort(() => ctrl.abort())
    const emit = (event: string, extra?: object) =>
      stream.writeSSE({ event, data: JSON.stringify({ id, ...extra }) })

    try {
      await emit('start', { status: 'generating', phrase })
      const { threshold } = await trainWakeword(
        phrase.trim(),
        id,
        (p) => {
          void emit('progress', { status: p.step, msg: p.msg, pct: p.pct })
        },
        ctrl.signal,
        // No default voice: an absent/'auto' value trains across the full
        // diverse voice set (speaker-independent). Forcing a single voice here
        // overfit the detector to one TTS timbre, so it barely fired on a real
        // human voice — the cause of "recognition is barely there".
        trainingVoice ?? null,
      )

      const file = `${id}.onnx`
      const now  = new Date()
      await db
        .insert(wakeWordCatalog)
        .values({
          id,
          label:            displayLabel,
          kind:             'trained',
          assetPath:        file,
          // Use the calibrated threshold from training; tunable later in the
          // tester. The old hardcoded 0.5 was the main cause of false fires.
          defaultThreshold: threshold ?? 0.6,
          characterId:      characterId ?? null,
          enabled:          true,
          createdAt:        now,
          updatedAt:        now,
        })
        .onConflictDoUpdate({
          target: wakeWordCatalog.id,
          set:    { label: displayLabel, assetPath: file, updatedAt: now },
        })

      // Attach the model to the character directly so it takes effect without a
      // separate form Save. A trained model is inert until a character points at
      // it; otherwise the companion silently falls back to hey_jarvis. Clear any
      // phrase to keep the single-wakeword-source invariant.
      if (characterId) {
        await db.update(characters)
          .set({ wakeWordModelId: id, wakeWordPhrase: null, updatedAt: now })
          .where(eq(characters.id, characterId))
      }

      await emit('complete', { status: 'complete', modelId: id })
      await stream.writeSSE({ event: 'done', data: '{}' })
    } catch (err) {
      if (ctrl.signal.aborted) {
        await emit('cancelled', { status: 'cancelled' })
        return
      }
      await emit('error', { status: 'error', error: String(err) })
    }
  })
})

// Persist a detector's sensitivity. The live hands-free loop reads this
// per-model defaultThreshold (via /api/voice/wakewords → wake-word registry),
// so the value tuned in the tester is exactly what fires in production.
adminWakewords.patch('/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const body = (await c.req.json()) as { defaultThreshold?: number }
  const t = body.defaultThreshold
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 1) {
    return c.json({ error: 'defaultThreshold must be a number between 0 and 1' }, 400)
  }
  const [row] = await db.select().from(wakeWordCatalog).where(eq(wakeWordCatalog.id, id)).limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  await db.update(wakeWordCatalog).set({ defaultThreshold: t, updatedAt: new Date() }).where(eq(wakeWordCatalog.id, id))
  return c.json({ ok: true, id, defaultThreshold: t })
})

adminWakewords.delete('/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const entry = CATALOG.find((e) => e.id === id)
  const [row] = await db.select().from(wakeWordCatalog).where(eq(wakeWordCatalog.id, id)).limit(1)
  const file = entry?.file ?? row?.assetPath
  if (file) {
    try { await unlink(join(wakewordDir(), file)) } catch { /* already gone */ }
  }
  await db.delete(wakeWordCatalog).where(eq(wakeWordCatalog.id, id))
  return c.json({ ok: true })
})

export { adminWakewords }
