import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { eq, and } from 'drizzle-orm'
import { db } from '@/db'
import { characters, characterUserGrants, userPreferences, userCharacters } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { ensureDefaultCompanions } from '@/lib/defaultCompanions'
import { ollamaChatStream } from '@/llm/ollama'
import type { OllamaChatMessage } from '@/llm/ollama'
import { getModel, getVisionModel } from '@/lib/models'
import { buildCompanionPrompt } from '@/lib/companionPrompt'
import { runToolTurn } from '@/lib/toolTurn'
import { isOffline } from '@/lib/connectivity'
import { embed } from '@/llm/embed'
import { recallMemories, formatMemoriesForPrompt } from '@/memory/recall'
import { getCachedMemoryBlock, setCachedMemoryBlock, invalidateMemoryBlock } from '@/memory/blockCache'
import { extractMemories } from '@/memory/extract'
import { friendshipLine, writeFirstMetMemory } from '@/lib/friendshipMemory'
import { getCachedBriefing } from '@/lib/briefing/cache'
import { ensureBriefingWarm, DEFAULT_BRIEFING_KEY } from '@/lib/briefing/refresh'
import {
  getCeiling, getUserCeiling, effectiveCeiling,
  parseCharacterContent, characterGate, buildContentPrompt,
} from '@/lib/contentPolicy'
import { buildInteractionFragment, ProfanityStreamBuffer } from '@/lib/protections'
import { logger } from '@/lib/logger'
import type { AppEnv } from '@/types'

const companions_ = new Hono<AppEnv>()

const ACTIVE_PREF_KEY = 'companion.active_character_id'
const FAVORITES_PREF_KEY = 'companion.favorites'

type CompanionRow = typeof characters.$inferSelect

// Shape a DB row into the API payload (parse the avatarConfig JSON blob).
export function toCompanionPayload(row: CompanionRow) {
  let avatarConfig: Record<string, unknown> = {}
  if (row.avatarConfig) {
    try { avatarConfig = JSON.parse(row.avatarConfig) as Record<string, unknown> } catch { /* ignore */ }
  }
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    personalityPrompt: row.personalityPrompt,
    backstory: row.backstory,
    phoneticName: row.phoneticName,
    replyStyle: row.replyStyle,
    voiceId: row.voiceId,
    ttsVoice: row.ttsVoice,
    wakeWordModelId: row.wakeWordModelId,
    wakeWordPhrase: row.wakeWordPhrase,
    speechRate: row.speechRate,
    renderer: row.renderer,
    style: row.style,
    seed: row.seed,
    avatarConfig,
    category: row.category,
    isActive: row.isActive,
    published: row.published,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // Content config: { profanity, sexual, violence, substances, candor }
    content: (() => { const cc = parseCharacterContent(row.contentDials); return { ...cc.dials, candor: cc.candor } })(),
  }
}

// Characters a user may use. Default-visible: enabled + published unless an explicit
// 'off' grant exists for the user. Admins see everything (including unpublished/inactive).
export async function getVisibleCompanions(userId: string, isAdmin: boolean): Promise<CompanionRow[]> {
  if (isAdmin) {
    return db.select().from(characters)
  }
  const visible = await db
    .select()
    .from(characters)
    .where(and(eq(characters.isActive, true), eq(characters.published, true)))

  if (visible.length === 0) return []

  const offGrants = await db
    .select({ characterId: characterUserGrants.characterId })
    .from(characterUserGrants)
    .where(and(eq(characterUserGrants.userId, userId), eq(characterUserGrants.state, 'off')))
  const revoked = new Set(offGrants.map((r) => r.characterId))

  return visible.filter((ch) => !revoked.has(ch.id))
}

// ── List visible characters ────────────────────────────────────────────────────
companions_.get('/', requireAuth, async (c) => {
  const user = c.get('user')
  await ensureDefaultCompanions(user.id)
  const [rows, adminCeiling, userCeiling] = await Promise.all([
    getVisibleCompanions(user.id, user.role === 'admin'),
    getCeiling(),
    getUserCeiling(user.id, user.role),
  ])
  // Attach a per-user eligibility gate: a character is locked when its content config
  // exceeds the effective ceiling (stricter of admin and user).
  const effCeiling = effectiveCeiling(adminCeiling, userCeiling)
  return c.json(rows.map((row) => ({
    ...toCompanionPayload(row),
    gate: characterGate(parseCharacterContent(row.contentDials).dials, effCeiling),
  })))
})

