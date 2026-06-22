import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { eq, desc, and, sql } from 'drizzle-orm'
import { db } from '@/db'
import { userPreferences, characters, userCharacters, conversations, messages, memories } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { routePrompt } from '@/llm/router'
import { ollamaChatStream } from '@/llm/ollama'
import type { OllamaChatMessage } from '@/llm/ollama'
import { buildBlock, extractSources } from '@/lib/blockBuilder'
import { recallMemories, formatMemoriesForPrompt } from '@/memory/recall'
import { getCachedMemoryBlock, setCachedMemoryBlock } from '@/memory/blockCache'
import { buildCompanionPrompt } from '@/lib/companionPrompt'
import { embed } from '@/llm/embed'
import { getModel } from '@/lib/models'
import { CATALOG } from '@/lib/catalog'
import {
  getProtections, getInteractionStyle,
  buildInteractionFragment,
  ProfanityStreamBuffer,
} from '@/lib/protections'
import { resolveToolConfig, isToolAllowed } from '@/lib/toolConfig'
import { toolRegistry } from '@/tools'
import { isFollowUp as isHAFollowUp, hasRecentContext as hasRecentHAContext } from '@/lib/homeAssistant/context'
import { isOffline } from '@/lib/connectivity'
import { friendshipLine, writeFirstMetMemory } from '@/lib/friendshipMemory'
import { getLocaleSettings, buildLocalePrompt } from '@/routes/adminLocale'
import {
  getCeiling, getUserCeiling, effectiveCeiling,
  parseCharacterContent, characterGate, buildContentPrompt,
} from '@/lib/contentPolicy'
import type { ContentDials } from '@/lib/contentPolicy'
import { logger } from '@/lib/logger'
import * as genQueue from '@/lib/genQueue'
import type { JobRunContext } from '@/lib/genQueue'
import type { AppEnv } from '@/types'

