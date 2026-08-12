import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { eq, desc, and, gt, lt, inArray, isNull, isNotNull, sql } from 'drizzle-orm'
import { db } from '@/db'
import { userCharacters, conversations, messages, messageTraces, chatDocuments, chatDocumentEdits } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { extractText } from '@/lib/rag/ingest'
import { ollamaChat } from '@/llm/ollama'
import type { OllamaChatMessage } from '@/llm/ollama'
import { getFastModel, getVisionModel } from '@/lib/models'
import { writeFirstMetMemory } from '@/lib/friendshipMemory'
import { maskProfanity } from '@/lib/protections'
import { triggerJudgeForConversation } from '@/memory/sweep'
import { hardDeleteConversations } from '@/lib/chatRetention'
import { chunkAndEmbedDocument } from '@/lib/docChunks'
import type { ContentDials } from '@/lib/contentPolicy'
import { runCompanionTurn, resolveTurnContext } from '@/lib/companionTurn'
import { getAppSetting } from '@/lib/settings'
import * as genQueue from '@/lib/genQueue'
import type { JobRunContext } from '@/lib/genQueue'
import { logger } from '@/lib/logger'
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
  // Default list = live conversations. ?filter=archived and ?filter=deleted expose
  // the archive and the 30-day "Recently deleted" bin. Temporary chats never list.
  const filter = c.req.query('filter') ?? 'active'

  const lifecycle =
    filter === 'archived' ? and(isNull(conversations.deletedAt), isNotNull(conversations.archivedAt))
    : filter === 'deleted' ? isNotNull(conversations.deletedAt)
    : and(isNull(conversations.deletedAt), isNull(conversations.archivedAt))

  const conditions = and(
    eq(conversations.userId, user.id),
    eq(conversations.temporary, false),
    lifecycle,
    projectId ? eq(conversations.projectId, projectId) : undefined,
  )

  const rows = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      pinned: conversations.pinned,
      projectId: conversations.projectId,
      archivedAt: conversations.archivedAt,
      deletedAt: conversations.deletedAt,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
      preview: sql<string>`(
        SELECT content FROM messages
        WHERE conversation_id = ${conversations.id} AND active = 1
        ORDER BY created_at DESC LIMIT 1
      )`,
    })
    .from(conversations)
    .where(conditions)
    .orderBy(desc(sql`COALESCE(${conversations.updatedAt}, ${conversations.createdAt})`))

  return c.json(rows)
})

// ── Message search (FTS5) ─────────────────────────────────────────────────────
// Full-text search across the user's own chat history. Visibility enforced here,
// not in the index: active messages only, no deleted or temporary conversations.
chat.get('/search', requireAuth, async (c) => {
  const user = c.get('user')
  const q = (c.req.query('q') ?? '').trim()
  if (!q) return c.json({ results: [] })

  // Quote each term so user input can't inject FTS5 query syntax (AND/OR/NEAR/*).
  const ftsQuery = q
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .map((t) => `"${t.replace(/"/g, '')}"`)
    .join(' ')
  if (!ftsQuery) return c.json({ results: [] })

  try {
    const rows = await db.all<{
      conversationId: string
      messageId: string
      title: string | null
      role: string
      snippet: string
      createdAt: number
    }>(sql`
      SELECT
        m.conversation_id AS conversationId,
        m.id AS messageId,
        c.title AS title,
        m.role AS role,
        snippet(messages_fts, 0, '<mark>', '</mark>', '…', 12) AS snippet,
        m.created_at AS createdAt
      FROM messages_fts f
      JOIN messages m ON m.rowid = f.rowid
      JOIN conversations c ON c.id = m.conversation_id
      WHERE messages_fts MATCH ${ftsQuery}
        AND c.user_id = ${user.id}
        AND c.deleted_at IS NULL
        AND c.temporary = 0
        AND m.active = 1
        AND m.role IN ('user', 'assistant')
      ORDER BY bm25(messages_fts)
      LIMIT 30
    `)
    return c.json({ results: rows })
  } catch (err) {
    logger.warn(`[chat] message search failed: ${err}`)
    return c.json({ results: [] })
  }
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
    .where(and(eq(messages.conversationId, id), eq(messages.active, true)))
    .orderBy(messages.createdAt)

  // Sibling-variant metadata (regenerate keeps the old reply): for each active
  // message in a variant group, report its position among siblings so the UI can
  // render < 2/3 > navigation. Sibling ids are ordered oldest → newest.
  const groupIds = [...new Set(msgs.map((m) => m.variantGroupId).filter((g): g is string => !!g))]
  const variantsByGroup = new Map<string, string[]>()
  if (groupIds.length > 0) {
    const siblings = await db
      .select({ id: messages.id, variantGroupId: messages.variantGroupId })
      .from(messages)
      .where(and(eq(messages.conversationId, id), inArray(messages.variantGroupId, groupIds)))
      .orderBy(messages.createdAt)
    for (const s of siblings) {
      if (!s.variantGroupId) continue
      const list = variantsByGroup.get(s.variantGroupId) ?? []
      list.push(s.id)
      variantsByGroup.set(s.variantGroupId, list)
    }
  }

  // Messages are persisted RAW (masking them in the DB fed `****` back into LLM
  // history and hid the real words from the memory judge). Masking is a READ-time
  // presentation concern, driven by the user's CURRENT dials — raising the dial
  // later unmasks old replies.
  const { maskProfanityActive } = await resolveTurnContext(user.id, conv.characterId ?? null)
  const outMsgs = msgs.map((m) => {
    const content = maskProfanityActive && m.role === 'assistant' ? maskProfanity(m.content) : m.content
    const siblings = m.variantGroupId ? variantsByGroup.get(m.variantGroupId) : undefined
    const variants = siblings && siblings.length > 1
      ? { groupId: m.variantGroupId, index: siblings.indexOf(m.id), count: siblings.length, ids: siblings }
      : undefined
    return { ...m, content, ...(variants ? { variants } : {}) }
  })

  // An in-flight generation for this conversation, so a reopened tab can re-attach
  // to the live stream instead of waiting for a reload to show the persisted reply.
  const activeJob = genQueue.findActiveByMeta('conversationId', id)
  const activeGen = activeJob && activeJob.userId === user.id
    ? { genId: activeJob.id, assistantMessageId: (activeJob.meta?.['assistantMessageId'] as string | undefined) ?? null }
    : null

  return c.json({ ...conv, messages: outMsgs, activeGen })
})

