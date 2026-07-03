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
import { userPreferences, chatDocuments, characters } from '@/db/schema'
import { routePrompt } from '@/llm/router'
import { ollamaChat, ollamaChatStream } from '@/llm/ollama'
import type { OllamaChatMessage } from '@/llm/ollama'
import { buildBlock, extractSources } from '@/lib/blockBuilder'
import { recallMemories, formatMemoriesForPrompt, matchPromptEntities } from '@/memory/recall'
import { getCachedMemoryBlock, setCachedMemoryBlock } from '@/memory/blockCache'
import { embed } from '@/llm/embed'
import { buildInteractionFragment, ProfanityStreamBuffer, getProtections, getInteractionStyle } from '@/lib/protections'
import { resolveToolConfig, getAllowedToolIds } from '@/lib/toolConfig'
import { toolRegistry } from '@/tools'
import {
  isFollowUp as isHAFollowUp, hasRecentContext as hasRecentHAContext,
  hasPendingAction as hasPendingHAAction, isConfirmationReply as isHAConfirmationReply,
} from '@/lib/homeAssistant/context'
import { isOffline } from '@/lib/connectivity'
import { friendshipLine } from '@/lib/friendshipMemory'
import { buildLocalePrompt, getLocaleSettings } from '@/routes/adminLocale'
import { buildContentPrompt, getUserCeiling, clampDials, parseCharacterContent, characterGate } from '@/lib/contentPolicy'
import type { ContentDials } from '@/lib/contentPolicy'
import { activeSkillsBlock } from '@/lib/skills/resolver'
import { getCachedBriefing } from '@/lib/briefing/cache'
import { ensureBriefingWarm, DEFAULT_BRIEFING_KEY } from '@/lib/briefing/refresh'
import { retrieveDocChunks, DOC_STUFF_BUDGET } from '@/lib/docChunks'
import { getModel, getFastModel } from '@/lib/models'
import { CATALOG } from '@/lib/catalog'
import { buildCompanionPrompt } from '@/lib/companionPrompt'
import { appendVersion as appendArtifactVersion } from '@/lib/artifacts/store'
import type { OpenArtifactDirective } from '@/tools'
import { logger } from '@/lib/logger'

// Structured side-channel events (mirror the chat route's SSE taxonomy). Data is
// pre-stringified so the chat route can forward it to the wire verbatim; the Pod
// ignores these.
export type CompanionTurnEvent = 'routing' | 'offline' | 'tool_data' | 'block' | 'sources' | 'tool_error' | 'directive' | 'artifact_token' | 'artifact_done'

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
  /** IANA timezone from the client (e.g. "America/New_York"). Null → server-local
   *  (right for Pods on the home LAN; wrong for a remote phone, so send it). */
  clientTz?: string | null
  /** Used as the per-conversation memory-cache key and the tool `_conversationId`. */
  convId: string
  /** Prior turns (already token-trimmed by the caller). */
  history: OllamaChatMessage[]
  /** Rolling summary of conversation content OLDER than `history` — injected when
   *  the caller's history window dropped messages. */
  conversationSummary?: string | null
  /**
   * When the user first met this character (userCharacters.createdAt).
   * `null` = genuinely first meeting; `undefined` = unknown (caller didn't fetch) —
   * the relationship line is skipped rather than wrongly claiming a first meeting.
   */
  firstMetAt?: Date | null
  prefs: Record<string, unknown>
  /** Forwarded to the detect-location side effect; '' is fine for headless callers. */
  cookieHeader: string
  locale: import('@/routes/adminLocale').LocaleSettings
  interactionStyle: import('@/lib/protections').InteractionStyle
  activeDials: ContentDials
  maskProfanityActive: boolean
  // ── Surface options — how the callers (chat / overlay / pod / telegram) differ ──
  /** Which surface this turn serves. Affects logging only; section toggles below. */
  surface?: 'chat' | 'overlay' | 'pod' | 'telegram'
  /** Extra harness line placed right before the persona (e.g. the overlay's
   *  "chatting casually in a little floating bar" framing). */
  harnessLine?: string | null
  /** Ambient world/local briefing block (default true — synchronous cache read). */
  includeBriefing?: boolean
  /** User-authored prompt skills (default true). */
  includeSkills?: boolean
  /** Attached-document block + doc-routing override (default true; overlay/pod
   *  have synthetic conversation ids with no documents — skip the query). */
  includeDocs?: boolean
  /** Base64 images for a vision turn — attached to the user message. The caller
   *  is responsible for passing a vision-capable model. */
  images?: string[]
  /** The Canvas artifact currently open/last-active in this chat, if any. When the
   *  user's message reads like an edit instruction, the turn edits THIS artifact
   *  (streams a new version into the same pane) instead of creating a new one. */
  focusedArtifact?: { id: string; type: 'code' | 'document' | 'html'; title: string } | null
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
  /** Final reply text — RAW (unmasked), even when profanity masking is active.
   *  Persist this and mask at READ time: persisting masked text used to feed
   *  `****` back into LLM history, teaching the model to self-censor (and hiding
   *  the real words from the memory judge). The live token stream stays masked.
   *  On an incomplete turn this holds the PARTIAL text streamed so far. */
  text: string
  /** The tool that handled the turn, if any. */
  toolId: string | null
  /** True when a tool returned a finished reply and the LLM was skipped. */
  viaDirectReply: boolean
  /** False when the turn was cancelled or errored mid-stream. */
  completed: boolean
  /** True when the reply hit the num_predict token cap (done_reason=length). */
  capped?: boolean
  /** Set when the stream failed mid-generation (completed=false, text=partial). */
  error?: string
  /** Compact record of what the tool(s) returned this turn. Persisted alongside
   *  the assistant message and fed back into future turns' history, so
   *  follow-ups ("tell me more") can elaborate on the actual data instead of
   *  re-searching or deflecting. */
  toolNote?: string
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

