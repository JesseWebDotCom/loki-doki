import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { eq, and, desc } from 'drizzle-orm'
import { db } from '@/db'
import { characters, characterUserGrants, users } from '@/db/schema'
import { requireAdmin } from '@/middleware/auth'
import { ollamaChatStream } from '@/llm/ollama'
import type { OllamaChatMessage } from '@/llm/ollama'
import { getModel } from '@/lib/models'
import { buildCompanionPrompt } from '@/lib/companionPrompt'
import { ensureDefaultCompanions } from '@/lib/defaultCompanions'
import { toCompanionPayload } from '@/routes/companions'
import { serializeCharacterContent } from '@/lib/contentPolicy'
import type { AppEnv } from '@/types'

const adminCompanions = new Hono<AppEnv>()

function slugify(name: string): string {
  const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'companion'
  return `${base}-${crypto.randomUUID().slice(0, 6)}`
}

interface CompanionInput {
  name?: string
  personalityPrompt?: string
  backstory?: string | null
  phoneticName?: string | null
  replyStyle?: 'brief' | 'balanced' | 'detailed' | 'auto'
  voiceId?: string | null
  ttsVoice?: string | null
  wakeWordModelId?: string | null
  wakeWordPhrase?: string | null
  speechRate?: number | null
  expressiveness?: number | null
  renderer?: string
  style?: string | null
  seed?: string | null
  avatarConfig?: Record<string, unknown> | null
  category?: string | null
  isActive?: boolean
  published?: boolean
  // Content config: { profanity, sexual, violence, substances, candor }
  content?: Record<string, unknown> | null
}

// ── List all (admin sees everything) ────────────────────────────────────────────
adminCompanions.get('/', requireAdmin, async (c) => {
  const user = c.get('user')
  await ensureDefaultCompanions(user.id)
  const rows = await db.select().from(characters).orderBy(desc(characters.updatedAt))
  return c.json(rows.map(toCompanionPayload))
})

// ── Create ───────────────────────────────────────────────────────────────────
adminCompanions.post('/', requireAdmin, async (c) => {
  const user = c.get('user')
  const body = (await c.req.json()) as CompanionInput
  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400)

  const now = new Date()
  const id = crypto.randomUUID()
  // A character has at most one wakeword source. A trained ONNX model always
  // wins over a free-text phrase, so a stale phrase can never shadow it.
  const wakeWordModelId = body.wakeWordModelId?.trim() || null
  const wakeWordPhrase = wakeWordModelId ? null : (body.wakeWordPhrase?.trim() || null)
  await db.insert(characters).values({
    id,
    name: body.name.trim(),
    slug: slugify(body.name),
    personalityPrompt: body.personalityPrompt?.trim() || 'You are a friendly companion.',
    backstory: body.backstory ?? null,
    phoneticName: body.phoneticName ?? null,
    replyStyle: body.replyStyle ?? 'balanced',
    voiceId: body.voiceId ?? null,
    ttsVoice: body.ttsVoice ?? null,
    wakeWordModelId,
    wakeWordPhrase,
    speechRate: body.speechRate ?? null,
    expressiveness: body.expressiveness ?? null,
    renderer: body.renderer ?? 'dicebear',
    style: body.style ?? null,
    seed: body.seed ?? null,
    avatarConfig: body.avatarConfig ? JSON.stringify(body.avatarConfig) : null,
    contentDials: body.content ? serializeCharacterContent(body.content, body.content['candor']) : null,
    category: body.category ?? null,
    createdBy: user.id,
    isActive: body.isActive ?? true,
    published: body.published ?? true,
    createdAt: now,
    updatedAt: now,
  })
  const [row] = await db.select().from(characters).where(eq(characters.id, id)).limit(1)
  return c.json(toCompanionPayload(row!))
})

