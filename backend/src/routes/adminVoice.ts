import { Hono } from 'hono'
import { eq, asc, count, isNull } from 'drizzle-orm'
import { requireAdmin } from '@/middleware/auth'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { voiceConfig } from '@/lib/voice'
import { kokoroEngine, listKokoroVoices } from '@/lib/voice/engines/kokoroEngine'
import { whisperHealth } from '@/lib/whisper'
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