// ── Document-attachment routing heuristics ────────────────────────────────────
// Only consulted when a document is actually attached to the conversation (see the
// override in runCompanionTurn), so these can be fairly liberal without hijacking
// normal chat.
const DOC_NOUN_RE = /\b(documents?|docs?|files?|pdfs?|attachments?|uploads?|markdown|spreadsheets?|slides?|presentations?|essays?|papers?|articles?|reports?|manuscripts?)\b/i
// Verbs that strongly imply acting on a text artifact — safe to bind to the doc alone.
const STRONG_DOC_VERB_RE = /\b(proofread|spell\s?-?check|spelling|grammar|rewrite|rephrase|reword|paraphrase|summari[sz]e|shorten|condense|polish)\b/i
// Weaker cues (explain/analyze/read/etc.) only bind to the doc when paired with a
// demonstrative, so "explain quantum physics" with a doc attached doesn't get hijacked.
const WEAK_DOC_VERB_RE = /\b(explain|analy[sz]e|review|recap|describe|translate|edit|fix|read|go over|break\s?down|tl;?dr)\b/i
const DEMONSTRATIVE_RE = /\b(this|that|it|these|those|above)\b/i
const WHAT_IS_THIS_RE  = /\bwhat(?:'s| is| are| does| was| were)\b.*\b(this|that|it)\b/i

// ── Persona-flavored directReply ──────────────────────────────────────────────
// directReply confirmations ("Turned off the office lights.") are the
// highest-frequency voice interactions and used to have ZERO personality — every
// character sounded identical. A strictly-budgeted rewrite on the dedicated fast
// model puts the character's voice on them; any timeout, failure, or fact drift
// falls back to the canned text, so the snappy path can never be broken by this.
const DIRECT_REPLY_FLAVOR_BUDGET_MS = 450

async function personaFlavorReply(canned: string, p: CompanionTurnParams): Promise<string | null> {
  try {
    const fastModel = await getFastModel()
    // Only attempt on a dedicated (resident, small) fast model — rewriting on the
    // main chat model would trade away the snappy path's whole latency win.
    if (fastModel === p.model) return null
    // First paragraph of the persona = core identity; the full prompt is overkill
    // (and slow to prefill) for a one-line rewrite.
    const personaCore = p.characterSystemPrompt!.split('\n\n')[0] ?? ''
    if (!personaCore.trim()) return null
    const res = await ollamaChat(
      fastModel,
      [
        { role: 'system', content: `${personaCore}\n\nRewrite the system confirmation the user sends as yourself — ONE short spoken sentence. Keep every fact (device names, times, numbers) exactly as given. No emojis, no quotes, no extra commentary.` },
        { role: 'user', content: canned },
      ],
      undefined,
      { temperature: 0.6, num_predict: 40 },
      undefined,
      DIRECT_REPLY_FLAVOR_BUDGET_MS,
    )
    const out = res.message.content?.trim().replace(/^["']|["']$/g, '')
    if (!out || out.length < 3 || out.length > 200) return null
    // Fact guard: every number in the canned text must survive the rewrite
    // ("set to 20%" must not become "set to 30%").
    const nums = canned.match(/\d+/g) ?? []
    if (!nums.every((n) => out.includes(n))) return null
    return out
  } catch {
    return null // timeout or failure → canned text
  }
}

// A tool ran successfully but returned no findings — e.g. web search with an empty
// `results` array. Triggers the "found nothing, don't make it up" instruction.
function isEmptyResult(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const d = data as { results?: unknown }
  return Array.isArray(d.results) && d.results.length === 0
}

// Edit-intent detector for the focused Canvas artifact. Only consulted when a canvas
// is actually open (see the override in runCompanionTurn), so it can be liberal. A
// clear NEW-creation ("write me a new script") is excluded; an imperative tweak
// ("make it shorter", "add error handling") or a reference to the artifact
// ("the code", "this function") counts as an edit.
const NEW_CREATION_RE = /\b(write|create|make|draft|generate|build|compose)\s+(me\s+)?(a|an|another|the)\s+\w/i
// Imperative edit verbs, anywhere in the message (so "can you add X" counts too).
const EDIT_VERB_RE = /\b(add|remove|delete|change|fix|rewrite|refactor|rename|update|shorten|lengthen|expand|simplify|improve|polish|translate|convert|replace|wrap|comment|document|optimi[sz]e|handle|support|adjust|tweak|revise|redo|append|insert|swap|reformat|indent|rework|instead|as well|make it|make the|turn it|turn the)\b|^\s*also\b/i
const ARTIFACT_REF_RE = /\b(it|this|that|the (code|script|program|function|file|doc|document|page|html|markdown|essay|letter|list|snippet|class|method))\b/i
// A question ABOUT the artifact ("how does this work?", "is this right?") should be
// explained, not trigger a rewrite — unless it also carries an edit verb ("can you
// make it shorter?").
const QUESTION_RE = /\?\s*$|^\s*(how|what|why|does|do|did|is|are|was|were|where|when|who|which|explain|tell me|describe|show me)\b/i

function looksLikeArtifactEdit(msg: string): boolean {
  const m = msg.trim()
  const hasEditVerb = EDIT_VERB_RE.test(m)
  // Pure question with no edit verb = "explain this", not an edit.
  if (QUESTION_RE.test(m) && !hasEditVerb) return false
  // "write me a NEW thing" with no back-reference is a fresh artifact, not an edit.
  if (NEW_CREATION_RE.test(m) && !ARTIFACT_REF_RE.test(m)) return false
  return hasEditVerb || ARTIFACT_REF_RE.test(m)
}

/** Does this message look like it's about / acting on the conversation's attached document? */
function refersToAttachedDocument(msg: string): boolean {
  if (DOC_NOUN_RE.test(msg)) return true
  if (STRONG_DOC_VERB_RE.test(msg)) return true
  if (WHAT_IS_THIS_RE.test(msg)) return true
  if (WEAK_DOC_VERB_RE.test(msg) && DEMONSTRATIVE_RE.test(msg)) return true
  return false
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
  const includeSkills = p.includeSkills ?? true
  const includeDocs = p.includeDocs ?? true
  const includeBriefing = p.includeBriefing ?? true

  // Allowed tools must be known BEFORE routing so denied tools never occupy
  // candidate slots or silently swallow a turn. Two fast indexed queries. The
  // entity pass runs alongside — it's the memory cache's staleness check.
  const [allowedToolIds, promptEntityIds] = await Promise.all([
    getAllowedToolIds(p.userId),
    matchPromptEntities(p.message, p.userId, p.characterId).catch(() => new Set<string>()),
  ])

  // ── Memory block (cached per conversation; entity-aware staleness) ─────────
  let memoryBlock: string | null = null
  const cachedMem = getCachedMemoryBlock(p.convId, promptEntityIds)
  if (cachedMem) {
    memoryBlock = cachedMem.memoryBlock
    _lap('memory-done(cached)')
  }

  // ── Routing + memory + per-turn reads, all in parallel ────────────────────
  // Everything the rest of the turn needs from the DB is fetched here in one
  // round: routing, memory recall, offline mode, the skills block, and attached
  // documents (used for BOTH the doc-routing override and the prompt block —
  // this used to be two separate sequential queries).
  const [routeResult, computedMemory, offlineMode, skillsBlock, docs] = await Promise.all([
    // Pass the chat num_ctx so a same-model Tier-2 call doesn't force an Ollama
    // runner re-init (context-size mismatch reloads the model).
    routePrompt(p.message, history, p.model, {
      numCtx: p.options['num_ctx'] as number | undefined,
      allowedToolIds,
    }),
    cachedMem
      ? Promise.resolve(null as string | null)
      : embed(p.message)
          .then(async (embedding) => {
            _lap('embed-done')
            const recalled = await recallMemories(p.message, p.userId, p.characterId, embedding, promptEntityIds)
            return formatMemoriesForPrompt(recalled, p.userId, p.characterId, embedding)
          })
          .catch(() => null as string | null),
    isOffline(p.userId).catch(() => false),
    includeSkills
      ? activeSkillsBlock(p.userId).catch((e) => { logger.warn(`[skills] active-skills block failed: ${e}`); return null })
      : Promise.resolve(null),
    includeDocs
      ? db.select({ filename: chatDocuments.filename, text: chatDocuments.text })
          .from(chatDocuments)
          .where(eq(chatDocuments.conversationId, p.convId))
          .catch(() => [] as { filename: string; text: string }[])
      : Promise.resolve([] as { filename: string; text: string }[]),
  ])

  if (!cachedMem) {
    memoryBlock = computedMemory
    setCachedMemoryBlock(p.convId, memoryBlock, { entityIds: promptEntityIds, userId: p.userId })
    _lap('memory-done(computed)')
  }

  _lap('route-done')
  let { tool, args } = routeResult

  // Home Assistant follow-ups ("I meant 20", "turn those off") carry no device
  // keywords, so the router can't catch them. If we just ran an HA command in
  // this conversation, treat an adjustment-shaped message as a follow-up to it.
  // Same for yes/no replies to a pending security confirmation ("Unlock the front
  // door — yes?"), which the router would otherwise treat as chitchat.
  const haFollowUp = isHAFollowUp(p.message) && hasRecentHAContext(p.userId, p.convId)
  const haConfirmReply = isHAConfirmationReply(p.message) && hasPendingHAAction(p.userId, p.convId)
  if ((!tool || tool.id !== 'homeAssistant') && (haFollowUp || haConfirmReply) && allowedToolIds.has('homeAssistant')) {
    const haTool = toolRegistry.find((t) => t.id === 'homeAssistant')
    if (haTool) { tool = haTool; args = { text: p.message } }
  }

  // Document-attached override: when this conversation has an uploaded document and
  // the message clearly refers to it (or asks to edit/explain it), force the Document
  // Assistant. Otherwise the router sends "what is this document" / "summarize this"
  // to web search, and the companion ends up describing the search payload instead of
  // ever reading the actual file. Gated on a document existing, so a doc-shaped phrase
  // in a normal chat (no attachment) still routes normally.
  if ((!tool || tool.id !== 'document_edit') && docs.length > 0 && refersToAttachedDocument(p.message) && allowedToolIds.has('document_edit')) {
    const docTool = toolRegistry.find((t) => t.id === 'document_edit')
    if (docTool) { tool = docTool; args = { instruction: p.message } }
  }

  // Focused-canvas edit override: when a Canvas artifact is open in this chat and the
  // message reads like an instruction to change it, edit THAT artifact (canvas tool in
  // edit mode → streams a new version into the same pane, reopening it) instead of
  // creating a new one or just chatting. Only overrides a conversational route or a
  // canvas(create) route — never hijacks a real tool call (weather, search, HA, …).
  if (p.focusedArtifact && allowedToolIds.has('canvas') && (!tool || tool.id === 'canvas') && looksLikeArtifactEdit(p.message)) {
    const canvasTool = toolRegistry.find((t) => t.id === 'canvas')
    if (canvasTool) { tool = canvasTool; args = { editArtifactId: p.focusedArtifact.id, instruction: p.message } }
  }

  const hasClientCoords = typeof p.clientLat === 'number' && typeof p.clientLng === 'number'
  let ollamaMessages: OllamaChatMessage[] = [...history, { role: 'user', content: p.message }]

  // Canvas artifact mode: when a tool opens an artifact (the `canvas` tool emits an
  // `open_artifact` directive), the LLM synthesis pass that follows IS the artifact
  // body. We tee those tokens into `artifact_token` events (streamed live into the
  // canvas pane) instead of the chat bubble, persist them as the artifact's first
  // version, and leave a compact "Created …" line in the transcript. Set inside the
  // tool block below; consumed by the streaming loop.
  let artifactMode: OpenArtifactDirective | null = null

  // Multi-intent turns ("turn off the lights and play some jazz"): the extra
  // calls run serially after the primary, each folding its result into the turn.
  const extraCalls = (routeResult.extraCalls ?? []).filter(
    (c) => allowedToolIds.has(c.tool.id) && (c.tool.offline || !offlineMode),
  )
  // Compact per-tool notes, persisted with the reply so follow-up turns still see
  // what the tools actually returned (history otherwise only keeps raw text).
  const toolNotes: string[] = []
  const noteFor = (name: string, data: unknown): string =>
    `${name} → ${JSON.stringify(data ?? null).slice(0, 600)}`

  // What the LLM sees of a tool result. Tools that provide an answer_payload
  // (gist/highlights/sources — the ~20-tool convention) get ONLY that: folding the
  // full payload dumped every raw field into the prompt — a single news call
  // measured 7,348 prompt tokens (18s of prefill) mostly from item URLs/snippets
  // the model never needed. Full data still reaches the UI via tool_data/block.
  const llmFold = (data: unknown): string => {
    const payload = (data as { answer_payload?: unknown } | null)?.answer_payload
    return JSON.stringify(payload ?? data ?? null)
  }

  // Shared tool-config assembly (identical for primary and extra calls).
  const buildToolConfig = async (toolId: string): Promise<Record<string, unknown>> => {
    const cfg = await resolveToolConfig(toolId, p.userId)
    cfg['_userId'] = p.userId
    cfg['_isAdmin'] = p.userRole === 'admin'
    cfg['_rawMessage'] = p.message
    cfg['_conversationId'] = p.convId
    cfg['_temperature_unit'] = p.locale.temperature
    cfg['_measurement'] = p.locale.measurement
    cfg['_currency'] = p.locale.currency
    const userLocation = p.prefs['user.location'] as { displayName?: string; lat?: number; lng?: number } | undefined
    if (userLocation?.displayName && !cfg['default_location']) {
      cfg['default_location'] = userLocation.displayName
    }
    if (userLocation?.lat !== undefined) {
      cfg['_lat'] = userLocation.lat
      cfg['_lng'] = userLocation.lng
    } else if (hasClientCoords) {
      cfg['_lat'] = p.clientLat
      cfg['_lng'] = p.clientLng
    }
    return cfg
  }

  // The best route was a tool this user is denied — say so instead of silently
  // answering a live question (e.g. weather) from stale model memory.
  if (!tool && routeResult.deniedToolId) {
    const deniedName = toolRegistry.find((t) => t.id === routeResult.deniedToolId)?.name ?? routeResult.deniedToolId
    ollamaMessages = [
      ...history,
      { role: 'user', content: `${p.message}\n\n[system]: The "${deniedName}" tool that would normally handle this is disabled for this account, so you have no live data. Answer from your own knowledge only if you safely can, and briefly mention the tool is disabled (an admin can enable it under Settings → Tools).` },
    ]
  }

  if (tool) {
    emitEvent('routing', JSON.stringify({ tool: tool.id }))

    if (!tool.offline && offlineMode) {
      emitEvent('offline', JSON.stringify({ tool: tool.id }))
      ollamaMessages = [
        ...history,
        { role: 'user', content: `${p.message}\n\n[${tool.name}]: Offline mode is enabled — this tool requires internet. Let the user know and suggest they enable online mode in Settings → Tools.` },
      ]
    } else {
      const toolConfig = await buildToolConfig(tool.id)

      // A tool that THROWS (vs. returning {success:false}) must not kill the turn —
      // fold it into the same failure-acknowledgement path as a returned error.
      let result: import('@/tools').ToolResult
      try {
        result = await tool.execute(args, toolConfig)
      } catch (err) {
        logger.warn(`[companion-turn] tool ${tool.id} threw: ${err}`)
        result = { success: false, error: String(err) }
      }
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
        // The spoken ack goes out BEFORE the directive so on voice surfaces TTS
        // gets a head start before the player launches. A multi-intent turn
        // (extra calls pending) folds the ack into the synthesis pass instead so
        // one reply covers everything.
        if (typeof result.directReply === 'string' && result.directReply.trim() && extraCalls.length === 0) {
          let reply = result.directReply.trim()
          // Character surfaces get the ack in the character's voice (budgeted;
          // falls back to the canned text on any slip).
          if (p.characterSystemPrompt) {
            reply = (await personaFlavorReply(reply, p)) ?? reply
          }
          const safeReply = p.maskProfanityActive
            ? (await import('@/lib/protections')).maskProfanity(reply)
            : reply
          h.onToken(safeReply)
          if (result.directive) emitEvent('directive', JSON.stringify(result.directive))
          _lap(`direct-reply-done(${tool.id})`)
          return { text: reply, toolId: tool.id, viaDirectReply: true, completed: true, toolNote: `${tool.name}: ${result.directReply.trim()}`.slice(0, 600) }
        }

        // A client-side action (e.g. start mini-player playback) with an LLM
        // synthesis pass — emit the directive now so the player starts as the
        // reply streams in.
        if (result.directive) emitEvent('directive', JSON.stringify(result.directive))

        // Canvas: the following synthesis stream is the artifact body, not chat prose.
        if (result.directive?.action === 'open_artifact') artifactMode = result.directive

        // The tool ran fine but found nothing (e.g. a web search on a garbled or
        // misheard name). Without an explicit signal the model treats the empty
        // payload as license to answer from memory and confidently deny the subject
        // exists ("never heard of him"). Mirrors toolTurn.ts's voice-path guard.
        if (isEmptyResult(result.data)) {
          ollamaMessages = [
            ...history,
            { role: 'user', content: `${p.message}\n\n[${tool.name}]: No results found. Do NOT claim the subject doesn't exist or that you've never heard of it — the name may be misspelled or misheard from speech. Briefly say you couldn't find anything on it, and if it closely resembles someone or something well-known, ask if that's who they meant.` },
          ]
          toolNotes.push(`${tool.name} → no results`)
        } else if (typeof result.directReply === 'string' && result.directReply.trim()) {
          // Multi-intent turn: the tool already acted; its ack becomes part of the
          // single synthesized reply.
          ollamaMessages = [
            ...history,
            { role: 'user', content: `${p.message}\n\n[${tool.name}]: ${result.directReply.trim()} (already done — acknowledge it naturally as part of your reply)` },
          ]
          toolNotes.push(`${tool.name}: ${result.directReply.trim()}`.slice(0, 300))
        } else {

        const sourceList = sources.length > 0
          ? `\n\nSources:\n${sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join('\n')}\n\nWhen referencing a specific source above, cite it inline as [1], [2], etc.`
          : ''

        // A tool that already acted (e.g. started playback) supplies a tailored
        // instruction instead of a data dump, so the LLM reacts in-character rather
        // than narrating JSON.
        const toolTurnContent = typeof result.synthesisHint === 'string' && result.synthesisHint.trim()
          ? `${p.message}\n\n${result.synthesisHint.trim()}${sourceList}`
          : `${p.message}\n\n[${tool.name} data]: ${llmFold(result.data)}${sourceList}`
        ollamaMessages = [
          ...history,
          { role: 'user', content: toolTurnContent },
        ]
        toolNotes.push(noteFor(tool.name, result.data))
        }
      } else {
        emitEvent('tool_error', JSON.stringify({ tool: tool.id, error: result.error }))
        ollamaMessages = [
          ...history,
          { role: 'user', content: `${p.message}\n\n[${tool.name} error]: ${result.error ?? 'Tool call failed'}. Acknowledge the failure briefly and suggest alternatives or next steps.` },
        ]
      }
    }
  }

  // ── Extra calls (multi-intent) ─────────────────────────────────────────────
  // Each remaining call from the router executes serially and appends its result
  // to the same user turn, so one synthesized reply covers the whole compound
  // command. Failures fold in like primary failures; the turn never dies here.
  for (const call of extraCalls) {
    emitEvent('routing', JSON.stringify({ tool: call.tool.id }))
    let extraResult: import('@/tools').ToolResult
    try {
      extraResult = await call.tool.execute(call.args, await buildToolConfig(call.tool.id))
    } catch (err) {
      logger.warn(`[companion-turn] extra tool ${call.tool.id} threw: ${err}`)
      extraResult = { success: false, error: String(err) }
    }
    _lap(`tool-execute-done(${call.tool.id},extra)`)

    let fold: string
    if (extraResult.offline) {
      fold = `[${call.tool.name}]: offline or unavailable right now — mention it briefly.`
    } else if (extraResult.success) {
      emitEvent('tool_data', JSON.stringify({ tool: call.tool.id, data: extraResult.data }))
      if (extraResult.directive) emitEvent('directive', JSON.stringify(extraResult.directive))
      if (typeof extraResult.directReply === 'string' && extraResult.directReply.trim()) {
        fold = `[${call.tool.name}]: ${extraResult.directReply.trim()} (already done — acknowledge it naturally)`
        toolNotes.push(`${call.tool.name}: ${extraResult.directReply.trim()}`.slice(0, 300))
      } else if (typeof extraResult.synthesisHint === 'string' && extraResult.synthesisHint.trim()) {
        fold = extraResult.synthesisHint.trim()
        toolNotes.push(noteFor(call.tool.name, extraResult.data))
      } else {
        fold = `[${call.tool.name} data]: ${llmFold(extraResult.data)}`
        toolNotes.push(noteFor(call.tool.name, extraResult.data))
      }
    } else {
      emitEvent('tool_error', JSON.stringify({ tool: call.tool.id, error: extraResult.error }))
      fold = `[${call.tool.name} error]: ${extraResult.error ?? 'Tool call failed'}. Acknowledge briefly.`
    }

    const lastMsg = ollamaMessages[ollamaMessages.length - 1]
    if (lastMsg?.role === 'user') lastMsg.content += `\n\n${fold}`
  }

  // Build system prompt — ordered STABLE → VOLATILE for Ollama KV-cache reuse.
  // The minute-precision time string used to sit near the front (position 2) and
  // bust the KV cache every minute, forcing a full re-prefill of the heavy
  // persona/memory/docs prefix. It now goes LAST (same fix as routes/companions.ts).
  const _now = new Date()
  // Prefer the CLIENT's timezone — "good morning" at the user's 8am, not the
  // server's. Falls back to server-local (the family's tz on a home server).
  let _tz: string | undefined
  if (p.clientTz) {
    try { _now.toLocaleTimeString('en-US', { timeZone: p.clientTz }); _tz = p.clientTz } catch { /* invalid tz — server-local */ }
  }
  const _date = _now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: _tz })
  const _time = _now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: _tz })
  const _hour = parseInt(_now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: _tz }), 10)
  const _partOfDay =
    _hour < 5 ? 'the middle of the night' :
    _hour < 9 ? 'early morning' :
    _hour < 12 ? 'morning' :
    _hour < 17 ? 'the afternoon' :
    _hour < 21 ? 'the evening' : 'late night'
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

  // Ambient world/local briefing: a SYNCHRONOUS warm-cache read (never blocks the
  // turn) that keeps the companion world-aware on every surface. The block only
  // changes every ~cadence, so the prompt prefix stays KV-stable.
  let briefingBlock: string | null = null
  if (includeBriefing && !offlineMode) {
    const briefingKey = _storedLoc?.displayName ?? DEFAULT_BRIEFING_KEY
    briefingBlock = getCachedBriefing(briefingKey)?.block || null
    ensureBriefingWarm(
      briefingKey,
      _storedLoc?.displayName ? { displayName: _storedLoc.displayName, lat: _storedLoc.lat, lng: _storedLoc.lng } : null,
      p.userId,
    )
  }

  const systemParts: string[] = []
  systemParts.push(buildContentPrompt(p.activeDials))
  systemParts.push(_localeBlock)
  if (p.harnessLine) systemParts.push(p.harnessLine)
  if (p.characterSystemPrompt) {
    systemParts.push(p.characterSystemPrompt)
    // Relationship-stage line ("You've known each other for 3 months") — stable at
    // day granularity, so KV-safe here next to the persona. Skipped when the caller
    // couldn't resolve the relation (undefined), so it never falsely claims a first meeting.
    if (p.characterId && p.firstMetAt !== undefined) {
      const fl = friendshipLine(p.firstMetAt)
      if (fl) systemParts.push(fl)
    }
  }
  if (memoryBlock) systemParts.push(memoryBlock)
  if (briefingBlock) systemParts.push(briefingBlock)
  // Older conversation content the trimmed history window no longer carries.
  if (p.conversationSummary) {
    systemParts.push(`## Earlier in this conversation\n${p.conversationSummary}`)
  }
  if (p.uiContext) systemParts.push(p.uiContext)
  // User-authored skills active for this user (prefetched in the parallel batch).
  if (skillsBlock) systemParts.push(skillsBlock)

  // Documents the user attached to this conversation. Small enough → stuffed
  // whole. Oversized → top-k RELEVANT chunks retrieved per question (embedded
  // detached at attach time), falling back to head-truncation only while the
  // chunks are still being built.
  if (docs.length > 0) {
    const totalLen = docs.reduce((n, d) => n + d.text.length, 0)
    let docsBlock: string | null = null

    if (totalLen > DOC_STUFF_BUDGET) {
      const excerpts = await retrieveDocChunks(p.convId, p.message, 6).catch(() => [])
      if (excerpts.length > 0) {
        docsBlock =
          '## Attached documents (relevant excerpts)\nThe user attached documents too large to include whole. ' +
          'These are the excerpts most relevant to their message — answer from them, cite the filename, and say so if the answer may live in a part not shown.\n\n' +
          excerpts.map((e) => `### ${e.filename} (part ${e.idx + 1})\n${e.text}`).join('\n\n')
        _lap('doc-retrieval-done')
      }
    }

    if (!docsBlock) {
      const parts: string[] = []
      let len = 0
      for (const d of docs) {
        const slice = d.text.slice(0, Math.max(0, DOC_STUFF_BUDGET - len))
        if (!slice) break
        parts.push(`### ${d.filename}\n${slice}${slice.length < d.text.length ? '\n…(truncated)' : ''}`)
        len += slice.length
        if (len >= DOC_STUFF_BUDGET) break
      }
      docsBlock =
        '## Attached documents\nThe user attached these documents to this conversation. ' +
        'Use them to answer questions; quote or cite the filename when relevant.\n\n' + parts.join('\n\n')
    }
    systemParts.push(docsBlock)
  }
  // Tone (language/depth/candor). Content policy is handled by buildContentPrompt
  // above; the legacy protection fragment is now folded into the content dials.
  const _interactionFragment = buildInteractionFragment(p.interactionStyle)
  if (_interactionFragment) systemParts.push(_interactionFragment)

  // Volatile date/time/location goes LAST so the heavy stable prefix above stays
  // KV-cached across turns (the time string changes every minute).
  systemParts.push(
    [
      `Today is ${_date}, and the current time is ${_time}.`,
      `It's ${_partOfDay} for them — match that energy.`,
      p.userDisplayName ? `You are speaking with ${p.userDisplayName}.` : null,
      _loc ? `They are located in ${_loc}.` : null,
    ].filter(Boolean).join(' '),
  )

  // Vision: attach images to the final user turn (whatever fold — tool data,
  // offline notice, plain message — it ended up carrying).
  if (p.images && p.images.length > 0) {
    const lastMsg = ollamaMessages[ollamaMessages.length - 1]
    if (lastMsg?.role === 'user') lastMsg.images = p.images
  }

  if (systemParts.length > 0) {
    ollamaMessages = [{ role: 'system', content: systemParts.join('\n\n') }, ...ollamaMessages]
  }

  const _ctxChars = ollamaMessages.reduce((n, m) => n + m.content.length, 0)
  _lap(`stream-start msgs=${ollamaMessages.length} ~${Math.ceil(_ctxChars / 4)}tok`)
  let fullResponse = ''
  let firstToken = true
  let completed = false
  let capped = false
  let streamError: string | null = null
  const profanityBuf = p.maskProfanityActive ? new ProfanityStreamBuffer() : null

  // A mid-stream failure must not discard the partial reply — capture the error
  // and return the text streamed so far so the caller can persist/surface it.
  try {
    for await (const chunk of ollamaChatStream(p.model, ollamaMessages, p.options)) {
      // Respect explicit cancel signals
      if (h.signal.aborted) break

      if (chunk.message.content) {
        if (firstToken) { _lap('first-token'); firstToken = false }
        const raw = chunk.message.content
        fullResponse += raw
        if (artifactMode) {
          // Artifact body → stream into the canvas pane, NOT the chat bubble. No
          // profanity masking (it's code/document content, not spoken prose).
          emitEvent('artifact_token', JSON.stringify({ artifactId: artifactMode.artifactId, token: raw }))
        } else {
          const emitted = profanityBuf ? profanityBuf.flush(raw) : raw
          if (emitted) h.onToken(emitted)
        }
      }
      if (chunk.done) {
        // Drain any partial word left in the profanity buffer
        if (profanityBuf && !artifactMode) {
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
        // Reply hit num_predict — mark it so the caller can flag the message
        // (previously done_reason was silently ignored).
        if (chunk.done_reason === 'length') capped = true
      }
    }
  } catch (err) {
    streamError = String(err)
    logger.error(`[companion-turn] stream failed after ${fullResponse.length} chars: ${streamError}`)
  }

  // ── Canvas finalization ─────────────────────────────────────────────────────
  // The synthesis stream was the artifact body. Persist it as version 1, tell the
  // pane it's done, drop a compact card into the transcript, and replace the chat
  // message with a one-line pointer (the body lives in the canvas, not the bubble).
  let finalText = fullResponse
  if (artifactMode) {
    const body = stripWrappingFence(fullResponse).trim()
    try {
      if (body) await appendArtifactVersion(artifactMode.artifactId, body, 'assistant')
    } catch (e) {
      logger.warn(`[companion-turn] artifact persist failed: ${e}`)
    }
    emitEvent('artifact_done', JSON.stringify({ artifactId: artifactMode.artifactId, content: body }))
    emitEvent('block', JSON.stringify({
      kind: 'artifact',
      data: {
        artifactId: artifactMode.artifactId,
        artifactType: artifactMode.artifactType,
        title: artifactMode.title,
        preview: body.slice(0, 240),
      },
    }))
    finalText = `Created **${artifactMode.title}** in your canvas.`
    // Surface the pointer line in the chat bubble too (nothing else was streamed there).
    if (completed) h.onToken(finalText)
    toolNotes.push(`Canvas: created ${artifactMode.artifactType} "${artifactMode.title}"`)
    // Off-chat (voice/overlay/pod/telegram): the pane auto-opens, but also drop a
    // bell notification so it's findable later (the "always tray/notify" contract).
    if (completed && body && p.surface && p.surface !== 'chat') {
      void import('@/lib/notify').then((n) => n.emitNotification({
        type: 'system',
        userId: p.userId,
        title: 'Canvas ready',
        body: `"${artifactMode!.title}" is ready in your canvas.`,
        url: '/canvas',
      })).catch(() => {})
    }
  }

  return {
    text: finalText, // RAW — callers persist raw and mask at read time
    toolId: tool?.id ?? null,
    viaDirectReply: false,
    completed,
    capped,
    ...(streamError && { error: streamError }),
    ...(toolNotes.length > 0 && { toolNote: toolNotes.join(' | ').slice(0, 800) }),
  }
}