// Soft delete: the conversation moves to "Recently deleted" (restorable) and is
// hard-purged by the maintenance sweep after 30 days. The memory judge still runs
// on the unprocessed span NOW — deleting used to be the moment facts were lost —
// and memoryProcessedThrough advances so the background sweep never double-judges
// the same span while the row sits in the bin.
chat.delete('/conversations/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')

  const [conv] = await db
    .select({ userId: conversations.userId, memoryProcessedThrough: conversations.memoryProcessedThrough, temporary: conversations.temporary })
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, user.id)))
    .limit(1)
  if (!conv) return c.json({ ok: true })

  // Temporary chats were never meant to persist — hard delete, no memory judge.
  if (conv.temporary) {
    await hardDeleteConversations([id])
    return c.json({ ok: true })
  }

  const processedThrough = conv.memoryProcessedThrough?.getTime() ?? 0
  const unprocessed = await db
    .select({ role: messages.role, content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, id),
        eq(messages.active, true),
        processedThrough > 0 ? gt(messages.createdAt, new Date(processedThrough)) : undefined,
      ),
    )
    .orderBy(messages.createdAt)
    .limit(60)

  await db
    .update(conversations)
    .set({ deletedAt: new Date(), memoryProcessedThrough: new Date() })
    .where(and(eq(conversations.id, id), eq(conversations.userId, user.id)))

  if (unprocessed.length >= 2) {
    triggerJudgeForConversation(id, user.id, null, unprocessed.map((m) => ({ role: m.role, content: m.content })))
      .catch(() => {})
  }

  return c.json({ ok: true })
})

// Restore from "Recently deleted".
chat.post('/conversations/:id/restore', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  await db
    .update(conversations)
    .set({ deletedAt: null })
    .where(and(eq(conversations.id, id), eq(conversations.userId, user.id)))
  return c.json({ ok: true })
})

chat.patch('/conversations/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json() as { title?: string; pinned?: boolean; archived?: boolean }

  const update: Record<string, unknown> = {}
  if (body.title !== undefined) update['title'] = body.title
  if (body.pinned !== undefined) update['pinned'] = body.pinned
  if (body.archived !== undefined) update['archivedAt'] = body.archived ? new Date() : null

  if (Object.keys(update).length === 0) return c.json({ ok: true })

  await db
    .update(conversations)
    .set(update)
    .where(and(eq(conversations.id, id), eq(conversations.userId, user.id)))

  return c.json({ ok: true })
})

// ── Export ────────────────────────────────────────────────────────────────────
// Download one conversation as markdown or JSON. Active messages only — the export
// should read like the chat did, not include discarded variants.
chat.get('/conversations/:id/export', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const format = c.req.query('format') === 'json' ? 'json' : 'md'

  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, user.id)))
    .limit(1)
  if (!conv) return c.json({ error: 'Not found' }, 404)

  const msgs = await db
    .select({ role: messages.role, content: messages.content, createdAt: messages.createdAt, model: messages.model })
    .from(messages)
    .where(and(eq(messages.conversationId, id), eq(messages.active, true)))
    .orderBy(messages.createdAt)

  const title = conv.title || 'Conversation'
  const safeName = title.replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'conversation'

  if (format === 'json') {
    c.header('Content-Type', 'application/json; charset=utf-8')
    c.header('Content-Disposition', `attachment; filename="${safeName}.json"`)
    return c.body(JSON.stringify({
      title,
      createdAt: conv.createdAt,
      exportedAt: new Date(),
      messages: msgs.map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt, model: m.model ?? undefined })),
    }, null, 2))
  }

  const lines: string[] = [`# ${title}`, '', `Exported ${new Date().toISOString().slice(0, 10)}`, '']
  for (const m of msgs) {
    if (m.role === 'system') continue
    lines.push(`## ${m.role === 'user' ? 'You' : 'Companion'}`, '', m.content, '')
  }
  c.header('Content-Type', 'text/markdown; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="${safeName}.md"`)
  return c.body(lines.join('\n'))
})

// ── Message feedback ──────────────────────────────────────────────────────────
// Thumbs up/down on an assistant reply (rating null clears it). The optional note
// travels with a thumbs-down. Joined to message_traces by message id, so feedback
// carries its full turn context for later triage.
chat.post('/messages/:id/feedback', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({})) as { rating?: 'up' | 'down' | null; note?: string }
  if (body.rating !== 'up' && body.rating !== 'down' && body.rating !== null) {
    return c.json({ error: 'rating must be "up", "down", or null' }, 400)
  }

  const [row] = await db
    .select({ id: messages.id, userId: conversations.userId, role: messages.role })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(messages.id, id))
    .limit(1)
  if (!row || row.userId !== user.id) return c.json({ error: 'Not found' }, 404)
  if (row.role !== 'assistant') return c.json({ error: 'Feedback applies to assistant replies' }, 400)

  await db.update(messages).set({
    feedback: body.rating,
    feedbackNote: body.rating ? (body.note ?? '').slice(0, 2000) || null : null,
  }).where(eq(messages.id, id))

  return c.json({ ok: true })
})

