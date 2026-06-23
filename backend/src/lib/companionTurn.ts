// runCompanionTurn — the shared "produce a companion reply" pipeline, extracted
// from routes/chat.ts so non-HTTP callers (the Pod gateway, future surfaces) get
// the SAME brain: Tier-1 routing, tool execution + directReply snappy path, the
// companion system prompt, recalled memory, content dials, and profanity masking.
//
// What this DOES: message → routing → tool/directReply → system prompt → LLM
// stream, surfacing tokens + structured events through callbacks.
//
// What this does NOT do (intentionally — these are caller concerns):
//   • persist messages / conversations or generate titles
//   • emit the `done`/`gen` protocol events
//   • resolve per-user context (prefs, character, dials) — the caller assembles
//     `CompanionTurnParams` (the chat route from the request; the Pod from the
//     device's user). See `loadUserPrefs` for the shared prefs reader.

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { userPreferences } from '@/db/schema'
import { routePrompt } from '@/llm/router'
import { ollamaChatStream } from '@/llm/ollama'
import type { OllamaChatMessage } from '@/llm/ollama'
import { buildBlock, extractSources } from '@/lib/blockBuilder'
import { recallMemories, formatMemoriesForPrompt } from '@/memory/recall'
import { getCachedMemoryBlock, setCachedMemoryBlock } from '@/memory/blockCache'
import { embed } from '@/llm/embed'
import { buildInteractionFragment, ProfanityStreamBuffer } from '@/lib/protections'
import { resolveToolConfig, isToolAllowed } from '@/lib/toolConfig'
import { toolRegistry } from '@/tools'
import { isFollowUp as isHAFollowUp, hasRecentContext as hasRecentHAContext } from '@/lib/homeAssistant/context'
import { isOffline } from '@/lib/connectivity'
import { buildLocalePrompt } from '@/routes/adminLocale'
import { buildContentPrompt } from '@/lib/contentPolicy'
import type { ContentDials } from '@/lib/contentPolicy'
import { logger } from '@/lib/logger'

// Structured side-channel events (mirror the chat route's SSE taxonomy). Data is
// pre-stringified so the chat route can forward it to the wire verbatim; the Pod
// ignores these.
export type CompanionTurnEvent = 'routing' | 'offline' | 'tool_data' | 'block' | 'sources' | 'tool_error'

export interface CompanionTurnParams {
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
  /** Used as the per-conversation memory-cache key and the tool `_conversationId`. */
  convId: string
  /** Prior turns (already token-trimmed by the caller). */
  history: OllamaChatMessage[]
  prefs: Record<string, unknown>
  /** Forwarded to the detect-location side effect; '' is fine for headless callers. */
  cookieHeader: string
  locale: import('@/routes/adminLocale').LocaleSettings
  interactionStyle: import('@/lib/protections').InteractionStyle
  activeDials: ContentDials
  maskProfanityActive: boolean
}

export interface CompanionTurnHandlers {
  /** A chunk of reply text (already profanity-masked when masking is active). */
  onToken: (text: string) => void
  /** Optional structured events (routing/tool_data/block/sources/…). */
  onEvent?: (type: CompanionTurnEvent, data: string) => void
  /** Cooperative cancellation — the LLM stream stops when this flips aborted. */
  signal: { readonly aborted: boolean }
}

export interface CompanionTurnResult {
  /** Final reply text to persist (profanity-masked when masking is active). */
  text: string
  /** The tool that handled the turn, if any. */
  toolId: string | null
  /** True when a tool returned a finished reply and the LLM was skipped. */
  viaDirectReply: boolean
  /** False when the turn was cancelled mid-stream (caller should not persist). */
  completed: boolean
}

/** Read a user's preferences into a plain object (shared by chat route + Pod). */
export async function loadUserPrefs(userId: string): Promise<Record<string, unknown>> {
  const rows = await db.select().from(userPreferences).where(eq(userPreferences.userId, userId))
  const out: Record<string, unknown> = {}
  for (const r of rows) {
    // Guard each parse: one malformed preference row must not break the turn.
    try {
      out[r.key] = JSON.parse(r.value)
    } catch {
      // skip the bad row; the caller falls back to defaults for a missing key
    }
  }
  return out
}

/**
 * Run one companion turn. Streams tokens via `h.onToken`, surfaces structured
 * events via `h.onEvent`, and returns the final text + metadata for the caller
 * to persist/deliver.
 */