/** The model sometimes wraps a whole artifact body in a single ```lang … ``` fence
 *  despite being told not to. Strip exactly one such outer fence (leaving inner
 *  fences intact) so the canvas stores clean code/markdown, not a fenced blob. */
function stripWrappingFence(s: string): string {
  const t = s.trim()
  const m = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/)
  return m ? m[1]! : s
}

// ── Shared per-user/character context resolution ─────────────────────────────
// One resolver for all three surfaces (chat route, companion overlay, Pods):
// preferences, character row + persona, content-dial clamping, model selection,
// protections. Previously each surface duplicated this and they drifted.

export interface TurnContext {
  prefs: Record<string, unknown>
  charRow: typeof characters.$inferSelect | null
  characterSystemPrompt: string | null
  model: string
  options: Record<string, unknown>
  activeDials: ContentDials
  interactionStyle: import('@/lib/protections').InteractionStyle
  maskProfanityActive: boolean
  locale: import('@/routes/adminLocale').LocaleSettings
  protections: import('@/lib/protections').UserProtections
}

// Near-static per-user context barely changes turn to turn — a short TTL dedupes
// the ~7-query burst across rapid turns (voice especially) without meaningful
// staleness: admin/profile changes apply within TTL_MS.
const _turnCtxCache = new Map<string, { ctx: TurnContext; expiresAt: number }>()
const TURN_CTX_TTL_MS = 15_000