// ── Variant switching ─────────────────────────────────────────────────────────
// Regenerate keeps the previous reply as an inactive sibling (same variantGroupId).
// This endpoint flips which sibling is active — the UI's < 2/3 > navigation.
chat.post('/conversations/:id/variant', requireAuth, async (c) => {
  const user = c.get('user')
  const convId = c.req.param('id')
  const { messageId } = await c.req.json().catch(() => ({})) as { messageId?: string }
  if (!messageId) return c.json({ error: 'messageId is required' }, 400)

  const [conv] = await db
    .select({ id: conversations.id, characterId: conversations.characterId })
    .from(conversations)
    .where(and(eq(conversations.id, convId), eq(conversations.userId, user.id)))
    .limit(1)
  if (!conv) return c.json({ error: 'Not found' }, 404)

  const [target] = await db
    .select({ id: messages.id, variantGroupId: messages.variantGroupId, content: messages.content, role: messages.role })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, convId)))
    .limit(1)
  if (!target?.variantGroupId) return c.json({ error: 'Not a variant message' }, 404)

  if (genQueue.findActiveByMeta('conversationId', convId)) {
    return c.json({ error: 'A reply is being generated in this conversation. Wait for it to finish first.' }, 429)
  }

  await db.update(messages)
    .set({ active: false })
    .where(and(eq(messages.conversationId, convId), eq(messages.variantGroupId, target.variantGroupId)))
  await db.update(messages)
    .set({ active: true })
    .where(eq(messages.id, messageId))

  const { maskProfanityActive } = await resolveTurnContext(user.id, conv.characterId ?? null)
  const content = maskProfanityActive && target.role === 'assistant' ? maskProfanity(target.content) : target.content
  return c.json({ ok: true, messageId, content })
})

// ── Stream endpoint ───────────────────────────────────────────────────────────

