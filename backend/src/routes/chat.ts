import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { eq, desc, and, sql } from 'drizzle-orm'
import { db } from '@/db'
import { characters, userCharacters, conversations, messages, memories, chatDocuments, chatDocumentEdits } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { extractText } from '@/lib/rag/ingest'
import { ollamaChat } from '@/llm/ollama'
import type { OllamaChatMessage } from '@/llm/ollama'
import { buildCompanionPrompt } from '@/lib/companionPrompt'
import { getModel } from '@/lib/models'
import { CATALOG } from '@/lib/catalog'
import { getProtections, getInteractionStyle } from '@/lib/protections'
import { writeFirstMetMemory } from '@/lib/friendshipMemory'
import { getLocaleSettings } from '@/routes/adminLocale'
import {
  getUserCeiling, clampDials, parseCharacterContent,
} from '@/lib/contentPolicy'
import type { ContentDials } from '@/lib/contentPolicy'
import { runCompanionTurn, loadUserPrefs } from '@/lib/companionTurn'
import * as genQueue from '@/lib/genQueue'
import type { JobRunContext } from '@/lib/genQueue'
import type { AppEnv } from '@/types'

const chat = new Hono<AppEnv>()

// Max characters of extracted document text kept per attachment.
const MAX_DOC_CHARS = 20_000

// Extract text from an uploaded document so the client can attach it to a message.
// Stateless — the returned text is sent back with the chat message and persisted then.
chat.post('/extract', requireAuth, async (c) => {
  const form = await c.req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File) || file.size === 0) return c.json({ error: 'file required' }, 400)
  if (file.size > 25 * 1024 * 1024) return c.json({ error: 'file too large (max 25 MB)' }, 400)
  try {
    const text = (await extractText(file.name, file.type, new Uint8Array(await file.arrayBuffer()))).slice(0, MAX_DOC_CHARS)
    if (!text.trim()) return c.json({ error: 'No readable text found in that file' }, 422)
    return c.json({ filename: file.name, text, chars: text.length })
  } catch (e) {
    return c.json({ error: `Could not read that file: ${e}` }, 400)
  }
})

// Download an edited document produced by the Document Assistant tool. Persisted in
// chat_document_edits, so it stays retrievable after the live result card is gone.
// Ownership-scoped; Content-Disposition forces a download with the suggested filename.
chat.get('/edited/:id/download', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')

  const [row] = await db
    .select({
      userId: chatDocumentEdits.userId,
      editedFilename: chatDocumentEdits.editedFilename,
      text: chatDocumentEdits.text,
    })
    .from(chatDocumentEdits)
    .where(eq(chatDocumentEdits.id, id))
    .limit(1)

  if (!row || row.userId !== user.id) return c.json({ error: 'Not found' }, 404)

  // Sanitize the filename for the header — strip anything that could break the
  // Content-Disposition parse or smuggle a path.
  const safeName = (row.editedFilename || 'edited.txt').replace(/[^\w.\- ]+/g, '_').slice(0, 200)

  c.header('Content-Type', 'text/plain; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="${safeName}"`)
  return c.body(row.text)
})

// The per-conversation memory block is computed once and reused for every
// subsequent turn (see @/memory/blockCache for the rationale). Keyed by convId.

// ── Conversation CRUD ─────────────────────────────────────────────────────────

chat.get('/conversations', requireAuth, async (c) => {
  const user = c.get('user')
  const projectId = c.req.query('projectId') ?? null

  const conditions = projectId
    ? and(eq(conversations.userId, user.id), eq(conversations.projectId, projectId))
    : eq(conversations.userId, user.id)

  const rows = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      pinned: conversations.pinned,
      projectId: conversations.projectId,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
      preview: sql<string>`(
        SELECT content FROM messages
        WHERE conversation_id = ${conversations.id}
        ORDER BY created_at DESC LIMIT 1
      )`,
    })
    .from(conversations)
    .where(conditions)
    .orderBy(desc(sql`COALESCE(${conversations.updatedAt}, ${conversations.createdAt})`))

  return c.json(rows)
})

