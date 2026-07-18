import { Hono } from 'hono'
import { eq, asc, count, isNull } from 'drizzle-orm'
import { requireAdmin } from '@/middleware/auth'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { voiceConfig, parseVoiceId } from '@/lib/voice'
import { kokoroEngine, listKokoroVoices } from '@/lib/voice/engines/kokoroEngine'
import { whisperHealth } from '@/lib/whisper'
import { voiceServerLocalUrl, restartVoiceServer, getVoiceServerState } from '@/lib/voiceServer'
import { queryGpus } from '@/lib/gpuMonitor'
import { db } from '@/db'
import { pronunciations, pronunciationPacks } from '@/db/schema'
import { invalidatePronunciations, reconcileBuiltinPronunciationPacks } from '@/lib/voice/pronunciation'
import type { AppEnv } from '@/types'

const adminVoice = new Hono<AppEnv>()

// Bundled Kokoro voices (for the per-character + app-default voice pickers).
adminVoice.get('/voices', requireAdmin, async (c) => {
  return c.json({ voices: await listKokoroVoices() })
})

// ── App-level voice defaults + sidecar status ────────────────────────────────
const SETTING_KEYS = [
  'voice.app_default_voice',
  'voice.app_default_wakeword',
  'voice.server_url',
  'voice.tts_url',
  'voice.whisper_url',
  // Compute backend for the sidecar: 'auto' | 'cpu' | 'cuda' | 'dml'. Applied on the
  // next sidecar (re)start — see POST /device/restart.
  'voice.device',
  // Trailing-silence endpoint timeout in ms (STT finalization). See lib/voice/config.
  'voice.endpoint_silence_ms',
  // Speak a short "one sec" on tool turns (default off — the filler delays the answer).
  'voice.tool_ack_enabled',
  // Prefill the LLM prompt on wake (default off — can queue ahead of a quick turn).
  'voice.wake_prime_enabled',
] as const

adminVoice.get('/settings', requireAdmin, async (c) => {
  const entries = await Promise.all(SETTING_KEYS.map(async (k) => [k, await getAppSetting(k)] as const))
  const [kokoro, whisper] = await Promise.all([kokoroEngine.health(), whisperHealth()])
  return c.json({
    settings: Object.fromEntries(entries),
    resolved: {
      appDefaultVoice: await voiceConfig.appDefaultVoice(),
      appDefaultWakeword: await voiceConfig.appDefaultWakeword(),
    },
    health: { kokoro, whisper },
  })
})

adminVoice.put('/settings', requireAdmin, async (c) => {
  const body = (await c.req.json()) as Record<string, unknown>
  for (const key of SETTING_KEYS) {
    if (key in body) await setAppSetting(key, body[key])
  }
  return c.json({ ok: true })
})

// ── Compute backend (device) selection, status, and benchmark ────────────────
// Powers the admin Voice > Engine panel: what backend is configured vs actually
// running, what the hardware can do, a restart-to-apply, and a round-trip timing
// test so the operator can validate a GPU choice on their own machine.

interface SidecarHealth { device?: string; platform?: string; arch?: string }
async function sidecarHealth(): Promise<SidecarHealth | null> {
  try {
    const r = await fetch(`${voiceServerLocalUrl()}/health`, { signal: AbortSignal.timeout(3_000) })
    return r.ok ? ((await r.json()) as SidecarHealth) : null
  } catch { return null }
}

// What the runtime can ACTUALLY use per platform (mirrors the sidecar's own rule):
// onnxruntime-node ships CUDA only on Linux x64; DirectML only on Windows; CPU
// everywhere. 'dml' stays opt-in (Kokoro may need an opset re-export) so it's
// offered on Windows but not auto-recommended.
function deviceCapability(hasNvidia: boolean) {
  const plat = process.platform
  const cudaOk = plat === 'linux' && process.arch === 'x64' && hasNvidia
  const dmlOk = plat === 'win32'
  const options: Array<'auto' | 'cpu' | 'cuda' | 'dml'> = ['auto', 'cpu']
  if (cudaOk) options.push('cuda')
  if (dmlOk) options.push('dml')
  const recommended = cudaOk ? 'cuda' : 'cpu' // CPU-first: dml is validate-first, not a default
  return { options, recommended, cudaOk, dmlOk }
}

adminVoice.get('/device', requireAdmin, async (c) => {
  const configured = ((await getAppSetting('voice.device')) as string) || 'auto'
  const [health, gpus] = await Promise.all([sidecarHealth(), queryGpus()])
  const hasNvidia = Array.isArray(gpus) && gpus.length > 0
  return c.json({
    configured,
    running: health?.device ?? null,
    platform: health ? `${health.platform}/${health.arch}` : `${process.platform}/${process.arch}`,
    state: getVoiceServerState(),
    hasNvidia,
    gpus: (gpus ?? []).map((g) => g.name),
    ...deviceCapability(hasNvidia),
  })
})

adminVoice.post('/device/restart', requireAdmin, async (c) => {
  const state = await restartVoiceServer()
  const health = await sidecarHealth()
  return c.json({ ok: state === 'ready', state, device: health?.device ?? null })
})