// ── Active character preference ─────────────────────────────────────────────────
companions_.get('/active', requireAuth, async (c) => {
  const user = c.get('user')
  const [pref] = await db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, user.id), eq(userPreferences.key, ACTIVE_PREF_KEY)))
    .limit(1)
  let activeId: string | null = null
  if (pref) { try { activeId = JSON.parse(pref.value) as string | null } catch { /* ignore */ } }
  return c.json({ activeCharacterId: activeId })
})

companions_.put('/active', requireAuth, async (c) => {
  const user = c.get('user')
  const body = (await c.req.json()) as { activeCharacterId: string | null }
  const now = new Date()
  await db
    .insert(userPreferences)
    .values({ id: crypto.randomUUID(), userId: user.id, key: ACTIVE_PREF_KEY, value: JSON.stringify(body.activeCharacterId ?? null), updatedAt: now })
    .onConflictDoUpdate({ target: [userPreferences.userId, userPreferences.key], set: { value: JSON.stringify(body.activeCharacterId ?? null), updatedAt: now } })
  return c.json({ ok: true })
})

// ── Favorite characters (pinned for quick switching) ─────────────────────────────
companions_.get('/favorites', requireAuth, async (c) => {
  const user = c.get('user')
  const [pref] = await db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, user.id), eq(userPreferences.key, FAVORITES_PREF_KEY)))
    .limit(1)
  let favorites: string[] = []
  if (pref) { try { const v = JSON.parse(pref.value); if (Array.isArray(v)) favorites = v.filter((x): x is string => typeof x === 'string') } catch { /* ignore */ } }
  return c.json({ favorites })
})

companions_.put('/favorites', requireAuth, async (c) => {
  const user = c.get('user')
  const body = (await c.req.json()) as { favorites: unknown }
  const favorites = Array.isArray(body.favorites) ? body.favorites.filter((x): x is string => typeof x === 'string') : []
  const now = new Date()
  await db
    .insert(userPreferences)
    .values({ id: crypto.randomUUID(), userId: user.id, key: FAVORITES_PREF_KEY, value: JSON.stringify(favorites), updatedAt: now })
    .onConflictDoUpdate({ target: [userPreferences.userId, userPreferences.key], set: { value: JSON.stringify(favorites), updatedAt: now } })
  return c.json({ ok: true })
})