chat.get('/conversations/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')

  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, user.id)))
    .limit(1)

  if (!conv) return c.json({ error: 'Not found' }, 404)

  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(messages.createdAt)

  return c.json({ ...conv, messages: msgs })
})

chat.delete('/conversations/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')

  await db
    .delete(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, user.id)))

  return c.json({ ok: true })
})

chat.patch('/conversations/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json() as { title?: string; pinned?: boolean }

  const update: Record<string, unknown> = {}
  if (body.title !== undefined) update['title'] = body.title
  if (body.pinned !== undefined) update['pinned'] = body.pinned

  if (Object.keys(update).length === 0) return c.json({ ok: true })

  await db
    .update(conversations)
    .set(update)
    .where(and(eq(conversations.id, id), eq(conversations.userId, user.id)))

  return c.json({ ok: true })
})

// ── Stream endpoint ───────────────────────────────────────────────────────────

chat.post('/stream', requireAuth, async (c) => {
  const user = c.get('user')

  const { message, conversationId: incomingConvId, characterId, uiContext, projectId, clientLat, clientLng, attachments } = (await c.req.json()) as {
    message: string
    conversationId?: string
    characterId?: string
    uiContext?: string | null
    projectId?: string
    clientLat?: number | null
    clientLng?: number | null
    attachments?: { filename: string; text: string }[]
  }

  // Validate the message before it flows into the token budget / title generation.
  if (typeof message !== 'string' || message.trim().length === 0) {
    return c.json({ error: 'message is required' }, 400)
  }
  if (message.length > 16_000) {
    return c.json({ error: 'message too long (max 16000 characters)' }, 400)
  }

  // Run getPrefs, character load, friendship lookup, locale settings, user protections,
  // and content ceilings (admin + user) in parallel
  const [prefs, charRow, existingRelation, locale, protections, interactionStyle, userCeiling] = await Promise.all([
    loadUserPrefs(user.id),
    characterId
      ? db.select().from(characters).where(eq(characters.id, characterId)).limit(1).then(r => r[0] ?? null)
      : Promise.resolve(null),
    characterId
      ? db.select({ createdAt: userCharacters.createdAt }).from(userCharacters)
          .where(and(eq(userCharacters.userId, user.id), eq(userCharacters.characterId, characterId)))
          .limit(1).then(r => r[0] ?? null)
      : Promise.resolve(null),
    getLocaleSettings(),
    getProtections(user.id),
    getInteractionStyle(user.id),
    getUserCeiling(user.id),
  ])

  // ── Resolve the active content dials ──────────────────────────────────────────
  // The user's ceiling = their assigned content profile (optionally self-lowered).
  // A character runs at its OWN authored config, but is CLAMPED to the user's ceiling
  // per category — it can never exceed what the account permits (rather than being
  // blocked outright).
  const effCeiling = userCeiling
  const charContent = charRow ? parseCharacterContent(charRow.contentDials) : null
  const activeDials: ContentDials = charContent ? clampDials(charContent.dials, effCeiling) : effCeiling
  // Candor is delivery: from the character for a character chat, else the user's style.
  const activeInteractionStyle = charContent
    ? { ...interactionStyle, candor: charContent.candor }
    : interactionStyle
  const maskProfanityActive = activeDials.profanity === 'off'

  if (characterId && charRow) {
    const now = new Date()
    db.insert(userCharacters)
      .values({ id: crypto.randomUUID(), userId: user.id, characterId, createdAt: now })
      .onConflictDoNothing()
      .catch(() => {})
    // On first meeting, write a durable memory so the character naturally recalls it
    if (!existingRelation) {
      const userDisplayName = user.nickname?.trim() || user.firstName?.trim() || 'the user'
      writeFirstMetMemory(user.id, characterId, charRow.name, userDisplayName, now).catch(() => {})
    }
  }

  let model = (prefs['chat_model'] as string | undefined) ?? await getModel()
  // If the user has uncensored LLM blocked, fall back to the default model when
  // their selected model is tagged uncensored in the catalog.
  if (protections.blockUncensoredLlm && model) {
    const catalogEntry = CATALOG.find(m => m.id === model)
    if (catalogEntry && (catalogEntry.role === 'uncensored_llm' || catalogEntry.tags?.includes('uncensored'))) {
      model = await getModel()
    }
  }
  const options: Record<string, unknown> = {
    temperature: (prefs['temperature'] as number | undefined) ?? 0.7,
    num_ctx: (prefs['ctx_limit'] as number | undefined) ?? 8192,
    // NOTE: num_kv_cache_type and flash_attn are load-time model parameters, not
    // per-inference parameters. Setting them here would let Ollama trigger a full
    // model reload on any options mismatch. They belong only in warmupModel().
  }
  // num_predict is a ceiling, not a target — the model stops at natural completion or
  // the cap, whichever comes first. A high default does not slow down short answers.
  options['num_predict'] = (prefs['max_tokens'] as number | undefined) ?? 4096
  if (prefs['seed']) options['seed'] = prefs['seed']

  const characterSystemPrompt = charRow
    ? buildCompanionPrompt({ personalityPrompt: charRow.personalityPrompt, replyStyle: charRow.replyStyle, style: charRow.style, avatarConfig: charRow.avatarConfig })
    : null

  // Resolve or create conversation
  let convId = incomingConvId ?? null
  let convTitle = ''

  if (convId) {
    // Verify ownership
    const [existing] = await db
      .select({ title: conversations.title })
      .from(conversations)
      .where(and(eq(conversations.id, convId), eq(conversations.userId, user.id)))
      .limit(1)
    if (!existing) convId = null  // reset if not found/owned
    else convTitle = existing.title ?? ''
  }

  if (!convId) {
    convId = crypto.randomUUID()
    convTitle = truncateTitle(message)
    await db.insert(conversations).values({
      id: convId,
      userId: user.id,
      characterId: characterId ?? null,
      projectId: projectId ?? null,
      title: convTitle,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  }

  // Persist any newly-attached documents to this conversation. companionTurn loads
  // them by conversation id each turn, so the model can reference them across the chat.
  if (Array.isArray(attachments) && attachments.length > 0) {
    const now = new Date()
    const rows = attachments
      .filter((a) => a?.text?.trim() && a?.filename)
      .slice(0, 5)
      .map((a) => ({
        id: crypto.randomUUID(),
        conversationId: convId!,
        userId: user.id,
        filename: String(a.filename).slice(0, 200),
        text: String(a.text).slice(0, 20_000),
        createdAt: now,
      }))
    if (rows.length) await db.insert(chatDocuments).values(rows).catch(() => {})
  }

  // Load recent messages then trim to a token budget so prefill stays fast.
  // Older context is covered by the episode/memory system injected into the system prompt.
  // Budget: 800 tokens ≈ 3–6 turns. Keeps cold-prefill time reasonable on 12B models
  // (~3s at actual observed rates vs ~6s at 1500 tokens). Long-term context handled by memory.
  const TOKEN_HISTORY_BUDGET = 800
  const dbMessages = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, convId))
    .orderBy(desc(messages.createdAt))
    .limit(40)
  dbMessages.reverse()

  // Drop oldest messages until estimated token count fits the budget.
  // Keep at least 4 messages (2 turns) regardless.
  while (dbMessages.length > 4) {
    const tokens = dbMessages.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0)
    if (tokens <= TOKEN_HISTORY_BUDGET) break
    dbMessages.shift()
  }

  // Generate server-side assistantMessageId so the frontend can correlate across reconnects
  const assistantMessageId = crypto.randomUUID()

  const finalConvId = convId
  const finalConvTitle = convTitle

  // Build the run closure — captures all per-request context
  const run = makeChatRun({
    userId: user.id,
    userRole: user.role,
    userDisplayName: user.nickname?.trim() || user.firstName?.trim() || null,
    model,
    options,
    message,
    characterId: characterId ?? null,
    characterSystemPrompt,
    uiContext: uiContext ?? null,
    clientLat: clientLat ?? null,
    clientLng: clientLng ?? null,
    convId: finalConvId,
    convTitle: finalConvTitle,
    dbMessages,
    prefs,
    assistantMessageId,
    cookieHeader: c.req.header('cookie') ?? '',
    locale,
    protections,
    interactionStyle: activeInteractionStyle,
    activeDials,
    maskProfanityActive,
  })

  let job: genQueue.Job
  try {
    job = genQueue.enqueue({ type: 'chat', userId: user.id, meta: { conversationId: finalConvId, assistantMessageId }, run })
  } catch (err) {
    if (err instanceof genQueue.QueueLimitError) {
      return c.json({ error: 'You have too many requests in progress. Please wait for them to finish.' }, 429)
    }
    throw err
  }

  // Disable proxy buffering — must be set before streamSSE because headers are sent on return.
  c.header('X-Accel-Buffering', 'no')

  return streamSSE(c, async (stream) => {
    // Lead with gen event so the client captures genId + assistantMessageId for reconnect
    await stream.writeSSE({
      event: 'gen',
      data: JSON.stringify({ genId: job.id, conversationId: finalConvId, assistantMessageId }),
    })
    await genQueue.subscribeAndTail(stream, job, 0)
  })
})

