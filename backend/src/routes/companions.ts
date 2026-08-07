import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { eq, and } from 'drizzle-orm'
import { db } from '@/db'
import { characters, characterUserGrants, userPreferences, userCharacters } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { ensureDefaultCompanions } from '@/lib/defaultCompanions'
import { buildDicebearSvg, rasterizeSvgToPng } from '@/lib/avatar'
import { getModel, getVisionModel } from '@/lib/models'
import { companionsAllowed } from '@/lib/consent'
import { invalidateMemoryBlocksForUser, invalidateAllMemoryBlocks } from '@/memory/blockCache'
import { invalidateEntityCache } from '@/memory/recall'
import { runJudge, relinkEntityIds } from '@/memory/judge'
import { writeFirstMetMemory } from '@/lib/friendshipMemory'
import { getUserCeiling, parseCharacterContent, characterGate } from '@/lib/contentPolicy'
import { runCompanionTurn, resolveTurnContext } from '@/lib/companionTurn'
import { getActionById, resolveAction } from '@/lib/companionActions'
import * as genQueue from '@/lib/genQueue'
import { logger } from '@/lib/logger'
import { getVoicePrefs, setVoicePrefs, type VoicePrefs } from '@/lib/voice/voicePrefs'
import type { AppEnv } from '@/types'

const companions_ = new Hono<AppEnv>()

const ACTIVE_PREF_KEY = 'companion.active_character_id'
const FAVORITES_PREF_KEY = 'companion.favorites'

// ── Debounced companion judge ─────────────────────────────────────────────────
// The overlay used to re-judge an overlapping 10-message window after EVERY turn —
// the same statements were re-extracted turn after turn (each costing an 8B call
// plus dedup rounds) while contending with the next interactive turn's TTFT on a
// single GPU. Turns now accumulate per user+character and the judge fires once the
// user has gone quiet for JUDGE_IDLE_MS (or the buffer fills).
const JUDGE_IDLE_MS = 2 * 60_000
const JUDGE_MAX_TURNS = 20
const pendingJudge = new Map<string, { turns: { role: string; content: string }[]; timer: ReturnType<typeof setTimeout> }>()