// ── Update ───────────────────────────────────────────────────────────────────
adminCompanions.patch('/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const body = (await c.req.json()) as CompanionInput

  const update: Record<string, unknown> = { updatedAt: new Date() }
  if (body.name !== undefined) update['name'] = body.name.trim()
  if (body.personalityPrompt !== undefined) update['personalityPrompt'] = body.personalityPrompt
  if (body.backstory !== undefined) update['backstory'] = body.backstory
  if (body.phoneticName !== undefined) update['phoneticName'] = body.phoneticName
  if (body.replyStyle !== undefined) update['replyStyle'] = body.replyStyle
  if (body.voiceId !== undefined) update['voiceId'] = body.voiceId
  if (body.ttsVoice !== undefined) update['ttsVoice'] = body.ttsVoice
  // Single wakeword source: assigning a trained model clears any phrase so the
  // two can never both be set and silently conflict.
  if (body.wakeWordModelId !== undefined) {
    const mid = body.wakeWordModelId?.trim() || null
    update['wakeWordModelId'] = mid
    if (mid) update['wakeWordPhrase'] = null
  }
  if (body.wakeWordPhrase !== undefined && update['wakeWordPhrase'] === undefined) {
    update['wakeWordPhrase'] = body.wakeWordPhrase?.trim() || null
  }
  if (body.speechRate !== undefined) update['speechRate'] = body.speechRate
  if (body.expressiveness !== undefined) update['expressiveness'] = body.expressiveness
  if (body.renderer !== undefined) update['renderer'] = body.renderer
  if (body.style !== undefined) update['style'] = body.style
  if (body.seed !== undefined) update['seed'] = body.seed
  if (body.avatarConfig !== undefined) update['avatarConfig'] = body.avatarConfig ? JSON.stringify(body.avatarConfig) : null
  if (body.content !== undefined) update['contentDials'] = body.content ? serializeCharacterContent(body.content, body.content['candor']) : null
  if (body.category !== undefined) update['category'] = body.category
  if (body.isActive !== undefined) update['isActive'] = body.isActive
  if (body.published !== undefined) update['published'] = body.published

  await db.update(characters).set(update).where(eq(characters.id, id))
  const [row] = await db.select().from(characters).where(eq(characters.id, id)).limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json(toCompanionPayload(row))
})

// ── Delete ───────────────────────────────────────────────────────────────────
adminCompanions.delete('/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  await db.delete(characters).where(eq(characters.id, id))
  return c.json({ ok: true })
})

// ── Global gates ───────────────────────────────────────────────────────────────
adminCompanions.post('/:id/enable', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const { enabled } = (await c.req.json()) as { enabled: boolean }
  await db.update(characters).set({ isActive: enabled, updatedAt: new Date() }).where(eq(characters.id, id))
  return c.json({ ok: true })
})

adminCompanions.post('/:id/publish', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const { published } = (await c.req.json()) as { published: boolean }
  await db.update(characters).set({ published, updatedAt: new Date() }).where(eq(characters.id, id))
  return c.json({ ok: true })
})

// ── Per-user access grants ───────────────────────────────────────────────────
adminCompanions.get('/:id/grants', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const [ch] = await db.select({ id: characters.id }).from(characters).where(eq(characters.id, id)).limit(1)
  if (!ch) return c.json({ error: 'Not found' }, 404)

  const allUsers = await db.select({ id: users.id, nickname: users.nickname, role: users.role }).from(users)
  const grants = await db.select().from(characterUserGrants).where(eq(characterUserGrants.characterId, id))
  const grantMap = new Map(grants.map((g) => [g.userId, g.state]))

  // Default-visible: absence of a row means 'on' (granted). 'off' = revoked.
  return c.json(allUsers.map((u) => ({
    userId: u.id,
    nickname: u.nickname,
    role: u.role,
    state: grantMap.get(u.id) ?? 'on',
  })))
})

adminCompanions.put('/:id/grants/:userId', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const userId = c.req.param('userId')
  const body = (await c.req.json()) as { state: 'on' | 'off' }
  const now = new Date()
  await db
    .insert(characterUserGrants)
    .values({ id: crypto.randomUUID(), userId, characterId: id, state: body.state, updatedAt: now })
    .onConflictDoUpdate({ target: [characterUserGrants.userId, characterUserGrants.characterId], set: { state: body.state, updatedAt: now } })
  return c.json({ ok: true })
})

// ── Live tester — streams an Ollama reply for an UNSAVED draft persona ───────────
// Sandbox: nothing is persisted. Used by the studio Test tab.
adminCompanions.post('/test', requireAdmin, async (c) => {
  const body = (await c.req.json()) as {
    personalityPrompt: string
    replyStyle?: 'brief' | 'balanced' | 'detailed' | 'auto'
    message: string
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
  }

  const model = await getModel()
  const persona = buildCompanionPrompt({ personalityPrompt: body.personalityPrompt, replyStyle: body.replyStyle })
  const sys = ['Be concise. This is a companion preview.', persona].filter(Boolean).join('\n\n')

  const messages: OllamaChatMessage[] = [
    { role: 'system', content: sys },
    ...(body.history ?? []).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: body.message },
  ]

  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    try {
      for await (const chunk of ollamaChatStream(model, messages, { temperature: 0.7, num_ctx: 4096, num_predict: 512 })) {
        if (chunk.message.content) await stream.writeSSE({ event: 'token', data: chunk.message.content })
        if (chunk.done) { await stream.writeSSE({ event: 'done', data: '{}' }); break }
      }
    } catch (err) {
      await stream.writeSSE({ event: 'error', data: String(err) })
    }
  })
})

export { adminCompanions }