// ── Ephemeral companion stream ───────────────────────────────────────────────
// The buddy talks back IN PLACE (off the chat app). Persists NOTHING — no
// conversation, no messages, no navigation. Only the real /api/chat/stream path
// (used when the chat app is open) records conversations.
companions_.post('/companion', requireAuth, async (c) => {
  const user = c.get('user')
  const body = (await c.req.json()) as {
    characterId: string
    message: string
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
    uiContext?: string | null
    images?: string[] // base64-encoded images (no data: prefix) for vision queries
  }

  const [row] = await db.select().from(characters).where(eq(characters.id, body.characterId)).limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  if (user.role !== 'admin') {
    if (!row.isActive || !row.published) return c.json({ error: 'Not found' }, 404)
    const [grant] = await db
      .select({ state: characterUserGrants.state })
      .from(characterUserGrants)
      .where(and(eq(characterUserGrants.userId, user.id), eq(characterUserGrants.characterId, body.characterId)))
      .limit(1)
    if (grant?.state === 'off') return c.json({ error: 'Not found' }, 404)
  }

  // ── Latency instrumentation ───────────────────────────────────────────────
  // This is the voice/speech surface, so every ms here lands between "prompt sent"
  // and "first word spoken". Mirrors chat.ts's [CHAT-TIMING].
  const _t0 = performance.now()
  const _lap = (label: string) => {
    logger.info(`[COMPANION-TIMING] ${label} +${(performance.now() - _t0).toFixed(0)}ms`)
  }

  const persona = buildCompanionPrompt({ personalityPrompt: row.personalityPrompt, replyStyle: row.replyStyle, style: row.style, avatarConfig: row.avatarConfig })
  const hasImages = Array.isArray(body.images) && body.images.length > 0
  // Use vision model when images are attached; regular chat model otherwise
  const model = hasImages ? await getVisionModel() : await getModel()
  const charId = body.characterId

  // Memory recall gates time-to-first-token (the block must be in the system
  // prompt before generation starts). The companion is ephemeral so it has no
  // conversation id — cache the block per user+character. Cache hits skip the
  // embed + vector search entirely, so speech starts sooner on follow-up turns.
  // The cache is invalidated after this turn's background extract runs (below),
  // so newly-learned facts still surface promptly.
  const memKey = `companion:${user.id}:${charId}`
  const cachedMem = getCachedMemoryBlock(memKey)

  // Route through the same tool pipeline as the main chat so voice/companion
  // requests can use news, web search, weather, etc. — and, IN PARALLEL, recall
  // long-term memory so the buddy knows the user. Running both at once means
  // memory adds no wall-clock beyond the tool routing that was already there.
  const history = (body.history ?? []).slice(-6).map((m) => ({ role: m.role, content: m.content }))
  const offlineMode = await isOffline(user.id)
  const [{ userContent }, computedMemory, prefsRows, existingRelation, adminCeiling] = await Promise.all([
    runToolTurn({ message: body.message, history, userId: user.id, userRole: user.role, model, offline: offlineMode }),
    cachedMem
      ? Promise.resolve(null as string | null)
      : embed(body.message)
          .then(async (embedding) => {
            const recalled = await recallMemories(body.message, user.id, charId, embedding)
            return formatMemoriesForPrompt(recalled, user.id, charId, embedding)
          })
          .catch(() => null as string | null),
    db.select().from(userPreferences).where(eq(userPreferences.userId, user.id)),
    db.select({ createdAt: userCharacters.createdAt }).from(userCharacters)
      .where(and(eq(userCharacters.userId, user.id), eq(userCharacters.characterId, body.characterId)))
      .limit(1).then(r => r[0] ?? null),
    getCeiling(),
  ])
  const memoryBlock = cachedMem ? cachedMem.memoryBlock : computedMemory
  if (!cachedMem) setCachedMemoryBlock(memKey, memoryBlock)
  _lap(`prep-done(mem=${cachedMem ? 'cached' : 'computed'})`)

  const now = new Date()
  db.insert(userCharacters)
    .values({ id: crypto.randomUUID(), userId: user.id, characterId: body.characterId, createdAt: now })
    .onConflictDoNothing().catch(() => {})

  const userDisplayName = user.nickname?.trim() || user.firstName?.trim() || null
  if (!existingRelation) {
    writeFirstMetMemory(user.id, body.characterId, row.name, userDisplayName ?? 'the user', now).catch(() => {})
  }

  const friendshipStart = existingRelation?.createdAt ?? null

  const prefs = Object.fromEntries(prefsRows.map(r => [r.key, JSON.parse(r.value)]))
  // ── Content policy ─────────────────────────────────────────────────────────
  // A character runs at its own config (can't be compromised) and is usable only if
  // every dial sits within the effective ceiling (stricter of admin and user).
  const effCeiling = effectiveCeiling(adminCeiling, await getUserCeiling(user.id, user.role))
  const charContent = parseCharacterContent(row.contentDials)
  if (!characterGate(charContent.dials, effCeiling).usable) {
    return c.json({ error: 'This character exceeds your content settings.' }, 403)
  }
  const contentPrompt = await buildContentPrompt(charContent.dials)
  const candorFragment = buildInteractionFragment({ language: 'conversational', depth: 'balanced', candor: charContent.candor })
  const maskProfanityActive = charContent.dials.profanity === 'off'
  const storedLoc = prefs['user.location'] as { displayName?: string; lat?: number; lng?: number } | undefined
  const locStr = storedLoc?.displayName ?? null

  // Ambient world/local context: a SYNCHRONOUS warm-cache read (no await/fetch) so it
  // never touches the [COMPANION-TIMING] budget. The block only changes every ~cadence,
  // keeping the system-prompt prefix stable for Ollama KV-cache reuse. Closing the date
  // gap too — the companion (unlike main chat) previously never knew today's date.
  const date = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  const briefingKey = locStr ?? DEFAULT_BRIEFING_KEY
  const briefingBlock = offlineMode ? null : (getCachedBriefing(briefingKey)?.block || null)
  if (!offlineMode) {
    ensureBriefingWarm(briefingKey, locStr ? { displayName: locStr, lat: storedLoc?.lat, lng: storedLoc?.lng } : null, user.id)
  }

  const contextLine = [
    `Today is ${date}.`,
    userDisplayName ? `You are speaking with ${userDisplayName}.` : null,
    locStr ? `They are located in ${locStr}.` : null,
    friendshipLine(friendshipStart),
  ].filter(Boolean).join(' ')

  const sys = [
    contentPrompt,
    `You are the user's companion, chatting casually in a little floating bar. Keep replies short and conversational.${contextLine ? ` ${contextLine}` : ''}`,
    persona,
    candorFragment || null,
    body.uiContext ?? null,
    memoryBlock,
    briefingBlock,
  ].filter(Boolean).join('\n\n')

  const userMessage: OllamaChatMessage = {
    role: 'user',
    content: userContent,
    ...(hasImages && { images: body.images }),
  }

  const messages: OllamaChatMessage[] = [
    { role: 'system', content: sys },
    ...history,
    userMessage,
  ]

  c.header('X-Accel-Buffering', 'no')
  _lap(`stream-start msgs=${messages.length}`)
  return streamSSE(c, async (stream) => {
    let reply = ''
    let firstToken = true
    // Mask profanity in the emitted stream when the active profanity dial is off.
    // `reply` stays raw — memory extraction works on the actual words, not stars.
    const profanityBuf = maskProfanityActive ? new ProfanityStreamBuffer() : null
    try {
      for await (const chunk of ollamaChatStream(model, messages, { temperature: 0.7, num_ctx: 4096, num_predict: 400 })) {
        if (chunk.message.content) {
          if (firstToken) { _lap('first-token'); firstToken = false }
          reply += chunk.message.content
          const emitted = profanityBuf ? profanityBuf.flush(chunk.message.content) : chunk.message.content
          if (emitted) await stream.writeSSE({ event: 'token', data: emitted })
        }
        if (chunk.done) {
          if (profanityBuf) {
            const tail = profanityBuf.drain()
            if (tail) await stream.writeSSE({ event: 'token', data: tail })
          }
          _lap('llm-done'); await stream.writeSSE({ event: 'done', data: '{}' }); break
        }
      }
    } catch (err) {
      await stream.writeSSE({ event: 'error', data: String(err) })
    }
    // Learn from this turn — fire-and-forget AFTER the stream so it never blocks
    // the reply. Companion still persists no conversation; only durable facts the
    // extractor distills land in the shared memory store. Use raw body.message
    // (not userContent, which carries appended tool JSON) and a text model.
    if (reply.trim()) {
      const turns = [...history, { role: 'user', content: body.message }, { role: 'assistant', content: reply }]
      void (async () => {
        try {
          const extractModel = hasImages ? await getModel() : model
          await extractMemories(turns, extractModel, user.id, charId)
          // Any newly-distilled facts must surface next turn — drop the cached
          // block so it is recomputed once, then re-cached.
          invalidateMemoryBlock(memKey)
        } catch { /* background best-effort */ }
      })()
    }
  })
})

// ── Single character ─────────────────────────────────────────────────────────
companions_.get('/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(characters).where(eq(characters.id, id)).limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)

  if (user.role !== 'admin') {
    if (!row.isActive || !row.published) return c.json({ error: 'Not found' }, 404)
    const [grant] = await db
      .select({ state: characterUserGrants.state })
      .from(characterUserGrants)
      .where(and(eq(characterUserGrants.userId, user.id), eq(characterUserGrants.characterId, id)))
      .limit(1)
    if (grant?.state === 'off') return c.json({ error: 'Not found' }, 404)
  }
  return c.json(toCompanionPayload(row))
})

export { companions_ as companions }