// Round-trip timing test on the CURRENTLY-RUNNING sidecar: synthesize a fixed
// sentence (TTS) then transcribe that audio back (STT), reporting each leg's wall
// time and the device that ran them. Flip the device, restart, re-run to compare.
adminVoice.post('/benchmark', requireAdmin, async (c) => {
  const base = voiceServerLocalUrl()
  const text = 'The quick brown fox jumps over the lazy dog.'
  const health = await sidecarHealth()
  if (!health) return c.json({ error: 'voice_server_unavailable' }, 503)

  const appDefault = await voiceConfig.appDefaultVoice()
  let voiceId = 'af_heart'
  try { voiceId = parseVoiceId(appDefault).voiceId } catch { /* keep fallback */ }

  // TTS leg.
  const t0 = performance.now()
  let wav: ArrayBuffer
  try {
    const r = await fetch(`${base}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: voiceId, speed: 1 }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!r.ok) return c.json({ error: `tts_failed_${r.status}`, device: health.device }, 502)
    wav = await r.arrayBuffer()
  } catch (e) {
    return c.json({ error: `tts_error:${(e as Error).message}`, device: health.device }, 502)
  }
  const ttsMs = Math.round(performance.now() - t0)

  // STT leg — transcribe the audio we just synthesized.
  const t1 = performance.now()
  let heard = ''
  try {
    const r = await fetch(`${base}/inference`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav,
      signal: AbortSignal.timeout(30_000),
    })
    if (r.ok) heard = ((await r.json()) as { text?: string }).text ?? ''
  } catch { /* report the TTS leg regardless */ }
  const sttMs = Math.round(performance.now() - t1)

  return c.json({
    device: health.device ?? 'unknown',
    platform: `${health.platform}/${health.arch}`,
    ttsMs,
    sttMs,
    audioBytes: wav.byteLength,
    heard: heard.trim(),
  })
})

// ── Pronunciation packs ───────────────────────────────────────────────────────

function packItemRow(r: { id: string; term: string; replacement: string }) {
  return { id: r.id, term: r.term, replacement: r.replacement }
}

adminVoice.get('/pronunciation-packs', requireAdmin, async (c) => {
  await reconcileBuiltinPronunciationPacks()
  const packs = await db.select().from(pronunciationPacks).orderBy(asc(pronunciationPacks.name))
  const counts = await db
    .select({ packId: pronunciations.packId, cnt: count() })
    .from(pronunciations)
    .groupBy(pronunciations.packId)
  const countMap = new Map(counts.map((r) => [r.packId, r.cnt]))
  return c.json({
    packs: packs.map((p) => ({
      id: p.id, slug: p.slug, name: p.name, appKey: p.appKey,
      description: p.description, enabled: p.enabled, builtIn: p.builtIn,
      itemCount: countMap.get(p.id) ?? 0,
    })),
  })
})

adminVoice.patch('/pronunciation-packs/:id', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean }
  if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled (boolean) required' }, 400)
  await db.update(pronunciationPacks)
    .set({ enabled: body.enabled, updatedAt: new Date() })
    .where(eq(pronunciationPacks.id, c.req.param('id')))
  invalidatePronunciations()
  return c.json({ ok: true })
})

// Items within a pack (add/edit/delete individual rules).
adminVoice.get('/pronunciation-packs/:id/items', requireAdmin, async (c) => {
  const rows = await db.select().from(pronunciations)
    .where(eq(pronunciations.packId, c.req.param('id')))
    .orderBy(asc(pronunciations.term))
  return c.json({ items: rows.map(packItemRow) })
})

adminVoice.put('/pronunciation-packs/:id/items', requireAdmin, async (c) => {
  const packId = c.req.param('id')
  const body = (await c.req.json().catch(() => ({}))) as { id?: string; term?: string; replacement?: string }
  const term = (body.term ?? '').trim()
  const replacement = (body.replacement ?? '').trim()
  if (!term || !replacement) return c.json({ error: 'term and replacement are required' }, 400)

  const now = new Date()
  if (body.id) {
    await db.update(pronunciations).set({ term, replacement, updatedAt: now }).where(eq(pronunciations.id, body.id))
  } else {
    await db.insert(pronunciations).values({ id: crypto.randomUUID(), packId, term, replacement, createdAt: now, updatedAt: now })
  }
  invalidatePronunciations()
  const rows = await db.select().from(pronunciations)
    .where(eq(pronunciations.packId, packId))
    .orderBy(asc(pronunciations.term))
  return c.json({ items: rows.map(packItemRow) })
})

adminVoice.delete('/pronunciation-packs/:id/items/:itemId', requireAdmin, async (c) => {
  await db.delete(pronunciations).where(eq(pronunciations.id, c.req.param('itemId')))
  invalidatePronunciations()
  return c.json({ ok: true })
})

// ── Custom pronunciation rules (packId = null, always applied) ────────────────
adminVoice.get('/pronunciations', requireAdmin, async (c) => {
  const rows = await db.select().from(pronunciations).where(isNull(pronunciations.packId)).orderBy(asc(pronunciations.term))
  return c.json({ pronunciations: rows.map(packItemRow) })
})

adminVoice.put('/pronunciations', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { id?: string; term?: string; replacement?: string }
  const term = (body.term ?? '').trim()
  const replacement = (body.replacement ?? '').trim()
  if (!term || !replacement) return c.json({ error: 'term and replacement are required' }, 400)

  const now = new Date()
  if (body.id) {
    await db.update(pronunciations).set({ term, replacement, updatedAt: now }).where(eq(pronunciations.id, body.id))
  } else {
    await db.insert(pronunciations).values({ id: crypto.randomUUID(), term, replacement, createdAt: now, updatedAt: now })
  }
  invalidatePronunciations()
  const rows = await db.select().from(pronunciations).where(isNull(pronunciations.packId)).orderBy(asc(pronunciations.term))
  return c.json({ pronunciations: rows.map(packItemRow) })
})

adminVoice.delete('/pronunciations/:id', requireAdmin, async (c) => {
  await db.delete(pronunciations).where(eq(pronunciations.id, c.req.param('id')))
  invalidatePronunciations()
  return c.json({ ok: true })
})

export { adminVoice }