const chat = new Hono<AppEnv>()

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

  const { message, conversationId: incomingConvId, characterId, uiContext, projectId, clientLat, clientLng } = (await c.req.json()) as {
    message: string
    conversationId?: string
    characterId?: string
    uiContext?: string | null
    projectId?: string
    clientLat?: number | null
    clientLng?: number | null
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
  const [prefs, charRow, existingRelation, locale, protections, interactionStyle, adminCeiling, userCeiling] = await Promise.all([
    getPrefs(user.id),
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
    getCeiling(),
    getUserCeiling(user.id, user.role),
  ])

  // ── Resolve the active content dials ──────────────────────────────────────────
  // Effective ceiling = stricter of admin and user, per dial. A plain chat runs at
  // that ceiling. A character runs at its OWN config (it can't be compromised) and is
  // usable only if every dial sits within the ceiling; otherwise it's locked.
  const effCeiling = effectiveCeiling(adminCeiling, userCeiling)
  const charContent = charRow ? parseCharacterContent(charRow.contentDials) : null
  const activeDials: ContentDials = charContent ? charContent.dials : effCeiling
  if (charContent && !characterGate(charContent.dials, effCeiling).usable) {
    return c.json({ error: 'This character exceeds your content settings.' }, 403)
  }
  // Candor is delivery: from the character for a character chat, else the user's style.
  const activeInteractionStyle = charContent
    ? { ...interactionStyle, candor: charContent.candor }
    : interactionStyle
  const maskProfanityActive = activeDials.profanity === 'off'

  const friendshipStart = existingRelation?.createdAt ?? null

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
    num_ctx: (prefs['ctx_limit'] as number | undefined) ?? 4096,
    // NOTE: num_kv_cache_type and flash_attn are load-time model parameters, not
    // per-inference parameters. Setting them here would let Ollama trigger a full
    // model reload on any options mismatch. They belong only in warmupModel().
  }
  // num_predict is a ceiling, not a target — the model stops at natural completion or
  // the cap, whichever comes first. A high default does not slow down short answers.
  options['num_predict'] = (prefs['max_tokens'] as number | undefined) ?? 2048
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

  // Determine job type — vision if image attachment is included
  const hasImageAttachment = false // TODO: detect from request body when vision is wired up
  const genType = hasImageAttachment ? 'vision' : 'chat'

  // Generate server-side assistantMessageId so the frontend can correlate across reconnects
  const assistantMessageId = crypto.randomUUID()

  const finalConvId = convId
  const finalConvTitle = convTitle

  // Build the run closure — captures all per-request context
  const run = makeChatRun({
    userId: user.id,
    userRole: user.role,
    userDisplayName: user.nickname?.trim() || user.firstName?.trim() || null,
    friendshipStart,
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
    job = genQueue.enqueue({ type: genType, userId: user.id, meta: { conversationId: finalConvId, assistantMessageId }, run })
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
  friendshipStart: Date | null
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

      // ── Latency instrumentation ─────────────────────────────────────────────
      const _t0 = performance.now()
      const _lap = (label: string) => {
        logger.info(`[CHAT-TIMING] ${label} +${(performance.now() - _t0).toFixed(0)}ms`)
      }
      // ────────────────────────────────────────────────────────────────────────

      const history: OllamaChatMessage[] = p.dbMessages.map((m) => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
      }))

      // ── Memory block (cached per conversation) ──────────────────────────────
      let memoryBlock: string | null = null
      const cachedMem = getCachedMemoryBlock(p.convId)
      if (cachedMem) {
        memoryBlock = cachedMem.memoryBlock
        _lap('memory-done(cached)')
      }

      // ── Routing + memory in parallel ────────────────────────────────────────
      const [routeResult, computedMemory] = await Promise.all([
        routePrompt(p.message, history, p.model),
        cachedMem
          ? Promise.resolve(null as string | null)
          : embed(p.message)
              .then(async (embedding) => {
                _lap('embed-done')
                const recalled = await recallMemories(p.message, p.userId, p.characterId, embedding)
                return formatMemoriesForPrompt(recalled, p.userId, p.characterId, embedding)
              })
              .catch(() => null as string | null),
      ])

      if (!cachedMem) {
        memoryBlock = computedMemory
        setCachedMemoryBlock(p.convId, memoryBlock)
        _lap('memory-done(computed)')
      }

      _lap('route-done')
      let { tool, args } = routeResult

      // Home Assistant follow-ups ("I meant 20", "turn those off") carry no device
      // keywords, so the router can't catch them. If we just ran an HA command in
      // this conversation, treat an adjustment-shaped message as a follow-up to it.
      if ((!tool || tool.id !== 'homeAssistant') && isHAFollowUp(p.message) && hasRecentHAContext(p.userId, p.convId)) {
        const haTool = toolRegistry.find((t) => t.id === 'homeAssistant')
        if (haTool) { tool = haTool; args = { text: p.message } }
      }

      if (tool && !await isToolAllowed(tool.id, p.userId)) {
        tool = null
        args = {}
      }

      const hasClientCoords = typeof p.clientLat === 'number' && typeof p.clientLng === 'number'
      let ollamaMessages: OllamaChatMessage[] = [...history, { role: 'user', content: p.message }]

      if (tool) {
        ctx.emit('routing', JSON.stringify({ tool: tool.id }))

        if (!tool.offline && await isOffline(p.userId)) {
          ctx.emit('offline', JSON.stringify({ tool: tool.id }))
          ollamaMessages = [
            ...history,
            { role: 'user', content: `${p.message}\n\n[${tool.name}]: Offline mode is enabled — this tool requires internet. Let the user know and suggest they enable online mode in Settings → Tools.` },
          ]
        } else {
          const toolConfig = await resolveToolConfig(tool.id, p.userId)

          toolConfig['_userId'] = p.userId
          toolConfig['_isAdmin'] = p.userRole === 'admin'
          toolConfig['_rawMessage'] = p.message
          toolConfig['_conversationId'] = p.convId
          toolConfig['_temperature_unit'] = p.locale.temperature
          toolConfig['_measurement'] = p.locale.measurement
          toolConfig['_currency'] = p.locale.currency

          const userLocation = p.prefs['user.location'] as { displayName?: string; lat?: number; lng?: number } | undefined
          if (userLocation?.displayName && !toolConfig['default_location']) {
            toolConfig['default_location'] = userLocation.displayName
          }
          if (userLocation?.lat !== undefined) {
            toolConfig['_lat'] = userLocation.lat
            toolConfig['_lng'] = userLocation.lng
          } else if (hasClientCoords) {
            toolConfig['_lat'] = p.clientLat
            toolConfig['_lng'] = p.clientLng
          }

          const result = await tool.execute(args, toolConfig)
          _lap(`tool-execute-done(${tool.id})`)

          if (result.offline) {
            ctx.emit('offline', JSON.stringify({ tool: tool.id }))
            ollamaMessages = [
              ...history,
              { role: 'user', content: `${p.message}\n\n[${tool.name}]: The service is offline or unavailable right now. Let the user know this specific tool is offline and suggest they try again later.` },
            ]
          } else if (result.success) {
            ctx.emit('tool_data', JSON.stringify({ tool: tool.id, data: result.data }))

            const block = buildBlock(tool.id, result.data)
            if (block) ctx.emit('block', JSON.stringify(block))

            const sources = extractSources(tool.id, result.data)
            if (sources.length > 0) ctx.emit('sources', JSON.stringify(sources))

            // ── Snappy path ──────────────────────────────────────────────────
            // When a tool returns a finished, speakable reply (e.g. Home Assistant's
            // own action confirmation), emit it directly and skip the LLM synthesis
            // pass entirely. Saves the full prefill + generation round-trip.
            if (typeof result.directReply === 'string' && result.directReply.trim()) {
              const reply = result.directReply.trim()
              const safeReply = p.maskProfanityActive
                ? (await import('@/lib/protections')).maskProfanity(reply)
                : reply
              ctx.emit('token', safeReply)
              const now = new Date()
              await db.insert(messages).values({
                id: p.assistantMessageId,
                conversationId: p.convId,
                role: 'assistant',
                content: safeReply,
                createdAt: now,
              })
              await db
                .update(conversations)
                .set({ updatedAt: now })
                .where(eq(conversations.id, p.convId))
              _lap(`direct-reply-done(${tool.id})`)
              const directTitle = p.dbMessages.length === 0
                ? (await generateConversationTitle(p.model, p.message, p.convId)) || p.convTitle
                : p.convTitle
              ctx.emit('done', JSON.stringify({ model: p.model, conversationId: p.convId, title: directTitle }))
              return
            }

            const sourceList = sources.length > 0
              ? `\n\nSources:\n${sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join('\n')}\n\nWhen referencing a specific source above, cite it inline as [1], [2], etc.`
              : ''

            ollamaMessages = [
              ...history,
              { role: 'user', content: `${p.message}\n\n[${tool.name} data]: ${JSON.stringify(result.data)}${sourceList}` },
            ]
          } else {
            ctx.emit('tool_error', JSON.stringify({ tool: tool.id, error: result.error }))
            ollamaMessages = [
              ...history,
              { role: 'user', content: `${p.message}\n\n[${tool.name} error]: ${result.error ?? 'Tool call failed'}. Acknowledge the failure briefly and suggest alternatives or next steps.` },
            ]
          }
        }
      }

      // Build system prompt — keep stable across turns for Ollama KV cache reuse.
      const _now = new Date()
      const _date = _now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
      const _storedLoc = p.prefs['user.location'] as { displayName?: string; lat?: number; lng?: number } | undefined
      let _loc: string | null = _storedLoc?.displayName ?? null

      if (!_loc && hasClientCoords) {
        _loc = `coordinates ${p.clientLat!.toFixed(4)}, ${p.clientLng!.toFixed(4)}`
        fetch(`http://localhost:${process.env.PORT ?? 3000}/api/users/${p.userId}/detect-location`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: p.cookieHeader },
          body: JSON.stringify({ lat: p.clientLat, lng: p.clientLng }),
        }).catch(() => {})
      }

      const _localeBlock = buildLocalePrompt(p.locale)

      const systemParts: string[] = []
      systemParts.push(await buildContentPrompt(p.activeDials))
      systemParts.push(
        [
          `Today is ${_date}.`,
          p.userDisplayName ? `You are speaking with ${p.userDisplayName}.` : null,
          _loc ? `They are located in ${_loc}.` : null,
          p.characterSystemPrompt ? friendshipLine(p.friendshipStart) : null,
        ].filter(Boolean).join(' '),
        _localeBlock,
      )
      if (p.characterSystemPrompt) systemParts.push(p.characterSystemPrompt)
      if (memoryBlock) systemParts.push(memoryBlock)
      if (p.uiContext) systemParts.push(p.uiContext)
      // Tone (language/depth/candor). Content policy is handled by buildContentPrompt
      // above; the legacy protection fragment is now folded into the content dials.
      const _interactionFragment = buildInteractionFragment(p.interactionStyle)
      if (_interactionFragment) systemParts.push(_interactionFragment)

      if (systemParts.length > 0) {
        ollamaMessages = [{ role: 'system', content: systemParts.join('\n\n') }, ...ollamaMessages]
      }

      const _ctxChars = ollamaMessages.reduce((n, m) => n + m.content.length, 0)
      _lap(`stream-start msgs=${ollamaMessages.length} ~${Math.ceil(_ctxChars / 4)}tok`)
      let fullResponse = ''
      let firstToken = true
      const profanityBuf = p.maskProfanityActive ? new ProfanityStreamBuffer() : null

      for await (const chunk of ollamaChatStream(p.model, ollamaMessages, p.options)) {
        // Respect explicit cancel signals
        if (ctx.signal.aborted) break

        if (chunk.message.content) {
          if (firstToken) { _lap('first-token'); firstToken = false }
          const raw = chunk.message.content
          fullResponse += raw
          const emitted = profanityBuf ? profanityBuf.flush(raw) : raw
          if (emitted) ctx.emit('token', emitted)
        }
        if (chunk.done) {
          // Drain any partial word left in the profanity buffer
          if (profanityBuf) {
            const tail = profanityBuf.drain()
            if (tail) ctx.emit('token', tail)
          }

          const pe = chunk.prompt_eval_count ?? '?'
          const ec = chunk.eval_count ?? '?'
          const loadMs = chunk.load_duration ? Math.round(chunk.load_duration / 1e6) : 0
          const peMs = chunk.prompt_eval_duration === undefined ? '?' :
                       chunk.prompt_eval_duration === 0 ? '0(cached)' :
                       Math.round(chunk.prompt_eval_duration / 1e6)
          const totalMs = chunk.total_duration ? Math.round(chunk.total_duration / 1e6) : '?'
          _lap(`llm-done prompt_eval=${pe} gen=${ec} load=${loadMs}ms prefill=${peMs}ms total=${totalMs}ms`)

          const now = new Date()
          await db.insert(messages).values({
            id: p.assistantMessageId,
            conversationId: p.convId,
            role: 'assistant',
            content: p.maskProfanityActive
              ? (await import('@/lib/protections')).maskProfanity(fullResponse)
              : fullResponse,
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
        }
      }

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

async function getPrefs(userId: string): Promise<Record<string, unknown>> {
  const rows = await db.select().from(userPreferences).where(eq(userPreferences.userId, userId))
  const out: Record<string, unknown> = {}
  for (const r of rows) {
    // Guard each parse: one malformed preference row must not 500 the whole stream.
    try {
      out[r.key] = JSON.parse(r.value)
    } catch {
      // skip the bad row; the caller falls back to defaults for a missing key
    }
  }
  return out
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