chat.post('/stream', requireAuth, async (c) => {
  const user = c.get('user')

  const { message, conversationId: incomingConvId, characterId, uiContext, projectId, clientLat, clientLng, clientTz, attachments, images, focusedArtifact, temporary } = (await c.req.json()) as {
    message: string
    conversationId?: string
    characterId?: string
    uiContext?: string | null
    projectId?: string
    clientLat?: number | null
    clientLng?: number | null
    clientTz?: string | null
    attachments?: { filename: string; text: string }[]
    /** Start this conversation as a temporary (incognito) chat: never listed,
     *  never summarized, never swept into memory, purged on boot/daily. Only
     *  honored at creation time — an existing conversation keeps its mode. */
    temporary?: boolean
    /** Base64 photos for a vision turn (the iPhone app's camera/library
     *  attachments — "translate the street sign"). Routed to the vision
     *  model; companionTurn attaches them to the user message. */
    images?: string[]
    /** The Canvas artifact open in this chat, so an edit-style message targets it. */
    focusedArtifact?: { id: string; type: 'code' | 'document' | 'html'; title: string } | null
  }

  // Validate the message before it flows into the token budget / title generation.
  if (typeof message !== 'string' || message.trim().length === 0) {
    return c.json({ error: 'message is required' }, 400)
  }
  if (message.length > 16_000) {
    return c.json({ error: 'message too long (max 16000 characters)' }, 400)
  }

  const [ctx, existingRelation] = await Promise.all([
    resolveTurnContext(user.id, characterId ?? null),
    characterId
      ? db.select({ createdAt: userCharacters.createdAt }).from(userCharacters)
          .where(and(eq(userCharacters.userId, user.id), eq(userCharacters.characterId, characterId)))
          .limit(1).then(r => r[0] ?? null)
      : Promise.resolve(null),
  ])
  const { prefs, charRow, characterSystemPrompt, model, options, activeDials, interactionStyle: activeInteractionStyle, maskProfanityActive, locale, protections } = ctx

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

  // Resolve or create conversation
  let convId = incomingConvId ?? null
  let convTitle = ''

  let convSummary: string | null = null
  let convTemporary = false
  let convProjectId: string | null = projectId ?? null
  if (convId) {
    // Verify ownership
    const [existing] = await db
      .select({ title: conversations.title, summary: conversations.summary, temporary: conversations.temporary, projectId: conversations.projectId })
      .from(conversations)
      .where(and(eq(conversations.id, convId), eq(conversations.userId, user.id)))
      .limit(1)
    if (!existing) convId = null  // reset if not found/owned
    else { convTitle = existing.title ?? ''; convSummary = existing.summary; convTemporary = existing.temporary; convProjectId = existing.projectId }
  }

  if (!convId) {
    convId = crypto.randomUUID()
    convTitle = truncateTitle(message)
    convTemporary = temporary === true
    await db.insert(conversations).values({
      id: convId,
      userId: user.id,
      characterId: characterId ?? null,
      projectId: projectId ?? null,
      title: convTitle,
      temporary: convTemporary,
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
    if (rows.length) {
      await db.insert(chatDocuments).values(rows).catch(() => {})
      // Chunk + embed detached so questions against oversized documents retrieve
      // the relevant parts instead of hitting the head-truncation cliff.
      for (const row of rows) void chunkAndEmbedDocument(row)
    }
  }

  // Load recent messages then trim to a token budget so prefill stays fast.
  // Older context is covered by the episode/memory system injected into the system prompt.
  // Budget: 1200 tokens ≈ 5–9 turns — the documented ceiling before prefill delay is
  // perceptible on 12B models (chat-latency.md). Raised from 800 (2026-08): follow-ups
  // referencing 4+ turns back were falling out of the window before the rolling summary
  // covered them. trimHistory always keeps the newest 4 messages regardless, so the
  // last full exchange is never trimmed. Long-term context handled by memory.
  const TOKEN_HISTORY_BUDGET = 1200
  const dbRows = await db
    .select({ role: messages.role, content: messages.content, toolNote: messages.toolNote })
    .from(messages)
    .where(and(eq(messages.conversationId, convId), eq(messages.active, true)))
    .orderBy(desc(messages.createdAt))
    .limit(40)
  dbRows.reverse()
  // Fold each reply's tool note back in so follow-ups ("tell me more") elaborate
  // on the actual tool data instead of re-searching or deflecting.
  const dbMessages = foldToolNotes(dbRows)

  const droppedFromWindow = trimHistory(dbMessages, TOKEN_HISTORY_BUDGET)
  // The summary only earns its prompt tokens once the live window is incomplete.
  const historyIncomplete = droppedFromWindow > 0 || dbRows.length >= 40

  // Serialize turns per conversation: a second submit while one is generating
  // would snapshot history without the in-flight reply and interleave answers.
  if (genQueue.findActiveByMeta('conversationId', convId)) {
    return c.json({ error: 'A reply is already being generated in this conversation. Wait for it to finish (or stop it) first.' }, 429)
  }

  // Generate server-side assistantMessageId so the frontend can correlate across reconnects
  const assistantMessageId = crypto.randomUUID()

  const finalConvId = convId
  const finalConvTitle = convTitle

  // Vision turns swap to the vision-capable model; oversized or non-string
  // entries are dropped rather than erroring (a phone should never brick a
  // send by attaching too much).
  const visionImages = (Array.isArray(images) ? images : [])
    .filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 12_000_000)
    .slice(0, 4)
  const turnModel = visionImages.length ? await getVisionModel() : model

  // Build the run closure — captures all per-request context
  const run = makeChatRun({
    userId: user.id,
    userRole: user.role,
    userDisplayName: user.nickname?.trim() || user.firstName?.trim() || null,
    model: turnModel,
    images: visionImages.length ? visionImages : undefined,
    options,
    message,
    characterId: characterId ?? null,
    characterSystemPrompt,
    uiContext: uiContext ?? null,
    clientLat: clientLat ?? null,
    clientLng: clientLng ?? null,
    clientTz: clientTz ?? null,
    convId: finalConvId,
    convTitle: finalConvTitle,
    dbMessages,
    prefs,
    // null = first meeting (relation row is being created right now); the
    // relationship-stage line in the system prompt derives from this.
    firstMetAt: characterId ? (existingRelation?.createdAt ?? null) : undefined,
    conversationSummary: historyIncomplete ? convSummary : null,
    projectId: convProjectId,
    focusedArtifact: focusedArtifact ?? null,
    // Refresh the rolling summary after this turn when the conversation is long
    // enough for the window to be (or soon be) incomplete. Never for temporary
    // chats — nothing derived from them should persist beyond the session.
    maybeSummarize: dbRows.length >= 16 && !convTemporary,
    temporary: convTemporary,
    // Window already dropping messages → tighten the refresh cadence so no band of
    // conversation sits in neither the live window nor the summary.
    windowIncomplete: historyIncomplete,
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

// ── KV prime endpoint ────────────────────────────────────────────────────────
// Fired by the frontend when a chat surface opens or the active conversation
// changes: runs the one-brain pipeline in primeOnly mode so Ollama prefills the
// system-prompt + history prefix while the user is still typing. The real turn
// then only pays prefill for the newly typed message (measured: ~2s → ~0.3s to
// first token on a fresh conversation). Best-effort and detached — the response
// returns immediately; a failed prime only costs the optimization.
const primeInFlight = new Set<string>()
chat.post('/prime', requireAuth, async (c) => {
  const user = c.get('user')
  // One prime per user at a time — browsing the conversation list mustn't queue a
  // pile of full prefill passes on the single runner slot ahead of a real turn.
  if (primeInFlight.has(user.id)) return c.json({ ok: false, skipped: 'in-flight' })

  const body = await c.req.json().catch(() => ({}))
  const { conversationId, characterId, uiContext, clientLat, clientLng, clientTz, reason } = body as {
    conversationId?: string
    characterId?: string
    uiContext?: string | null
    clientLat?: number | null
    clientLng?: number | null
    clientTz?: string | null
    reason?: string
  }

  // The wake-time prime (reason:'wake') is OFF by default: on a single-runner Ollama
  // box it can occupy the slot right as the spoken turn arrives, so a quick "hi"
  // queues behind the prefill and answers LATER than with no prime at all. Opt in via
  // `voice.wake_prime_enabled` once measured. The conversation-open prime (no reason)
  // is unaffected — it fires while the user is idle, not racing a turn.
  if (reason === 'wake' && (await getAppSetting('voice.wake_prime_enabled')) !== true) {
    return c.json({ ok: false, skipped: 'wake-prime-disabled' })
  }

  const [ctx, existingRelation] = await Promise.all([
    resolveTurnContext(user.id, characterId ?? null),
    characterId
      ? db.select({ createdAt: userCharacters.createdAt }).from(userCharacters)
          .where(and(eq(userCharacters.userId, user.id), eq(userCharacters.characterId, characterId)))
          .limit(1).then(r => r[0] ?? null)
      : Promise.resolve(null),
  ])

  // Existing conversation: assemble the SAME trimmed history the stream route
  // would, so the primed prompt token-matches the upcoming real turn.
  let convId: string | null = null
  let convSummary: string | null = null
  let convProjectId: string | null = null
  let historyIncomplete = false
  let dbMessages: { role: string; content: string }[] = []
  if (conversationId) {
    const [existing] = await db
      .select({ summary: conversations.summary, projectId: conversations.projectId })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)))
      .limit(1)
    if (existing) {
      convId = conversationId
      convSummary = existing.summary
      convProjectId = existing.projectId
      // A generation is already running here — its reply will change history, and
      // the prime would fight it for the runner slot. Skip.
      if (genQueue.findActiveByMeta('conversationId', convId)) return c.json({ ok: false, skipped: 'generating' })
      const dbRows = await db
        .select({ role: messages.role, content: messages.content, toolNote: messages.toolNote })
        .from(messages)
        .where(and(eq(messages.conversationId, convId), eq(messages.active, true)))
        .orderBy(desc(messages.createdAt))
        .limit(40)
      dbRows.reverse()
      dbMessages = foldToolNotes(dbRows)
      const droppedFromWindow = trimHistory(dbMessages, 1200)
      historyIncomplete = droppedFromWindow > 0 || dbRows.length >= 40
    }
  }

  const history: OllamaChatMessage[] = dbMessages.map((m) => ({
    role: m.role as 'user' | 'assistant' | 'system',
    content: m.content,
  }))
  const cookieHeader = c.req.header('cookie') ?? ''

  primeInFlight.add(user.id)
  void runCompanionTurn(
    {
      userId: user.id,
      userRole: user.role,
      userDisplayName: user.nickname?.trim() || user.firstName?.trim() || null,
      model: ctx.model,
      options: ctx.options,
      message: '',
      characterId: characterId ?? null,
      characterSystemPrompt: ctx.characterSystemPrompt,
      uiContext: uiContext ?? null,
      clientLat: clientLat ?? null,
      clientLng: clientLng ?? null,
      clientTz: clientTz ?? null,
      // Synthetic id for a not-yet-created conversation: only used as the
      // memory-cache key (prime doesn't write it) and the docs query (none exist).
      convId: convId ?? `prime:${user.id}`,
      history,
      prefs: ctx.prefs,
      firstMetAt: characterId ? (existingRelation?.createdAt ?? null) : undefined,
      conversationSummary: historyIncomplete ? convSummary : null,
      // The project-instructions block sits in the STABLE prefix — the prime must
      // include it or the primed prefill never matches the real turn's prompt.
      projectId: convProjectId,
      cookieHeader,
      locale: ctx.locale,
      interactionStyle: ctx.interactionStyle,
      activeDials: ctx.activeDials,
      maskProfanityActive: ctx.maskProfanityActive,
      includeDocs: !!convId,
      primeOnly: true,
    },
    { onToken: () => {}, signal: { aborted: false } },
  ).catch(() => { /* best-effort */ }).finally(() => primeInFlight.delete(user.id))

  return c.json({ ok: true })
})

// ── Regenerate endpoint ─────────────────────────────────────────────────────
// Re-runs the turn that produced `assistantMessageId`: streams a fresh reply for the
// SAME user turn rather than resubmitting it as a new one (which would duplicate the
// question in history). The old reply is KEPT as an inactive sibling variant (shared
// variantGroupId) once the new one completes — see makeChatRun's replaceMessageId
// handling — so the UI can flip between attempts with < 2/3 > navigation.

chat.post('/regenerate', requireAuth, async (c) => {
  const user = c.get('user')
  const { conversationId, assistantMessageId } = (await c.req.json().catch(() => ({}))) as {
    conversationId?: string
    assistantMessageId?: string
  }
  if (!conversationId || !assistantMessageId) {
    return c.json({ error: 'conversationId and assistantMessageId are required' }, 400)
  }

  const [conv] = await db
    .select({ id: conversations.id, title: conversations.title, characterId: conversations.characterId, projectId: conversations.projectId })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)))
    .limit(1)
  if (!conv) return c.json({ error: 'conversation not found' }, 404)

  // Full ACTIVE turn order to find the user message this reply answered (inactive
  // siblings/branches are not part of the live history).
  const all = await db
    .select({ id: messages.id, role: messages.role, content: messages.content, toolNote: messages.toolNote, variantGroupId: messages.variantGroupId })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.active, true)))
    .orderBy(messages.createdAt)
  const targetIdx = all.findIndex((m) => m.id === assistantMessageId && m.role === 'assistant')
  const userMsg = targetIdx > 0 ? all[targetIdx - 1] : undefined
  if (targetIdx < 0 || !userMsg || userMsg.role !== 'user') {
    return c.json({ error: 'could not find the turn to regenerate' }, 404)
  }

  if (genQueue.findActiveByMeta('conversationId', conversationId)) {
    return c.json({ error: 'A reply is already being generated in this conversation. Wait for it to finish (or stop it) first.' }, 429)
  }

  const characterId = conv.characterId
  const [{ prefs, characterSystemPrompt, model, options, activeDials, interactionStyle, maskProfanityActive, locale, protections }, regenRelation] =
    await Promise.all([
      resolveTurnContext(user.id, characterId),
      characterId
        ? db.select({ createdAt: userCharacters.createdAt }).from(userCharacters)
            .where(and(eq(userCharacters.userId, user.id), eq(userCharacters.characterId, characterId)))
            .limit(1).then(r => r[0] ?? null)
        : Promise.resolve(null),
    ])

  const dbMessages = foldToolNotes(all.slice(0, targetIdx - 1))
  trimHistory(dbMessages, 1200)

  // The old reply becomes an inactive sibling in this group; the new reply joins it.
  const variantGroupId = all[targetIdx]!.variantGroupId ?? crypto.randomUUID()

  const newAssistantMessageId = crypto.randomUUID()
  const run = makeChatRun({
    userId: user.id,
    userRole: user.role,
    userDisplayName: user.nickname?.trim() || user.firstName?.trim() || null,
    model,
    options,
    message: userMsg.content,
    characterId,
    characterSystemPrompt,
    uiContext: null,
    clientLat: null,
    clientLng: null,
    convId: conversationId,
    convTitle: conv.title ?? '',
    dbMessages,
    prefs,
    firstMetAt: characterId ? (regenRelation?.createdAt ?? null) : undefined,
    projectId: conv.projectId,
    assistantMessageId: newAssistantMessageId,
    cookieHeader: c.req.header('cookie') ?? '',
    locale,
    protections,
    interactionStyle,
    activeDials,
    maskProfanityActive,
    insertUserMessage: false,
    replaceMessageId: assistantMessageId,
    variantGroupId,
  })

  let job: genQueue.Job
  try {
    job = genQueue.enqueue({ type: 'chat', userId: user.id, meta: { conversationId, assistantMessageId: newAssistantMessageId }, run })
  } catch (err) {
    if (err instanceof genQueue.QueueLimitError) {
      return c.json({ error: 'You have too many requests in progress. Please wait for them to finish.' }, 429)
    }
    throw err
  }

  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: 'gen',
      data: JSON.stringify({ genId: job.id, conversationId, assistantMessageId: newAssistantMessageId, replacesMessageId: assistantMessageId }),
    })
    await genQueue.subscribeAndTail(stream, job, 0)
  })
})