// ── Stream resume endpoint (reconnect) ────────────────────────────────────────
// Client sends GET /api/chat/stream/:genId?since=N to reconnect to an in-flight or
// recently completed generation. Returns 404 if the job was GC'd (60s after completion);
// the client should fall back to loadConversation to get the persisted final message.

chat.get('/stream/:genId', requireAuth, async (c) => {
  const user = c.get('user')
  const genId = c.req.param('genId')
  const since = Math.max(0, parseInt(c.req.query('since') ?? '0', 10))

  const job = genQueue.get(genId)
  if (!job) return c.json({ error: 'Generation not found or expired' }, 404)
  if (job.userId !== user.id) return c.json({ error: 'Forbidden' }, 403)

  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    await genQueue.subscribeAndTail(stream, job, since)
  })
})

// ── Cancel an in-flight generation ────────────────────────────────────────────
// Lets the client actually stop server-side generation (and free the queue slot),
// not just drop the SSE connection. Ownership is enforced inside genQueue.cancel.
chat.post('/stream/:genId/cancel', requireAuth, async (c) => {
  const user = c.get('user')
  const genId = c.req.param('genId')
  const ok = genQueue.cancel(genId, user.id)
  return c.json({ ok })
})

// ── Chat run factory ──────────────────────────────────────────────────────────
// Returns a genQueue `run` closure that performs the full chat pipeline.
// ctx.emit() replaces stream.writeSSE() — generation is decoupled from the connection.