export function invalidateTurnContext(userId?: string): void {
  if (!userId) { _turnCtxCache.clear(); return }
  for (const key of _turnCtxCache.keys()) {
    if (key.startsWith(`${userId}:`)) _turnCtxCache.delete(key)
  }
}

export async function resolveTurnContext(
  userId: string,
  characterId: string | null,
  opts?: {
    /** Device-group reply-length override ('inherit'/unset → the character's own). */
    replyStyleOverride?: string | null
  },
): Promise<TurnContext> {
  const cacheKey = `${userId}:${characterId ?? ''}:${opts?.replyStyleOverride ?? ''}`
  const cached = _turnCtxCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.ctx

  const [prefs, charRow, locale, protections, interactionStyle, userCeiling] = await Promise.all([
    loadUserPrefs(userId),
    characterId
      ? db.select().from(characters).where(eq(characters.id, characterId)).limit(1).then((r) => r[0] ?? null)
      : Promise.resolve(null),
    getLocaleSettings(),
    getProtections(userId),
    getInteractionStyle(userId),
    getUserCeiling(userId),
  ])

  // ── Resolve the active content dials ──────────────────────────────────────
  // The user's ceiling = their assigned content profile (optionally self-lowered).
  // A character runs at its OWN authored config, but is CLAMPED to the user's ceiling
  // per category — it can never exceed what the account permits (rather than being
  // blocked outright).
  const charContent = charRow ? parseCharacterContent(charRow.contentDials) : null
  const activeDials: ContentDials = charContent ? clampDials(charContent.dials, userCeiling) : userCeiling
  // Candor is delivery: from the character for a character chat, else the user's style.
  const activeInteractionStyle = charContent ? { ...interactionStyle, candor: charContent.candor } : interactionStyle
  const maskProfanityActive = activeDials.profanity === 'off'

  let model = (prefs['chat_model'] as string | undefined) ?? await getModel()
  // If the user has uncensored LLM blocked, fall back to the default model when
  // their selected model is tagged uncensored in the catalog.
  if (protections.blockUncensoredLlm && model) {
    const catalogEntry = CATALOG.find((m) => m.id === model)
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

  const replyStyle = opts?.replyStyleOverride && opts.replyStyleOverride !== 'inherit'
    ? opts.replyStyleOverride as 'brief' | 'balanced' | 'detailed' | 'auto'
    : charRow?.replyStyle
  let characterSystemPrompt = charRow
    ? buildCompanionPrompt({ personalityPrompt: charRow.personalityPrompt, replyStyle, style: charRow.style, avatarConfig: charRow.avatarConfig, personaExamples: charRow.personaExamples })
    : null

  // Persona ↔ clamped-dials reconciliation: when the user's profile clamps a
  // character below its authored content level, the persona text ("teasing banter,
  // a little romantic spark") and the policy block would otherwise contradict —
  // producing flirt-then-refuse whiplash or dial bleed-through. One explicit line
  // resolves the tension in the persona's own voice.
  if (characterSystemPrompt && charContent) {
    const gate = characterGate(charContent.dials, userCeiling)
    if (gate.blockedBy.length > 0) {
      const clampedList = gate.blockedBy.map((b) => b.dial).join(', ')
      characterSystemPrompt += `\n\nRight now, this account's settings limit what you can express in: ${clampedList}. This is not a change to who you are — express your full personality warmly WITHIN those limits, never tease toward or hint at content you can't deliver, and never mention these limits unless the user asks directly.`
    }
  }

  const ctx: TurnContext = { prefs, charRow, characterSystemPrompt, model, options, activeDials, interactionStyle: activeInteractionStyle, maskProfanityActive, locale, protections }
  _turnCtxCache.set(cacheKey, { ctx, expiresAt: Date.now() + TURN_CTX_TTL_MS })
  return ctx
}