// ── Edit-and-resubmit endpoint ────────────────────────────────────────────────
// Rewrites a past USER message and re-runs the turn from there. History stays
// linear (no branch navigation), but nothing is destroyed anymore: the original
// message text is preserved as an inactive copy and the discarded tail is marked
// inactive rather than deleted, so an edit is recoverable from the DB. A fresh
// reply then streams with the same SSE protocol as /stream.

chat.post('/edit', requireAuth, async (c) => {
  const user = c.get('user')
  const { conversationId, userMessageId, newText } = (await c.req.json().catch(() => ({}))) as {
    conversationId?: string
    userMessageId?: string
    newText?: string
  }
  if (!conversationId || !userMessageId) {
    return c.json({ error: 'conversationId and userMessageId are required' }, 400)
  }
  if (typeof newText !== 'string' || newText.trim().length === 0) {
    return c.json({ error: 'newText is required' }, 400)
  }
  if (newText.length > 16_000) {
    return c.json({ error: 'message too long (max 16000 characters)' }, 400)
  }

  const [conv] = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      characterId: conversations.characterId,
      summaryThrough: conversations.summaryThrough,
      projectId: conversations.projectId,
    })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)))
    .limit(1)
  if (!conv) return c.json({ error: 'conversation not found' }, 404)

  const all = await db
    .select({ id: messages.id, role: messages.role, content: messages.content, toolNote: messages.toolNote, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.active, true)))
    .orderBy(messages.createdAt)
  const targetIdx = all.findIndex((m) => m.id === userMessageId && m.role === 'user')
  if (targetIdx < 0) return c.json({ error: 'could not find the message to edit' }, 404)
  const target = all[targetIdx]!

  if (genQueue.findActiveByMeta('conversationId', conversationId)) {
    return c.json({ error: 'A reply is already being generated in this conversation. Wait for it to finish (or stop it) first.' }, 429)
  }

  const characterId = conv.characterId
  const [{ prefs, characterSystemPrompt, model, options, activeDials, interactionStyle, maskProfanityActive, locale, protections }, editRelation] =
    await Promise.all([
      resolveTurnContext(user.id, characterId),
      characterId
        ? db.select({ createdAt: userCharacters.createdAt }).from(userCharacters)
            .where(and(eq(userCharacters.userId, user.id), eq(userCharacters.characterId, characterId)))
            .limit(1).then(r => r[0] ?? null)
        : Promise.resolve(null),
    ])

  // Commit the edit: preserve the ORIGINAL text as an inactive copy (same
  // timestamp — display and history only ever read active rows, so ordering
  // ambiguity can't surface), rewrite the user message in place, then mark
  // everything after it inactive. The discarded tail answered a question that
  // no longer exists, but it stays recoverable instead of being destroyed.
  // The rolling summary is invalidated if it covered any of the edited span
  // (it would keep "remembering" turns that no longer happened).
  await db.insert(messages).values({
    id: crypto.randomUUID(),
    conversationId,
    role: 'user',
    content: target.content,
    active: false,
    createdAt: target.createdAt,
  }).catch(() => {})
  await db.update(messages).set({ content: newText.trim() }).where(eq(messages.id, userMessageId))
  const removedIds = all.slice(targetIdx + 1).map((m) => m.id)
  if (removedIds.length > 0) {
    await db.update(messages).set({ active: false }).where(inArray(messages.id, removedIds))
  }
  if (conv.summaryThrough && conv.summaryThrough.getTime() >= target.createdAt.getTime()) {
    await db.update(conversations)
      .set({ summary: null, summaryThrough: null })
      .where(eq(conversations.id, conversationId))
  }

  const dbMessages = foldToolNotes(all.slice(0, targetIdx))
  trimHistory(dbMessages, 1200)

  const newAssistantMessageId = crypto.randomUUID()
  const run = makeChatRun({
    userId: user.id,
    userRole: user.role,
    userDisplayName: user.nickname?.trim() || user.firstName?.trim() || null,
    model,
    options,
    message: newText.trim(),
    characterId,
    characterSystemPrompt,
    uiContext: null,
    clientLat: null,
    clientLng: null,
    convId: conversationId,
    convTitle: conv.title ?? '',
    dbMessages,
    prefs,
    firstMetAt: characterId ? (editRelation?.createdAt ?? null) : undefined,
    projectId: conv.projectId,
    assistantMessageId: newAssistantMessageId,
    cookieHeader: c.req.header('cookie') ?? '',
    locale,
    protections,
    interactionStyle,
    activeDials,
    maskProfanityActive,
    // The edited user message already exists (we just rewrote it in place).
    insertUserMessage: false,
  })

  let job: genQueue.Job
  try {
    job = genQueue.enqueue({ type: 'chat', userId: user.id, meta: { conversationId, assistantMessageId: newAssistantMessageId }, run })
  } catch (err) {
    if (err instanceof genQueue.QueueLimitError) {
      return c.json({ error: 'You have too many requests in progress. Please wait for them to finish.' }, 429)
    }
    throw err
  }

  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: 'gen',
      data: JSON.stringify({ genId: job.id, conversationId, assistantMessageId: newAssistantMessageId }),
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
  /** Base64 photos for a vision turn; model is already the vision model. */
  images?: string[]
  options: Record<string, unknown>
  message: string
  characterId: string | null
  characterSystemPrompt: string | null
  uiContext: string | null
  clientLat: number | null
  clientLng: number | null
  clientTz?: string | null
  convId: string
  convTitle: string
  dbMessages: Array<{ role: string; content: string }>
  prefs: Record<string, unknown>
  /** When the user first met this character (null = first meeting; undefined = not resolved). */
  firstMetAt?: Date | null
  /** Rolling summary of content older than the trimmed window (null = don't inject). */
  conversationSummary?: string | null
  /** Project this conversation is filed under — injects instructions + doc RAG. */
  projectId?: string | null
  /** Refresh the rolling summary (detached) after this turn completes. */
  maybeSummarize?: boolean
  /** The live history window is already dropping messages — refresh the summary on a
   *  tighter cadence so dropped turns are never uncovered (see refreshConversationSummary). */
  windowIncomplete?: boolean
  assistantMessageId: string
  cookieHeader: string
  locale: import('@/routes/adminLocale').LocaleSettings
  protections: import('@/lib/protections').UserProtections
  interactionStyle: import('@/lib/protections').InteractionStyle
  activeDials: ContentDials
  maskProfanityActive: boolean
  /** The Canvas artifact open in this chat (edit-style messages target it). */
  focusedArtifact?: { id: string; type: 'code' | 'document' | 'html'; title: string } | null
  /** false for /regenerate — the user turn already exists in the DB, don't re-insert it. */
  insertUserMessage?: boolean
  /** /regenerate only — the old assistant reply to DEACTIVATE (kept as a sibling
   *  variant) once the new one lands. Left alone on failure/cancellation, so a
   *  failed regenerate doesn't lose the prior answer. */
  replaceMessageId?: string
  /** /regenerate only — the variant group shared by the old and new replies. */
  variantGroupId?: string
  /** Temporary (incognito) conversation — skip the turn trace and title generation. */
  temporary?: boolean
}