interface ChatRunParams {
  userId: string
  userRole: string
  userDisplayName: string | null
  model: string
  options: Record<string, unknown>
  message: string
  characterId: string | null
  characterSystemPrompt: string | null
  uiContext: string | null
  clientLat: number | null
  clientLng: number | null
  convId: string
  convTitle: string
  dbMessages: Array<{ role: string; content: string }>
  prefs: Record<string, unknown>
  assistantMessageId: string
  cookieHeader: string
  locale: import('@/routes/adminLocale').LocaleSettings
  protections: import('@/lib/protections').UserProtections
  interactionStyle: import('@/lib/protections').InteractionStyle
  activeDials: ContentDials
  maskProfanityActive: boolean
}

function makeChatRun(p: ChatRunParams) {
  return async (ctx: JobRunContext): Promise<void> => {
    try {
      // Fire-and-forget: user message doesn't need to be saved before streaming starts
      db.insert(messages).values({
        id: crypto.randomUUID(),
        conversationId: p.convId,
        role: 'user',
        content: p.message,
        createdAt: new Date(),
      }).catch(() => {})

      const history: OllamaChatMessage[] = p.dbMessages.map((m) => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
      }))

      // The generation pipeline (routing → tools/directReply → system prompt →
      // LLM stream) lives in the shared runCompanionTurn so the Pod gateway reuses
      // it verbatim. The route keeps the HTTP concerns: SSE plumbing, persistence,
      // titles, and the `done` event.
      const result = await runCompanionTurn(
        {
          userId: p.userId,
          userRole: p.userRole,
          userDisplayName: p.userDisplayName,
          model: p.model,
          options: p.options,
          message: p.message,
          characterId: p.characterId,
          characterSystemPrompt: p.characterSystemPrompt,
          uiContext: p.uiContext,
          clientLat: p.clientLat,
          clientLng: p.clientLng,
          convId: p.convId,
          history,
          prefs: p.prefs,
          cookieHeader: p.cookieHeader,
          locale: p.locale,
          interactionStyle: p.interactionStyle,
          activeDials: p.activeDials,
          maskProfanityActive: p.maskProfanityActive,
        },
        {
          onToken: (text) => ctx.emit('token', text),
          onEvent: (type, data) => ctx.emit(type, data),
          signal: ctx.signal,
        },
      )

      // Cancelled mid-stream: original behavior persisted nothing and emitted no
      // `done`. Preserve that.
      if (!result.completed) return

      const now = new Date()
      await db.insert(messages).values({
        id: p.assistantMessageId,
        conversationId: p.convId,
        role: 'assistant',
        content: result.text,
        createdAt: now,
      })
      await db
        .update(conversations)
        .set({ updatedAt: now })
        .where(eq(conversations.id, p.convId))

      const finalTitle = p.dbMessages.length === 0
        ? (await generateConversationTitle(p.model, p.message, p.convId)) || p.convTitle
        : p.convTitle
      ctx.emit('done', JSON.stringify({ model: p.model, conversationId: p.convId, title: finalTitle }))

      // Memory extraction is handled out-of-band by the background sweep.
    } catch (err) {
      ctx.emit('error', String(err))
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Ask the LLM to produce a short title for a brand-new conversation.
 * Runs after the main stream finishes (model already warm), so latency is minimal.
 * Returns the generated title, or empty string on failure.
 */
async function generateConversationTitle(model: string, message: string, convId: string): Promise<string> {
  try {
    const res = await ollamaChat(
      model,
      [
        {
          role: 'system',
          content: 'Generate a short 3-5 word title for this conversation. Reply with ONLY the title — no punctuation at the end, no quotes, no explanation.',
        },
        { role: 'user', content: message },
      ],
      undefined,
      { num_predict: 20, temperature: 0.3 },
    )
    const title = res.message.content.trim().replace(/^["']|["']$/g, '').replace(/\.+$/, '')
    if (!title) return ''
    await db.update(conversations).set({ title }).where(eq(conversations.id, convId))
    return title
  } catch {
    return ''
  }
}

function truncateTitle(text: string, maxLen = 50): string {
  let t = text.trim()

  // Strip common filler openers that clutter a title
  t = t.replace(/^(can you |could you |please |help me |i need you to |i want you to |i'd like you to |i'd like to |i would like to )/i, '')

  // Capitalize first letter
  t = t.charAt(0).toUpperCase() + t.slice(1)

  // Cut at the first clause boundary that appears after at least 10 chars
  // (conjunctions and trailing phrases that don't add meaning in a title)
  const clauseRe = /\s+(that I |which I |so that |in order to |for me\b|about |, )/i
  const match = clauseRe.exec(t.slice(10))
  if (match) t = t.slice(0, 10 + match.index).trim()

  // Hard truncate with word boundary
  if (t.length > maxLen) {
    const cut = t.slice(0, maxLen)
    const lastSpace = cut.lastIndexOf(' ')
    t = (lastSpace > 20 ? cut.slice(0, lastSpace) : cut) + '…'
  }

  return t
}

export { chat }