function scheduleCompanionJudge(
  memKey: string,
  userId: string,
  newTurns: { role: string; content: string }[],
  resolveModel: () => Promise<string>,
): void {
  const existing = pendingJudge.get(memKey)
  if (existing) clearTimeout(existing.timer)
  const turns = [...(existing?.turns ?? []), ...newTurns].slice(-JUDGE_MAX_TURNS)

  const fire = async () => {
    pendingJudge.delete(memKey)
    try {
      const model = await resolveModel()
      const judgeResult = await runJudge('companion', userId, null, turns, model)
      await relinkEntityIds(userId, null)
      // Newly-distilled facts must surface next turn — on EVERY surface, since
      // they land in the shared brain (household facts: everyone's cache).
      invalidateEntityCache(userId)
      if (judgeResult.householdTouched) invalidateAllMemoryBlocks()
      else invalidateMemoryBlocksForUser(userId)
    } catch { /* background best-effort */ }
  }

  const timer = setTimeout(() => { void fire() }, JUDGE_IDLE_MS)
  pendingJudge.set(memKey, { turns, timer })
  // A full buffer fires immediately — don't let a long rapid session outrun the window.
  if (turns.length >= JUDGE_MAX_TURNS) {
    clearTimeout(timer)
    pendingJudge.delete(memKey)
    void fire()
  }
}

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
    personaExamples: (() => { try { return row.personaExamples ? JSON.parse(row.personaExamples) as string[] : [] } catch { return [] } })(),
    phoneticName: row.phoneticName,
    replyStyle: row.replyStyle,
    voiceId: row.voiceId,
    ttsVoice: row.ttsVoice,
    wakeWordModelId: row.wakeWordModelId,
    wakeWordPhrase: row.wakeWordPhrase,
    speechRate: row.speechRate,
    expressiveness: row.expressiveness,
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
  const [rows, userCeiling] = await Promise.all([
    getVisibleCompanions(user.id, user.role === 'admin'),
    getUserCeiling(user.id),
  ])
  // Attach a per-user content gate: which categories the user's profile clamps below
  // the character's authored level (display hint only — characters are never blocked).
  return c.json(rows.map((row) => ({
    ...toCompanionPayload(row),
    gate: characterGate(parseCharacterContent(row.contentDials).dials, userCeiling),
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
  // Consent gate — companions are disabled unless the user has consented to them.
  if (!(await companionsAllowed(user.id))) {
    return c.json({ error: 'companions_disabled', message: 'AI companions are disabled. Enable them in Settings → consent.' }, 403)
  }
  const body = (await c.req.json()) as {
    characterId: string
    message: string
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
    uiContext?: string | null
    clientTz?: string | null
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

  const hasImages = Array.isArray(body.images) && body.images.length > 0
  const charId = body.characterId

  // One brain: the overlay is now a thin caller of the SAME runCompanionTurn as the
  // chat route and the Pods (routing, tools/directReply, briefing, memory, skills,
  // locale, content dials, KV-safe prompt ordering, profanity masking). Only the
  // surface concerns live here: consent/grants, vision-model swap, the ephemeral
  // per-user+character memory key, and the post-turn judge (nothing is persisted,
  // so the idle sweep never sees these turns).
  const [ctx, existingRelation] = await Promise.all([
    resolveTurnContext(user.id, charId),
    db.select({ createdAt: userCharacters.createdAt }).from(userCharacters)
      .where(and(eq(userCharacters.userId, user.id), eq(userCharacters.characterId, charId)))
      .limit(1).then(r => r[0] ?? null),
  ])
  // The main chat model (not the 3B fast model — it degenerates into 1–3 word stubs
  // on emotional prompts, which looked like a "voice cutoff"). Vision needs the VLM.
  const model = hasImages ? await getVisionModel() : ctx.model

  const now = new Date()
  db.insert(userCharacters)
    .values({ id: crypto.randomUUID(), userId: user.id, characterId: charId, createdAt: now })
    .onConflictDoNothing().catch(() => {})

  const userDisplayName = user.nickname?.trim() || user.firstName?.trim() || null
  if (!existingRelation) {
    writeFirstMetMemory(user.id, charId, row.name, userDisplayName ?? 'the user', now).catch(() => {})
  }

  // Ephemeral surface — no conversation id; the memory-block cache and tool
  // `_conversationId` key by user+character instead.
  const memKey = `companion:${user.id}:${charId}`
  const history = (body.history ?? []).slice(-6).map((m) => ({ role: m.role, content: m.content }))
  const cookieHeader = c.req.header('cookie') ?? ''

  const run = async (jobCtx: genQueue.JobRunContext): Promise<void> => {
   // Never leak internal error text into the overlay bubble: a throw before/around the stream
   // (e.g. a DB error in getAllowedToolIds/buildToolConfig) would otherwise be fanned out by
   // genQueue as the raw exception string. Mirror makeChatRun's guard.
   try {
    const result = await runCompanionTurn(
      {
        userId: user.id,
        userRole: user.role,
        userDisplayName,
        model,
        // Voice replies stay capped short — everything else follows the user's chat
        // options (same num_ctx as chat = no Ollama runner thrash between surfaces).
        options: { ...ctx.options, num_predict: 400 },
        message: body.message,
        characterId: charId,
        characterSystemPrompt: ctx.characterSystemPrompt,
        uiContext: body.uiContext ?? null,
        clientLat: null,
        clientLng: null,
        clientTz: body.clientTz ?? null,
        convId: memKey,
        history,
        prefs: ctx.prefs,
        firstMetAt: existingRelation?.createdAt ?? null,
        cookieHeader,
        locale: ctx.locale,
        interactionStyle: ctx.interactionStyle,
        activeDials: ctx.activeDials,
        maskProfanityActive: ctx.maskProfanityActive,
        surface: 'overlay',
        harnessLine: `You are the user's companion, chatting casually in a little floating bar. Keep replies short and conversational.`,
        includeDocs: false, // ephemeral surface has no attached documents
        images: hasImages ? body.images : undefined,
      },
      {
        onToken: (t) => jobCtx.emit('token', t),
        onEvent: (type, data) => jobCtx.emit(type, data),
        signal: jobCtx.signal,
      },
    )

    // Learn from this turn — debounced so the judge runs once when the user goes
    // quiet (not after every single turn), over only the NEW turn pair (no
    // overlapping-window re-extraction). The judge applies the full discard rules
    // + entity/tier model and writes user facts to the SHARED brain
    // (characterId=null) so every companion shares knowledge of the person.
    // directReply turns carry no new user facts worth judging (canned confirmations).
    if (result.completed && !result.viaDirectReply && result.text.trim()) {
      scheduleCompanionJudge(
        memKey,
        user.id,
        [{ role: 'user', content: body.message }, { role: 'assistant', content: result.text }],
        () => hasImages ? getModel() : Promise.resolve(model),
      )
    }

    if (result.error) {
      logger.error(`[companion] stream error user=${user.id}: ${result.error}`)
      jobCtx.emit('error', 'The reply was interrupted.')
    } else {
      jobCtx.emit('done', '{}')
    }
   } catch (err) {
     logger.error(`[companion] overlay turn threw user=${user.id}: ${err instanceof Error ? err.stack ?? err.message : err}`)
     jobCtx.emit('error', 'Something went wrong generating that reply.')
   }
  }

  // Through the shared generation queue: voice turns get the same concurrency
  // limits, explicit cancellation (POST /api/chat/stream/:genId/cancel), and
  // disconnect-tolerant replay as chat turns. Previously this route bypassed the
  // queue entirely — unbounded concurrent voice generations, no cancel.
  let job: genQueue.Job
  try {
    job = genQueue.enqueue({ type: 'chat', userId: user.id, meta: { companionKey: memKey }, run })
  } catch (err) {
    if (err instanceof genQueue.QueueLimitError) {
      return c.json({ error: 'Too many requests in progress. Please wait a moment.' }, 429)
    }
    throw err
  }

  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    // Lead with the gen id so the client can cancel server-side generation
    // (aborting the fetch alone no longer stops the GPU — the job is decoupled).
    await stream.writeSSE({ event: 'gen', data: JSON.stringify({ genId: job.id }) })
    await genQueue.subscribeAndTail(stream, job, 0)
  })
})

// ── Staged-action confirmation (lib/companionActions) ────────────────────────
// Non-conversational resolver for confirm_action directives: Telegram declines,
// curl verification, future push-notification actions. Web surfaces normally
// resolve by re-entering a turn with 'Yes'/'No' instead (spoken outcome + a
// coherent transcript), but this endpoint hits the same single-use store, so
// whichever path runs first wins. 404 is identical for missing, expired, and
// foreign-user ids (no enumeration).
companions_.post('/action/:id/approve', requireAuth, async (c) => {
  const user = c.get('user')
  const a = getActionById(c.req.param('id'))
  if (!a || a.userId !== user.id) return c.json({ ok: false, error: 'expired' }, 404)
  const res = await resolveAction(a.id, true)
  if (!res) return c.json({ ok: false, error: 'expired' }, 404)
  return c.json(res)
})

companions_.post('/action/:id/decline', requireAuth, async (c) => {
  const user = c.get('user')
  const a = getActionById(c.req.param('id'))
  if (!a || a.userId !== user.id) return c.json({ ok: false, error: 'expired' }, 404)
  const res = await resolveAction(a.id, false)
  if (!res) return c.json({ ok: false, error: 'expired' }, 404)
  return c.json(res)
})

// ── Per-user voice customization (design: keen-percolating-swan) ────────────────
// A family member's personal voice/speed/pitch/hushed override for ONE companion,
// distinct from the character's own authored defaults, and never affects other
// household members. Storage: userPreferences (see lib/voice/voicePrefs.ts).
/**
 * A companion's face, rendered server-side.
 *
 * The web app builds DiceBear in the browser, which native clients can't do —
 * so the phone had no way to show the companion it was talking to. `state`
 * picks the same pose overrides the web avatar uses (listening, thinking,
 * sad, angry, shocked, sick), which is how a chat can show it thinking while
 * a reply generates (Jesse, 2026-08-07).
 */
companions_.get('/:id/avatar', requireAuth, async (c) => {
  const id = c.req.param('id')
  const state = c.req.query('state') ?? 'listening'
  const [row] = await db.select().from(characters).where(eq(characters.id, id)).limit(1)
  if (!row) return c.notFound()

  let config: Record<string, unknown> = {}
  if (row.avatarConfig) {
    try { config = JSON.parse(row.avatarConfig) as Record<string, unknown> } catch { /* ignore */ }
  }
  config._pose = state

  try {
    const svg = await buildDicebearSvg({
      id: row.id,
      firstName: row.name ?? 'Doki',
      lastName: '',
      dicebearStyle: row.style ?? 'avataaars',
      dicebearSeed: row.seed ?? row.id,
      dicebearConfig: JSON.stringify(config),
    })
    // PNG by default: the web app can render SVG, but UIImage cannot, so an
    // SVG here left the phone with a blank face (Jesse, 2026-08-07). SVG
    // stays available for callers that want it.
    if (c.req.query('format') !== 'svg') {
      const size = Math.min(Math.max(Number(c.req.query('size')) || 160, 32), 512)
      const png = await rasterizeSvgToPng(svg, size)
      if (png) {
        return new Response(new Uint8Array(png), {
          headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' },
        })
      }
      // sharp missing: fall through to SVG rather than 500.
    }
    return new Response(svg, {
      headers: {
        'Content-Type': 'image/svg+xml',
        // Same face for the same state; cheap to re-render but pointless to.
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch {
    return c.notFound()
  }
})

companions_.get('/:id/voice-prefs', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(characters).where(eq(characters.id, id)).limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  const override = (await getVoicePrefs(user.id, id)) ?? {}
  // `effective` merges the override onto the character's own defaults, so the
  // client never has to duplicate this resolution logic (routes/tts.ts applies
  // the same precedence when actually speaking a reply).
  return c.json({
    override,
    effective: {
      voiceId: override.voiceId ?? row.ttsVoice ?? null,
      speechRate: override.speechRate ?? row.speechRate ?? 1.0,
      pitchSemitones: override.pitchSemitones ?? 0,
      hushed: override.hushed ?? false,
    },
  })
})

companions_.put('/:id/voice-prefs', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(characters).where(eq(characters.id, id)).limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  const body = (await c.req.json()) as Partial<Record<keyof VoicePrefs, unknown>>
  // A field explicitly sent as null clears that override (falls back to the
  // character/app default); an omitted field is left untouched.
  const patch: VoicePrefs = {}
  if ('voiceId' in body) patch.voiceId = typeof body.voiceId === 'string' && body.voiceId ? body.voiceId : undefined
  if ('speechRate' in body) patch.speechRate = typeof body.speechRate === 'number' ? Math.max(0.8, Math.min(1.3, body.speechRate)) : undefined
  if ('pitchSemitones' in body) patch.pitchSemitones = typeof body.pitchSemitones === 'number' ? Math.max(-12, Math.min(12, Math.round(body.pitchSemitones))) : undefined
  if ('hushed' in body) patch.hushed = typeof body.hushed === 'boolean' ? body.hushed : undefined
  const saved = await setVoicePrefs(user.id, id, patch)
  return c.json({ ok: true, override: saved })
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