/** Newest-N cap for message_traces (devtools trace inspector). Pruned after each
 *  write so the table never grows unbounded — each row can carry an ~8KB prompt. */
const TRACE_KEEP = 500

function makeChatRun(p: ChatRunParams) {
  return async (ctx: JobRunContext): Promise<void> => {
    try {
      if (p.insertUserMessage !== false) {
        // Awaited: ~1ms on SQLite, and a silently-failed insert would lose the
        // user's turn from history while the reply still persisted against it.
        await db.insert(messages).values({
          id: crypto.randomUUID(),
          conversationId: p.convId,
          role: 'user',
          content: p.message,
          createdAt: new Date(),
        })
      }

      const history: OllamaChatMessage[] = p.dbMessages.map((m) => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
      }))

      // Capture the citation sources emitted during the turn so they persist with the
      // assistant message and tappable chips survive a reload (#8). The 'sources' event
      // payload is already a JSON string of Source[]; the frontend replaces on each event
      // (last-wins), so persisting the last one mirrors the live view exactly.
      let capturedSources: string | null = null

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
          images: p.images,
          options: p.options,
          message: p.message,
          characterId: p.characterId,
          characterSystemPrompt: p.characterSystemPrompt,
          uiContext: p.uiContext,
          clientLat: p.clientLat,
          clientLng: p.clientLng,
          clientTz: p.clientTz ?? null,
          convId: p.convId,
          history,
          prefs: p.prefs,
          firstMetAt: p.firstMetAt,
          conversationSummary: p.conversationSummary ?? null,
          projectId: p.projectId ?? null,
          focusedArtifact: p.focusedArtifact ?? null,
          cookieHeader: p.cookieHeader,
          locale: p.locale,
          interactionStyle: p.interactionStyle,
          activeDials: p.activeDials,
          maskProfanityActive: p.maskProfanityActive,
        },
        {
          onToken: (text) => ctx.emit('token', text),
          onEvent: (type, data) => {
            if (type === 'sources') capturedSources = data
            ctx.emit(type, data)
          },
          signal: ctx.signal,
        },
      )

      // Cancelled or errored mid-stream: persist the PARTIAL text (marked
      // truncated) so it survives a reload instead of silently vanishing.
      // Regenerates are the exception — the old reply is still in place, and
      // adding a partial second answer would duplicate the turn.
      if (!result.completed) {
        if (result.text.trim() && !p.replaceMessageId) {
          const now = new Date()
          await db.insert(messages).values({
            id: p.assistantMessageId,
            conversationId: p.convId,
            role: 'assistant',
            content: result.text,
            truncated: true,
            sources: capturedSources,
            createdAt: now,
          }).catch(() => {})
          await db.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, p.convId)).catch(() => {})
        }
        if (result.error) {
          logger.error(`[chat] stream error conv=${p.convId}: ${result.error}`)
          ctx.emit('error', 'The reply was interrupted. The partial response has been saved.')
        } else {
          // Explicit user cancel — settle the client with a done variant so the
          // partial text stays on screen and survives reload.
          ctx.emit('done', JSON.stringify({ model: p.model, conversationId: p.convId, title: p.convTitle, truncated: true }))
        }
        return
      }

      // Regenerate: the old reply becomes an inactive sibling in the variant group
      // (previously it was deleted — non-destructive regenerate keeps every attempt).
      if (p.replaceMessageId) {
        await db.update(messages)
          .set({ active: false, variantGroupId: p.variantGroupId ?? null })
          .where(eq(messages.id, p.replaceMessageId))
      }

      const now = new Date()
      await db.insert(messages).values({
        id: p.assistantMessageId,
        conversationId: p.convId,
        role: 'assistant',
        content: result.text,
        toolNote: result.toolNote ?? null,
        sources: capturedSources,
        // A reply that hit the num_predict cap is a form of truncation too.
        truncated: result.capped ?? false,
        variantGroupId: p.variantGroupId ?? null,
        model: p.model,
        promptTokens: result.promptTokens ?? null,
        genTokens: result.genTokens ?? null,
        durationMs: result.durationMs ?? null,
        createdAt: now,
      })
      await db
        .update(conversations)
        .set({ updatedAt: now })
        .where(eq(conversations.id, p.convId))

      // Turn trace for the devtools inspector: the exact assembled prompt, route
      // decision, and tool trail behind this reply. Skipped for temporary chats
      // (incognito means no debug residue either). Best-effort + pruned.
      if (!p.temporary) {
        void writeTurnTrace({
          messageId: p.assistantMessageId,
          conversationId: p.convId,
          userId: p.userId,
          model: p.model,
          result,
        })
      }

      // First turn: emit `done` immediately with the provisional title and generate
      // the real one DETACHED on the fast model — title generation used to hold the
      // UI in "generating" through an entire extra LLM call. The conversations list
      // picks the final title up from the DB on its next refresh.
      ctx.emit('done', JSON.stringify({ model: p.model, conversationId: p.convId, title: p.convTitle }))
      if (p.dbMessages.length === 0 && !p.temporary) {
        getFastModel()
          .then((fastModel) => generateConversationTitle(fastModel, p.message, p.convId))
          .catch(() => {})
      }
      if (p.maybeSummarize) {
        refreshConversationSummary(p.convId, p.windowIncomplete ?? false).catch((err) => logger.warn(`[chat] summary refresh failed: ${err}`))
      }

      // Memory extraction is handled out-of-band by the background sweep.
    } catch (err) {
      // Never leak internal error text into a chat bubble.
      logger.error(`[chat] turn failed conv=${p.convId}: ${err}`)
      ctx.emit('error', 'Something went wrong generating a reply. Please try again.')
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Persist a per-turn trace row and prune the table to the newest TRACE_KEEP. */
async function writeTurnTrace(t: {
  messageId: string
  conversationId: string
  userId: string
  model: string
  result: import('@/lib/companionTurn').CompanionTurnResult
}): Promise<void> {
  try {
    await db.insert(messageTraces).values({
      id: crypto.randomUUID(),
      messageId: t.messageId,
      conversationId: t.conversationId,
      userId: t.userId,
      route: t.result.routeInfo ? JSON.stringify(t.result.routeInfo) : null,
      toolTrail: t.result.toolTrail?.length ? JSON.stringify(t.result.toolTrail) : null,
      systemPrompt: t.result.systemPrompt ?? null,
      model: t.model,
      promptTokens: t.result.promptTokens ?? null,
      genTokens: t.result.genTokens ?? null,
      durationMs: t.result.durationMs ?? null,
      firstTokenMs: t.result.firstTokenMs ?? null,
      createdAt: new Date(),
    })
    await db.run(sql`
      DELETE FROM message_traces WHERE id IN (
        SELECT id FROM message_traces ORDER BY created_at DESC LIMIT -1 OFFSET ${TRACE_KEEP}
      )
    `)
  } catch (err) {
    logger.warn(`[chat] trace write failed: ${err}`)
  }
}


/** Fold each reply's persisted toolNote back into its content so follow-ups see
 *  what the tools actually returned. Only the NEWEST note stays full-size (deep
 *  follow-ups target the latest tool turn); older notes are clipped hard so a
 *  long tool-using conversation doesn't burn its history token budget on stale
 *  payloads. Shared by /stream, /prime, /regenerate, and /edit. */
function foldToolNotes<R extends string>(
  rows: Array<{ role: R; content: string; toolNote: string | null }>,
): Array<{ role: R; content: string }> {
  let lastNoteIdx = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.toolNote) { lastNoteIdx = i; break }
  }
  return rows.map((m, i) => ({
    role: m.role,
    content: m.toolNote
      ? `${m.content}\n\n[tool data behind this reply: ${i === lastNoteIdx ? m.toolNote : m.toolNote.slice(0, 300)}]`
      : m.content,
  }))
}