export async function runCompanionTurn(
  p: CompanionTurnParams,
  h: CompanionTurnHandlers,
): Promise<CompanionTurnResult> {
  const emitEvent = (type: CompanionTurnEvent, data: string) => h.onEvent?.(type, data)

  // ── Latency instrumentation ───────────────────────────────────────────────
  const _t0 = performance.now()
  const _lap = (label: string) => {
    logger.info(`[CHAT-TIMING] ${label} +${(performance.now() - _t0).toFixed(0)}ms`)
  }

  const history = p.history

  // ── Memory block (cached per conversation) ────────────────────────────────
  let memoryBlock: string | null = null
  const cachedMem = getCachedMemoryBlock(p.convId)
  if (cachedMem) {
    memoryBlock = cachedMem.memoryBlock
    _lap('memory-done(cached)')
  }

  // ── Routing + memory in parallel ──────────────────────────────────────────
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
    emitEvent('routing', JSON.stringify({ tool: tool.id }))

    if (!tool.offline && await isOffline(p.userId)) {
      emitEvent('offline', JSON.stringify({ tool: tool.id }))
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
        emitEvent('offline', JSON.stringify({ tool: tool.id }))
        ollamaMessages = [
          ...history,
          { role: 'user', content: `${p.message}\n\n[${tool.name}]: The service is offline or unavailable right now. Let the user know this specific tool is offline and suggest they try again later.` },
        ]
      } else if (result.success) {
        emitEvent('tool_data', JSON.stringify({ tool: tool.id, data: result.data }))

        const block = buildBlock(tool.id, result.data)
        if (block) emitEvent('block', JSON.stringify(block))

        const sources = extractSources(tool.id, result.data)
        if (sources.length > 0) emitEvent('sources', JSON.stringify(sources))

        // ── Snappy path ────────────────────────────────────────────────────
        // When a tool returns a finished, speakable reply (e.g. Home Assistant's
        // own action confirmation), emit it directly and skip LLM synthesis.
        if (typeof result.directReply === 'string' && result.directReply.trim()) {
          const reply = result.directReply.trim()
          const safeReply = p.maskProfanityActive
            ? (await import('@/lib/protections')).maskProfanity(reply)
            : reply
          h.onToken(safeReply)
          _lap(`direct-reply-done(${tool.id})`)
          return { text: safeReply, toolId: tool.id, viaDirectReply: true, completed: true }
        }

        const sourceList = sources.length > 0
          ? `\n\nSources:\n${sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join('\n')}\n\nWhen referencing a specific source above, cite it inline as [1], [2], etc.`
          : ''

        ollamaMessages = [
          ...history,
          { role: 'user', content: `${p.message}\n\n[${tool.name} data]: ${JSON.stringify(result.data)}${sourceList}` },
        ]
      } else {
        emitEvent('tool_error', JSON.stringify({ tool: tool.id, error: result.error }))
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
  const _time = _now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
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
      `Today is ${_date}, and the current time is ${_time}.`,
      p.userDisplayName ? `You are speaking with ${p.userDisplayName}.` : null,
      _loc ? `They are located in ${_loc}.` : null,
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
  let completed = false
  const profanityBuf = p.maskProfanityActive ? new ProfanityStreamBuffer() : null

  for await (const chunk of ollamaChatStream(p.model, ollamaMessages, p.options)) {
    // Respect explicit cancel signals
    if (h.signal.aborted) break

    if (chunk.message.content) {
      if (firstToken) { _lap('first-token'); firstToken = false }
      const raw = chunk.message.content
      fullResponse += raw
      const emitted = profanityBuf ? profanityBuf.flush(raw) : raw
      if (emitted) h.onToken(emitted)
    }
    if (chunk.done) {
      // Drain any partial word left in the profanity buffer
      if (profanityBuf) {
        const tail = profanityBuf.drain()
        if (tail) h.onToken(tail)
      }

      const pe = chunk.prompt_eval_count ?? '?'
      const ec = chunk.eval_count ?? '?'
      const loadMs = chunk.load_duration ? Math.round(chunk.load_duration / 1e6) : 0
      const peMs = chunk.prompt_eval_duration === undefined ? '?' :
                   chunk.prompt_eval_duration === 0 ? '0(cached)' :
                   Math.round(chunk.prompt_eval_duration / 1e6)
      const totalMs = chunk.total_duration ? Math.round(chunk.total_duration / 1e6) : '?'
      _lap(`llm-done prompt_eval=${pe} gen=${ec} load=${loadMs}ms prefill=${peMs}ms total=${totalMs}ms`)
      completed = true
    }
  }

  const text = p.maskProfanityActive
    ? (await import('@/lib/protections')).maskProfanity(fullResponse)
    : fullResponse

  return { text, toolId: tool?.id ?? null, viaDirectReply: false, completed }
}
