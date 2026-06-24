import { Hono } from 'hono'
import { eq, asc } from 'drizzle-orm'
import { requireAdmin } from '@/middleware/auth'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { voiceConfig } from '@/lib/voice'
import { kokoroEngine, listKokoroVoices } from '@/lib/voice/engines/kokoroEngine'
import { whisperHealth } from '@/lib/whisper'
import { db } from '@/db'
import { pronunciations } from '@/db/schema'
import { invalidatePronunciations } from '@/lib/voice/pronunciation'
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

// ── Pronunciation lexicon (global) ───────────────────────────────────────────
adminVoice.get('/pronunciations', requireAdmin, async (c) => {
  const rows = await db.select().from(pronunciations).orderBy(asc(pronunciations.term))
  return c.json({ pronunciations: rows.map((r) => ({ id: r.id, term: r.term, replacement: r.replacement })) })
})

// Create or update (by id when present).
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
  const rows = await db.select().from(pronunciations).orderBy(asc(pronunciations.term))
  return c.json({ pronunciations: rows.map((r) => ({ id: r.id, term: r.term, replacement: r.replacement })) })
})

adminVoice.delete('/pronunciations/:id', requireAdmin, async (c) => {
  await db.delete(pronunciations).where(eq(pronunciations.id, c.req.param('id')))
  invalidatePronunciations()
  return c.json({ ok: true })
})

export { adminVoice }