/** Drop oldest messages (in place) until estimated token count fits the budget.
 *  Keeps at least 4 messages (2 turns) regardless. Returns how many were dropped.
 *  Shared by /stream and /regenerate. */
function trimHistory(dbMessages: Array<{ content: string }>, budget: number): number {
  let dropped = 0
  while (dbMessages.length > 4) {
    const tokens = dbMessages.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0)
    if (tokens <= budget) break
    dbMessages.shift()
    dropped++
  }
  return dropped
}

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

// ── Rolling conversation summary ──────────────────────────────────────────────
// Keeps a compact running summary of everything OLDER than the live history
// window, refreshed detached on the fast model after turns in long conversations.
// Injected into the system prompt once trimming starts dropping messages, so the
// companion stops flatly forgetting what was said 10+ turns ago.
const SUMMARY_MIN_MESSAGES = 16   // don't bother below this
const SUMMARY_TAIL_KEEP = 6       // the live window covers the newest turns
const SUMMARY_STALE_AFTER = 8     // refresh once this many new messages accumulated
const SUMMARY_STALE_AFTER_URGENT = 4  // tighter cadence once the window is dropping messages

async function refreshConversationSummary(convId: string, windowIncomplete = false): Promise<void> {
  const [conv] = await db
    .select({ summary: conversations.summary, summaryThrough: conversations.summaryThrough })
    .from(conversations)
    .where(eq(conversations.id, convId))
    .limit(1)
  if (!conv) return

  const rows = await db
    .select({ role: messages.role, content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.conversationId, convId), eq(messages.active, true)))
    .orderBy(messages.createdAt)
  if (rows.length < SUMMARY_MIN_MESSAGES) return

  const throughMs = conv.summaryThrough?.getTime() ?? 0
  // Summarize up to (but not including) the newest turns — the live window has those.
  const head = rows.slice(0, rows.length - SUMMARY_TAIL_KEEP)
  const fresh = head.filter((m) => m.createdAt.getTime() > throughMs)
  if (fresh.length === 0) return
  // Staleness gate. Once the live window is dropping messages, an uncovered band
  // (older than the window, newer than summaryThrough) is REAL amnesia, so the
  // cadence tightens: at most 4+SUMMARY_TAIL_KEEP messages can be uncovered,
  // which the window still holds at the 1200-token budget.
  const staleAfter = windowIncomplete ? SUMMARY_STALE_AFTER_URGENT : SUMMARY_STALE_AFTER
  if (conv.summary && fresh.length < staleAfter) return // fresh enough

  const span = fresh.slice(0, 80)
  const spanText = span
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 600)}`)
    .join('\n')

  const fastModel = await getFastModel()
  const res = await ollamaChat(
    fastModel,
    [
      {
        role: 'system',
        content: 'You maintain a running summary of a conversation. Merge the existing summary with the new messages into ONE updated summary: at most 150 words, plain prose, keeping every important fact, decision, name, and open question. Reply with ONLY the summary.',
      },
      {
        role: 'user',
        content: `Existing summary:\n${conv.summary ?? '(none yet)'}\n\nNew messages:\n${spanText}`,
      },
    ],
    undefined,
    { temperature: 0.2, num_predict: 250 },
    undefined,
    30_000,
  )
  const summary = res.message.content?.trim()
  if (!summary) return

  await db
    .update(conversations)
    .set({ summary: summary.slice(0, 2000), summaryThrough: span[span.length - 1]!.createdAt })
    .where(eq(conversations.id, convId))
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
