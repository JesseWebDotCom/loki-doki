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
import { routePrompt, replanAfterDeadEnd, type RouteResult } from '@/llm/router'
import { ollamaChat, ollamaChatStream } from '@/llm/ollama'
import type { OllamaChatMessage } from '@/llm/ollama'
import { buildBlock, extractSources } from '@/lib/blockBuilder'
import { recallMemories, formatMemoriesForPrompt, matchPromptEntities } from '@/memory/recall'
import { recallNotesBlock } from '@/lib/notes/recall'
import { recallMethodBlock } from '@/lib/methods/recall'
import { getCachedMemoryBlock, setCachedMemoryBlock } from '@/memory/blockCache'
import { getMoodLine, maybeUpdateMood } from '@/memory/mood'
import { embed } from '@/llm/embed'
import { buildInteractionFragment, ProfanityStreamBuffer, getProtections, getInteractionStyle } from '@/lib/protections'
import { resolveToolConfig, getAllowedToolIds } from '@/lib/toolConfig'
import { toolRegistry, type Tool } from '@/tools'
import {
  isFollowUp as isHAFollowUp, hasRecentContext as hasRecentHAContext,
} from '@/lib/homeAssistant/context'
import { hasPendingCompanionAction, isConfirmationReply } from '@/lib/companionActions'
import { getActiveCuration, isCurationFollowUp } from '@/lib/music/curationSession'
import { isOffline } from '@/lib/connectivity'
import { getAppSetting } from '@/lib/settings'
import { friendshipLine } from '@/lib/friendshipMemory'
import { buildLocalePrompt, getLocaleSettings } from '@/routes/adminLocale'
import { buildContentPrompt, getUserCeiling, clampDials, parseCharacterContent, characterGate } from '@/lib/contentPolicy'
import type { ContentDials } from '@/lib/contentPolicy'
import { activeSkillsBlock } from '@/lib/skills/resolver'
import { getCachedBriefing } from '@/lib/briefing/cache'
import { ensureBriefingWarm, DEFAULT_BRIEFING_KEY } from '@/lib/briefing/refresh'
import { getCalendarBlock } from '@/lib/icloud/calendarBlock'
import { getMailNotifyLine } from '@/lib/icloud/mail/notify'
import { retrieveDocChunks, DOC_STUFF_BUDGET } from '@/lib/docChunks'
import { getModel, getFastModel, autotunedNumCtx } from '@/lib/models'
import { isAutomatic } from '@/lib/resourceMode'
import { markInteractive } from '@/lib/activityGate'
import { maybeStageLearnedAnswer, type LearnCandidate } from '@/lib/notes/learnedAnswer'
import { CATALOG } from '@/lib/catalog'
import { buildCompanionPrompt } from '@/lib/companionPrompt'
import { presentationPolicyFor, verbosityFragment } from '@/lib/presentationPrompt'
import { appendVersion as appendArtifactVersion, createArtifact } from '@/lib/artifacts/store'
import type { OpenArtifactDirective } from '@/tools'
import { logger } from '@/lib/logger'

// In-flight /api/chat/prime requests per user. A real turn cancels the user's
// prime before its own LLM call — the prime's processed prompt batches are
// already banked in the runner slot, and letting it finish would serialize the
// real call behind the remainder.
const activePrimes = new Map<string, () => void>()

// Structured side-channel events (mirror the chat route's SSE taxonomy). Data is
// pre-stringified so the chat route can forward it to the wire verbatim; the Pod
// ignores these.
// `status` is the companion-facing processing signal (Phase 2): a wordless "what
// am I doing right now" cue — `working`/`searching` while a tool runs, cleared when
// the reply starts. Distinct from `routing` (which drives the chat-side per-tool
// text labels); the two are emitted together. Consumers that don't recognize it
// (the chat stream) ignore it harmlessly.
// `spoken_cue` is the ONE line the companion may say about its own processing, and
// only on a genuine change of approach (see replanCue). Chat ignores it; voice
// surfaces speak it once.
export type CompanionTurnEvent = 'routing' | 'status' | 'spoken_cue' | 'offline' | 'tool_data' | 'block' | 'sources' | 'tool_error' | 'directive' | 'artifact_token' | 'artifact_done'

// Processing phases surfaced through the `status` event. Kept deliberately small:
// the companion shows an ambient, wordless "working" state — it never narrates the
// task ("checking the weather"), which reads as robotic.
export type CompanionStatusPhase = 'working' | 'searching' | 'retrying'

function statusPhaseFor(toolId: string): CompanionStatusPhase {
  return toolId === 'search' ? 'searching' : 'working'
}

// The ONLY thing the companion ever says about its own processing — and only when
// it genuinely changed approach after a dead end. These are deliberately
// content-free continuers, NOT task announcements ("Checking the weather…"):
// announcing the task is what makes an assistant feel like a phone tree, while
// reconsidering out loud is what a person actually does. Rotated per conversation
// so it never repeats back-to-back, and emitted at most once per turn.
const REPLAN_CUES = [
  'Hmm, let me try that a different way.',
  'That came up empty — one sec.',
  'Hold on, let me look at this from another angle.',
  'Hmm, one second.',
]

function replanCue(convId: string): string {
  let h = 0
  for (let i = 0; i < convId.length; i++) h = (h * 31 + convId.charCodeAt(i)) >>> 0
  return REPLAN_CUES[h % REPLAN_CUES.length]!
}

// Spoken ack for the START of a (multi-second) tool turn on VOICE surfaces (P1.5,
// see docs/internal/voice-latency.md). Like REPLAN_CUES these are deliberately
// content-free continuers, NOT task announcements ("Checking the weather…"): a
// brief "one sec" before a 5–8s search is what a person does and fills the dead
// air; naming the task is what makes an assistant feel like a phone tree. Kept
// short so that even on a faster-than-expected tool turn the ack doesn't crowd the
// answer. Varied per (conversation, message) so repeated tool use doesn't repeat
// the same line back to back.
const TOOL_ACK_CUES = [
  'One sec.',
  'Let me check.',
  'On it.',
  'Let me look that up.',
  'Give me a moment.',
]

function toolAckCue(convId: string, message: string): string {
  const s = `${convId}|${message}`
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return TOOL_ACK_CUES[h % TOOL_ACK_CUES.length]!
}

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
  /** HA area id of the device that produced this turn (a bound pod/dock), if any.
   *  Injected into the Home Assistant tool as the origin room for "here" and to break
   *  bare-domain ambiguity ("turn off the lights" → this room's lights). */
  originAreaId?: string | null
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
  /** KV-prime mode: build the exact system prompt + history this user's next real
   *  turn would send and run a num_predict=1 pass so Ollama prefills the prefix
   *  (llama-server reuses the longest common token prefix between requests). No
   *  routing, no tools, no persistence, no streaming — `message` should be ''.
   *  Fired by POST /api/chat/prime when a chat surface opens, so a new
   *  conversation's ~2s prefill happens while the user is still typing. */
  primeOnly?: boolean
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

// ── Gated contextual query rewrite (CHIQ pattern) ─────────────────────────────
// A search query that still points at the conversation ("who was he", "where is
// that") web-searches the pronoun, not the subject. Rewrite ONLY queries that are
// short and carry a dangling reference — rewriting a self-contained query
// measurably hurts retrieval — and only on a dedicated fast model (rewriting on
// the chat model would clobber the speculative KV prime). Any failure or timeout
// keeps the original query; this path can never break a search.
const REWRITE_DEIXIS_RE = /\b(?:he|she|him|her|his|hers|they|them|their|it|its|that|this|those|these)\b/i
const REWRITE_MAX_QUERY_LEN = 60
const QUERY_REWRITE_BUDGET_MS = 1500

function isContextualQuery(query: string, historyLen: number): boolean {
  const q = query.trim()
  return historyLen > 0 && q.length <= REWRITE_MAX_QUERY_LEN && REWRITE_DEIXIS_RE.test(q)
}

async function rewriteContextualQuery(query: string, history: OllamaChatMessage[], chatModel: string): Promise<string | null> {
  try {
    const fastModel = await getFastModel()
    if (fastModel === chatModel) return null // no dedicated fast model — keep the original
    const context = history.slice(-4)
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 400)}`)
      .join('\n')
    const res = await ollamaChat(
      fastModel,
      [
        { role: 'system', content: 'Rewrite the search query so it stands alone: replace pronouns and vague references ("he", "that movie", "there") with the actual names or subjects from the conversation. Keep it a short web search query. Reply with ONLY the rewritten query and nothing else. If the query already stands alone, reply with it unchanged.' },
        { role: 'user', content: `Conversation:\n${context}\n\nSearch query: ${query}` },
      ],
      undefined,
      { temperature: 0.1, num_predict: 40 },
      undefined,
      QUERY_REWRITE_BUDGET_MS,
    )
    const out = res.message.content?.trim().replace(/^["']|["']$/g, '').replace(/\n[\s\S]*$/, '')
    if (!out || out.length < 3 || out.length > 200) return null
    return out
  } catch {
    return null
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

  // Mark the conversation live so background jobs (podcast transcription, stems,
  // memory sweep) yield to it and never lag the reply. Primes excluded — a KV prime
  // is not a live turn. (Phase 3 priority ladder, lib/activityGate.ts.)
  if (!p.primeOnly) markInteractive()

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

  // ── Memory + notes + methods blocks (cached per conversation; entity-aware staleness) ─
  let memoryBlock: string | null = null
  let notesBlock: string | null = null
  let methodsBlock: string | null = null
  const cachedMem = getCachedMemoryBlock(p.convId, promptEntityIds, p.primeOnly ? undefined : p.message)
  if (cachedMem) {
    memoryBlock = cachedMem.memoryBlock
    notesBlock = cachedMem.notesBlock
    methodsBlock = cachedMem.methodsBlock
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
    p.primeOnly
      ? Promise.resolve({ tool: null, args: {}, path: 'prime' } as RouteResult)
      : routePrompt(p.message, history, p.model, {
          numCtx: p.options['num_ctx'] as number | undefined,
          allowedToolIds,
        }),
    cachedMem
      ? Promise.resolve(null as { memory: string | null; notes: string | null; methods: string | null } | null)
      : embed(p.message)
          .then(async (embedding) => {
            _lap('embed-done')
            // Memory, notes, and learned-methods recall all share the message
            // embedding; notes/methods failures never cost the turn its memory block.
            const [memory, notes, methods] = await Promise.all([
              recallMemories(p.message, p.userId, p.characterId, embedding, promptEntityIds)
                .then((recalled) => formatMemoriesForPrompt(recalled, p.userId, p.characterId, embedding, p.message)),
              recallNotesBlock(p.message, p.userId, embedding).catch(() => null),
              recallMethodBlock(p.message, p.userId, embedding).catch(() => null),
            ])
            return { memory, notes, methods }
          })
          .catch(() => null as { memory: string | null; notes: string | null; methods: string | null } | null),
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
    memoryBlock = computedMemory?.memory ?? null
    notesBlock = computedMemory?.notes ?? null
    methodsBlock = computedMemory?.methods ?? null
    // A prime's block was recalled for '' — caching it would hand the real turn a
    // block with no message-specific vector hits (quality loss beats the KV win).
    if (!p.primeOnly) setCachedMemoryBlock(p.convId, memoryBlock, { entityIds: promptEntityIds, userId: p.userId, notesBlock, methodsBlock, prompt: p.message })
    _lap('memory-done(computed)')
  }

  _lap('route-done')
  let { tool, args } = routeResult

  // Pending-confirmation replies: a bare "yes"/"cancel" answering a staged
  // action (unlock the door, forget a memory, ...) would otherwise route as
  // chitchat. Force it to the confirm_pending pseudo-tool, which resolves the
  // staged action in lib/companionActions. Not gated on allowedToolIds: it is
  // core plumbing, same class as memory.
  const pendingConfirm = isConfirmationReply(p.message) && hasPendingCompanionAction(p.userId, p.convId)
  if (pendingConfirm) {
    const confirmTool = toolRegistry.find((t) => t.id === 'confirm_pending')
    if (confirmTool) { tool = confirmTool; args = { text: p.message } }
  }

  // Home Assistant follow-ups ("I meant 20", "turn those off") carry no device
  // keywords, so the router can't catch them. If we just ran an HA command in
  // this conversation, treat an adjustment-shaped message as a follow-up to it.
  const haFollowUp = isHAFollowUp(p.message) && hasRecentHAContext(p.userId, p.convId)
  if (!pendingConfirm && (!tool || tool.id !== 'homeAssistant') && haFollowUp && allowedToolIds.has('homeAssistant')) {
    const haTool = toolRegistry.find((t) => t.id === 'homeAssistant')
    if (haTool) { tool = haTool; args = { text: p.message } }
  }

  // Playlist-curation follow-ups ("add some Bad Bunny", "make it more upbeat", "drop
  // the last one") carry no playlist name, so the router reads them as chitchat/playback.
  // While a curation session is live (the tool just built/edited a playlist), treat a
  // refine-shaped message as a follow-up to it. Gated on an active session, so the same
  // phrase in a normal chat still routes normally.
  const curationFollowUp = isCurationFollowUp(p.message) && !!getActiveCuration(p.userId)
  if (!pendingConfirm && (!tool || tool.id !== 'curate_playlist') && curationFollowUp && allowedToolIds.has('curate_playlist')) {
    const curateTool = toolRegistry.find((t) => t.id === 'curate_playlist')
    if (curateTool) { tool = curateTool; args = { query: p.message } }
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

  // Freshness grounding for STATEMENTS (audit Phase 4): an opinion or remark about
  // something time-sensitive ("Taylor's new album is great", "crazy what happened
  // in the election") isn't question-shaped, matches no tool, and would be answered
  // purely from stale training weights. When the message names a clearly
  // time-sensitive subject, run a background-style search and fold the results so
  // the companion reacts to what actually happened. The regex is deliberately
  // narrow — everyday chit-chat must never pay a search round trip.
  const FRESHNESS_RE = /\b(?:new (?:album|movie|song|show|season|game|phone|model)|just (?:dropped|released|came out|announced|launched)|(?:the|this) election|breaking news|big news|the news today|went viral|trending)\b/i
  if (!tool && !p.primeOnly && !offlineMode && FRESHNESS_RE.test(p.message) && allowedToolIds.has('search')) {
    const freshSearch = toolRegistry.find((t) => t.id === 'search')
    if (freshSearch) {
      logger.info(`[companion-turn] freshness grounding: searching for statement "${p.message.slice(0, 60)}"`)
      tool = freshSearch
      args = { query: p.message }
    }
  }

  // Per-message length nudge (Phase 3): the router already classified this message,
  // so `tool` is final here (after all the follow-up overrides above). A prompt hint
  // only — num_predict stays a ceiling. Captured now so the speculative KV prime and
  // the real prompt build the identical system prefix.
  const verbosityHint = verbosityFragment({ ...routeResult, tool, args }, p.message, p.surface)

  const hasClientCoords = typeof p.clientLat === 'number' && typeof p.clientLng === 'number'
  // Prime mode sends history WITHOUT a trailing user message — an empty user turn
  // would render template tokens the real turn's prompt doesn't share.
  let ollamaMessages: OllamaChatMessage[] = p.primeOnly
    ? [...history]
    : [...history, { role: 'user', content: p.message }]

  // Canvas artifact mode: when a tool opens an artifact (the `canvas` tool emits an
  // `open_artifact` directive), the LLM synthesis pass that follows IS the artifact
  // body. We tee those tokens into `artifact_token` events (streamed live into the
  // canvas pane) instead of the chat bubble, persist them as the artifact's first
  // version, and leave a compact "Created …" line in the transcript. Set inside the
  // tool block below; consumed by the streaming loop.
  let artifactMode: OpenArtifactDirective | null = null

  // Phase 2 learned-answers: set when a home_inventory device lookup returns a
  // grounded manual excerpt. After the turn streams, a grounded answer is distilled
  // and STAGED (behind a confirm) to the device's notes, so repeat questions get a
  // saved answer instead of re-reasoning. Only manual-grounded turns qualify.
  let learnCandidate: LearnCandidate | null = null

  // Speculative KV prime: while a routed tool executes (network-bound), prefill
  // the system+history+user-message prefix on the chat model, so the post-tool
  // synthesis call only pays prefill for the folded tool result. llama-server
  // reuses the longest common token prefix between consecutive requests, and the
  // tool fold is APPENDED to the last user message, so the primed prompt is a
  // strict token prefix of the real one. The prime is CANCELLED the moment the
  // real call is ready: processed prompt batches stay banked in the runner's slot
  // cache, so a fast tool (weather ~0.5s) isn't stuck queueing behind a 3s prime —
  // measured 6.1s vs 5.1s first-token when an uncancellable prime blocked the slot.
  let systemPartsPromise: Promise<string[]> | null = null
  let cancelKvPrime: () => void = () => {}
  const fireKvPrime = () => {
    if (p.images?.length) return // vision prompts don't share a text-token prefix
    activePrimes.get(p.userId)?.() // don't queue behind a stale endpoint prime
    systemPartsPromise = buildSystemParts()
    const _tPrime = performance.now()
    const cancelRef: { cancel?: () => void } = {}
    let cancelled = false
    cancelKvPrime = () => {
      cancelled = true
      cancelRef.cancel?.()
    }
    void systemPartsPromise
      .then(async (parts) => {
        if (cancelled) return
        const gen = ollamaChatStream(
          p.model,
          [
            ...(parts.length > 0 ? [{ role: 'system' as const, content: parts.join('\n\n') }] : []),
            ...history,
            { role: 'user' as const, content: p.message },
          ],
          { ...p.options, num_predict: 1, temperature: 0 },
          cancelRef,
        )
        // First chunk = prefill complete; break destroys the socket (finally).
        for await (const _ of gen) break
        _lap(`kv-prime-done ${(performance.now() - _tPrime).toFixed(0)}ms`)
      })
      .catch(() => { /* cancelled or failed — the real call picks up the prefix */ })
  }

  // Multi-intent turns ("turn off the lights and play some jazz"): the extra
  // calls run serially after the primary, each folding its result into the turn.
  const extraCalls = (routeResult.extraCalls ?? []).filter(
    (c) => allowedToolIds.has(c.tool.id) && (c.tool.offline || !offlineMode),
  )
  // Per-tool notes, persisted with the reply so follow-up turns still see what
  // the tools actually returned (history otherwise only keeps raw text). The note
  // records the answer_payload — the SAME view the LLM synthesized from — so a
  // follow-up turn reconstructs the model's actual context, not a differently
  // truncated raw dump. Caps raised 600→1500 per tool / 800→2400 total (2026-08):
  // "what was the third headline's source?" was unanswerable because the detail
  // was summarized away. History folding keeps only the NEWEST note at full size
  // (see chat.ts), so the token budget doesn't bloat across turns.
  const toolNotes: string[] = []
  const noteFor = (name: string, data: unknown): string => {
    const payload = (data as { answer_payload?: unknown } | null)?.answer_payload
    return `${name} → ${JSON.stringify(payload ?? data ?? null).slice(0, 1500)}`
  }

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
    if (p.originAreaId) cfg['_originAreaId'] = p.originAreaId
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

  // ── Re-plan (Phase 4) ───────────────────────────────────────────────────────
  // One extra hop out of a dead end, never more. Skipped on primes and on
  // multi-intent turns (a compound command's failure is better explained than
  // silently re-attempted). Returns null whenever the second attempt is no better
  // than the first, so the caller falls back to the honest "found nothing" fold.
  let replanUsed = false
  const tryReplan = async (
    deadTool: Tool,
    deadArgs: unknown,
    outcome: 'empty' | 'error',
  ): Promise<{ tool: Tool; args: unknown; result: import('@/tools').ToolResult } | null> => {
    if (replanUsed || p.primeOnly || extraCalls.length > 0) return null
    replanUsed = true

    // Deferred tool loading, in miniature: a re-plan is either "same tool, better
    // query" or "fall back to the web", so only those two schemas are loaded — the
    // router model stays near its latency floor instead of reading 57 definitions.
    const searchTool = toolRegistry.find((t) => t.id === 'search')
    const candidates = [deadTool, ...(searchTool && searchTool.id !== deadTool.id ? [searchTool] : [])]
      .filter((t) => allowedToolIds.has(t.id) && (t.offline || !offlineMode))
    if (candidates.length === 0) return null

    emitEvent('status', JSON.stringify({ phase: 'retrying', toolId: deadTool.id }))
    emitEvent('spoken_cue', JSON.stringify({ text: replanCue(p.convId) }))

    const r = await replanAfterDeadEnd(
      p.model,
      p.message,
      history,
      { toolName: deadTool.name, args: deadArgs, outcome },
      candidates,
      p.options['num_ctx'] as number | undefined,
    )
    if (!r.tool) return null

    let res: import('@/tools').ToolResult
    try {
      res = await r.tool.execute(r.args, await buildToolConfig(r.tool.id))
    } catch (err) {
      logger.warn(`[companion-turn] replan tool ${r.tool.id} threw: ${err}`)
      return null
    }
    _lap(`replan-tool-done(${r.tool.id})`)
    // A second dead end → stop. Two failures is a real "I couldn't find it", and
    // the original fold says so honestly rather than looping.
    if (!res.success || res.offline || isEmptyResult(res.data)) return null
    return { tool: r.tool, args: r.args, result: res }
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
    // Companion-facing wordless "I'm on it" cue — shown while the tool runs, so a
    // voice/overlay turn looks actively engaged instead of idly "thinking".
    emitEvent('status', JSON.stringify({ phase: statusPhaseFor(tool.id), toolId: tool.id }))

    // Spoken ack (P1.5): on voice surfaces, say a short continuer the instant we
    // commit to a tool turn so a multi-second lookup doesn't play as dead air. It
    // queues AHEAD of the reply chunks (client enqueueSpeech), so it fills the beat
    // and the answer follows. Voice-only (chat shows the wordless status label);
    // skipped when this online tool can't run offline (that branch just explains it).
    // OFF by default (`voice.tool_ack_enabled`): the filler delays the actual answer,
    // which some find slower than a moment of silence. Opt in per taste.
    const isVoiceSurface = p.surface === 'overlay' || p.surface === 'pod'
    if (isVoiceSurface && !(!tool.offline && offlineMode) && (await getAppSetting('voice.tool_ack_enabled')) === true) {
      emitEvent('spoken_cue', JSON.stringify({ text: toolAckCue(p.convId, p.message) }))
    }

    if (!tool.offline && offlineMode) {
      emitEvent('offline', JSON.stringify({ tool: tool.id }))
      ollamaMessages = [
        ...history,
        { role: 'user', content: `${p.message}\n\n[${tool.name}]: Offline mode is enabled — this tool requires internet. Let the user know and suggest they enable online mode in Settings → Tools.` },
      ]
    } else {
      // Prefill the prompt prefix while the tool does its (network-bound) work.
      fireKvPrime()

      // Contextual search queries get one budgeted standalone-rewrite on the fast
      // model, so "who was he?" searches the person from the prior turn instead of
      // the literal pronoun. Runs while the KV prime prefills (different model).
      if (tool.id === 'search') {
        const q = (args as { query?: unknown } | null)?.query
        if (typeof q === 'string' && isContextualQuery(q, history.length)) {
          const rewritten = await rewriteContextualQuery(q, history, p.model)
          if (rewritten && rewritten.toLowerCase() !== q.trim().toLowerCase()) {
            logger.info(`[companion-turn] contextual query rewrite: "${q.slice(0, 60)}" → "${rewritten.slice(0, 80)}"`)
            args = { ...(args as object), query: rewritten }
          }
        }
      }

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

      // ── Bounded re-plan: observe → re-plan, ONE hop, dead ends only ──────────
      // A successful tool call never reaches this, so the happy path keeps its
      // current latency exactly. Only a genuine dead end (no results / an error)
      // buys a second attempt — which is also the only moment the companion has
      // something honest to say about its own thinking (see replanCue).
      const deadEnd = !result.offline && (!result.success || isEmptyResult(result.data))
      if (deadEnd) {
        const rp = await tryReplan(tool, args, result.success ? 'empty' : 'error')
        if (rp) {
          // Adopt the recovered attempt wholesale — the normal success path below
          // then emits/folds it as if it had been the original route.
          tool = rp.tool
          args = rp.args
          result = rp.result
        }
      }

      if (result.offline) {
        emitEvent('offline', JSON.stringify({ tool: tool.id }))
        ollamaMessages = [
          ...history,
          { role: 'user', content: `${p.message}\n\n[${tool.name}]: The service is offline or unavailable right now. Let the user know this specific tool is offline and suggest they try again later.` },
        ]
      } else if (result.success) {
        emitEvent('tool_data', JSON.stringify({ tool: tool.id, data: result.data }))

        // Learned-answers provenance gate: only a home_inventory device lookup that
        // returned a non-empty manual excerpt qualifies. Pure-LLM or list-only
        // answers never reach the staging path.
        if (tool.id === 'home_inventory' && !p.primeOnly) {
          const invArgs = args as { deviceId?: string }
          const d = result.data as { device?: { name?: string }; manualContext?: string | null } | null
          if (invArgs.deviceId && d?.device?.name && typeof d.manualContext === 'string' && d.manualContext.trim()) {
            learnCandidate = {
              userId: p.userId,
              convId: p.convId,
              isAdmin: p.userRole === 'admin',
              deviceId: invArgs.deviceId,
              deviceName: d.device.name,
              question: p.message,
              groundedSource: d.manualContext,
            }
          }
        }

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
          : `${p.message}\n\n[${tool.name} data]: ${llmFold(result.data)}\n\nAnswer the question directly from this data: state the answer in your first sentence, in your own voice, with no preamble.${sourceList}`
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
    emitEvent('status', JSON.stringify({ phase: statusPhaseFor(call.tool.id), toolId: call.tool.id }))
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
  //
  // A hoisted function so the tool branch above can start it (and a speculative
  // KV prime) BEFORE the tool executes: everything here depends only on the
  // parallel-batch results, never on tool output. Built exactly once per turn —
  // the primed prompt and the real prompt must be token-identical (same minute
  // string), or the prime's prefill is wasted.
  async function buildSystemParts(): Promise<string[]> {
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
    // Presentation policy FIRST — it's global and static (same for every text user),
    // so it forms a shared prefix that warmupModel() pre-warms, giving even
    // non-default-profile users a turn-1 KV hit before the per-profile content block.
    // Suppressed on pure-voice surfaces (nothing here is speakable). If you change
    // this text, update warmupModel() in models.ts or turn 1 pays full prefill.
    const presentationPolicy = presentationPolicyFor(p.surface)
    if (presentationPolicy) systemParts.push(presentationPolicy)
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
    // NOTE — stable→volatile ordering, refined: the memory block is recalled per
    // MESSAGE (vector hits vary with the query), so it used to sit here and bust
    // the KV cache for everything after it — briefing, skills, and (worst) a
    // multi-KB docs block re-prefilled on every memory change, and a KV prime
    // could never cover them. Memory/summary/uiContext now go AFTER the stable
    // blocks, in the late volatile zone just before the time line.
    if (briefingBlock) systemParts.push(briefingBlock)
    // Household calendar (iCloud sync): same warm-cache pattern as the briefing —
    // synchronous read, background refresh, ~10-min stability keeps the prefix KV-safe.
    // Local data, so it works offline; empty string until synced or when gated off.
    const calendarBlock = getCalendarBlock()
    if (calendarBlock) systemParts.push(calendarBlock)
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

    // Answer-first discipline: when the user asks a question, the FIRST sentence is
    // the answer. Personality goes after the answer, never in front of it. Small
    // models otherwise pad replies with greetings, clock commentary ("it's 3 AM,
    // you're up late"), restating the question, and "let me check" filler.
    systemParts.push(
      'When the user asks a question, your very first sentence must contain the answer. ' +
      'Do not open with a greeting or their name, do not remark on the time or how late it ' +
      'is, do not repeat their question back, do not say you are glad they asked, and do not ' +
      'say you will look it up. This overrides your usual conversational style. After the ' +
      'direct answer you may add a sentence or two of personality or useful detail. Keep ' +
      'replies to simple factual questions short.',
    )

    // Knowledge-cutoff honesty (Anthropic's published pattern, adapted): stale
    // training data must never be presented as current. All "is this recent" logic
    // stays in code (tools, briefing, the date line below) — the model is only
    // asked to be honest about the boundary, never to compute it.
    systemParts.push(
      'Your built-in knowledge has a training cutoff in the past and the world has moved on ' +
      'since. Tool results, the briefing, and other data in this prompt are LIVE and always ' +
      'outrank your memory when they conflict — when live data IS provided, answer from it ' +
      'plainly with no hedging about it possibly being outdated. Only for topics that may ' +
      'have changed recently (news, prices, releases, scores, people in the news) with NO ' +
      'live data provided, say your information may be out of date and offer to look it up. ' +
      'If the user mentions an event you have no knowledge of, neither confirm nor deny it ' +
      'from memory — offer to search instead. Never present remembered news as current, and ' +
      'never pad an answer with ambient details from this prompt (the time, the weather, ' +
      'their location) that were not asked about.',
    )

    // ── Late volatile zone ── everything below changes turn-to-turn (memory =
    // per-message recall, summary = every few turns, uiContext = per page), so it
    // sits after the stable prefix. Bonus: end-of-prompt recency bias gives the
    // recalled memories MORE attentional weight, not less.
    if (memoryBlock) systemParts.push(memoryBlock)
    if (notesBlock) systemParts.push(notesBlock)
    if (methodsBlock) systemParts.push(methodsBlock)
    // Older conversation content the trimmed history window no longer carries.
    if (p.conversationSummary) {
      systemParts.push(`## Earlier in this conversation\n${p.conversationSummary}`)
    }
    if (p.uiContext) systemParts.push(p.uiContext)
    // Flagged-mail line (iCloud M5): per-viewer and volatile (verdicts land all day),
    // so it lives in the late zone. Warm-cache read; '' until the gate + a verdict exist.
    const mailLine = getMailNotifyLine({ id: p.userId, role: p.userRole })
    if (mailLine) systemParts.push(mailLine)
    // Emotional continuity: the user's freshest mood (explicit external state,
    // classified post-turn on the fast model) rendered as tone guidance. Warm
    // synchronous read; changes rarely, so it's KV-friendly in the late zone.
    const moodLine = getMoodLine(p.userId)
    if (moodLine) systemParts.push(moodLine)
    // Per-message length nudge (Phase 3) — volatile (depends on this message's route),
    // so it sits in the late zone next to the other per-turn blocks. Cheap (~20 tokens).
    if (verbosityHint) systemParts.push(verbosityHint)

    // Anti-drift persona reminder: attention over the system prompt decays with
    // distance, and persona drift is measurable within ~8 turns even on large
    // models — the persona sits near the TOP of this prompt, farthest from the
    // generation point. A compressed reminder near the END re-anchors it. Stable
    // per conversation, so it is KV-safe in the late zone.
    if (p.characterSystemPrompt) {
      const personaCore = p.characterSystemPrompt.split('\n\n')[0]?.trim()
      if (personaCore) systemParts.push(`Reminder — you are still fully in character, every turn: ${personaCore}`)
    }

    // Volatile date/time/location goes LAST so the heavy stable prefix above stays
    // KV-cached across turns (the time string changes every minute).
    systemParts.push(
      [
        `Today is ${_date}, and the current time is ${_time}.`,
        `It's ${_partOfDay} for them. Mention the time or the hour only if they ask about it.`,
        p.userDisplayName ? `You are speaking with ${p.userDisplayName}.` : null,
        _loc ? `They are located in ${_loc}.` : null,
      ].filter(Boolean).join(' '),
    )
    return systemParts
    }

  const systemParts = await (systemPartsPromise ?? buildSystemParts())

  // Vision: attach images to the final user turn (whatever fold — tool data,
  // offline notice, plain message — it ended up carrying).
  if (p.images && p.images.length > 0) {
    const lastMsg = ollamaMessages[ollamaMessages.length - 1]
    if (lastMsg?.role === 'user') lastMsg.images = p.images
  }

  if (systemParts.length > 0) {
    ollamaMessages = [{ role: 'system', content: systemParts.join('\n\n') }, ...ollamaMessages]
  }

  // Prime mode: run a 1-token pass over the assembled prefix so llama-server's
  // slot cache holds it, then stop — no streaming, nothing persisted. The user's
  // real turn (same system prompt + history + their typed message appended) then
  // only prefills the new tokens instead of the whole ~1-2k-token prompt.
  if (p.primeOnly) {
    const _tPrime = performance.now()
    const cancelRef: { cancel?: () => void } = {}
    const cancelFn = () => cancelRef.cancel?.()
    activePrimes.get(p.userId)?.() // replace any older prime for this user
    activePrimes.set(p.userId, cancelFn)
    try {
      const gen = ollamaChatStream(p.model, ollamaMessages, { ...p.options, num_predict: 1, temperature: 0 }, cancelRef)
      // First chunk = prefill complete; break destroys the socket in finally.
      for await (const _ of gen) break
      _lap(`prime-done msgs=${ollamaMessages.length} ${(performance.now() - _tPrime).toFixed(0)}ms`)
    } catch {
      _lap('prime-cancelled-or-failed')
    } finally {
      if (activePrimes.get(p.userId) === cancelFn) activePrimes.delete(p.userId)
    }
    return { text: '', toolId: null, viaDirectReply: false, completed: true }
  }

  const _ctxChars = ollamaMessages.reduce((n, m) => n + m.content.length, 0)
  // Per-part char sizes (system prompt build order) — makes prompt bloat visible in
  // the timing log: prefill cost is linear in prompt tokens (~4 chars/token estimate,
  // though prompt_eval in llm-done is the ground truth and often runs ~2x this).
  _lap(`stream-start msgs=${ollamaMessages.length} ~${Math.ceil(_ctxChars / 4)}tok sysParts=[${systemParts.map((s) => s.length).join(',')}]ch`)
  let fullResponse = ''
  let firstToken = true
  let completed = false
  let capped = false
  let streamError: string | null = null
  const profanityBuf = p.maskProfanityActive ? new ProfanityStreamBuffer() : null

  // Free the runner slot NOW: an in-flight KV prime (tool-window or endpoint) has
  // already banked whatever prompt batches it processed; letting it run to
  // completion would serialize the real call behind the remainder.
  cancelKvPrime()
  activePrimes.get(p.userId)?.()

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

  // ── Learned-answers offer ─────────────────────────────────────────────────
  // A grounded device answer just streamed. Distill it and, if there's a reusable
  // fact, append a one-line "save that?" offer + a confirm directive so a later
  // "yes" writes it to the device's notes (via the same staged-action flow as any
  // other confirmation). Never on the artifact path (finalText is a pointer line).
  if (learnCandidate && completed && !artifactMode && finalText.trim().length >= 20) {
    try {
      const staged = await maybeStageLearnedAnswer(learnCandidate, finalText, await getFastModel())
      if (staged) {
        const offer = `\n\n${staged.prompt}`
        h.onToken(offer)
        emitEvent('directive', JSON.stringify(staged.directive))
        finalText += offer
      }
    } catch (e) {
      logger.warn(`[companion-turn] learned-answer staging failed: ${e}`)
    }
  }

  // ── Artifact auto-promotion (Phase 5) ──────────────────────────────────────
  // Runs AFTER the stream, never during it: the prose the user already read stays
  // byte-for-byte as delivered, and the long code block simply also becomes an
  // openable canvas artifact. Never on the artifact path (finalText is a pointer
  // line there) and never on primes. Best-effort — a failure must not cost the reply.
  if (completed && !artifactMode && !p.primeOnly) {
    const promo = promotableCodeBlock(finalText)
    if (promo) {
      try {
        const title = promotedArtifactTitle(promo.lang, p.message)
        const row = await createArtifact({
          userId: p.userId,
          type: 'code',
          title,
          language: promo.lang,
          conversationId: p.convId,
          content: promo.code,
        })
        emitEvent('block', JSON.stringify({
          kind: 'artifact',
          data: { artifactId: row.id, artifactType: row.type, title: row.title, preview: promo.code.slice(0, 240) },
        }))
        _lap(`artifact-promoted(${promo.lang ?? 'code'})`)
        toolNotes.push(`Canvas: promoted ${promo.lang ?? 'code'} to artifact "${title}"`)
      } catch (e) {
        logger.warn(`[companion-turn] artifact auto-promotion failed: ${e}`)
      }
    }
  }

  // Emotional-state upkeep (detached, all surfaces): an emotionally loaded user
  // message updates their mood row via a short fast-model classification. Regex-
  // gated inside, so ordinary turns cost nothing.
  if (completed && !p.primeOnly) maybeUpdateMood(p.userId, p.message, p.model)

  return {
    text: finalText, // RAW — callers persist raw and mask at read time
    toolId: tool?.id ?? null,
    viaDirectReply: false,
    completed,
    capped,
    ...(streamError && { error: streamError }),
    ...(toolNotes.length > 0 && { toolNote: toolNotes.join(' | ').slice(0, 2400) }),
  }
}

// ── Artifact auto-promotion (Phase 5) ────────────────────────────────────────
// Claude's published threshold: standalone code past ~20 lines belongs in a
// document pane, not a chat bubble. The `canvas` TOOL already covers the explicit
// ask ("write me a script"); this covers the rest — a conversational answer that
// happened to produce a long code block, which the router never sent to canvas.
//
// CODE ONLY, deliberately. Claude's rule also promotes long standalone documents,
// but "the user asked for a document" can't be inferred reliably from a reply, and
// auto-promoting every long prose answer would be intrusive — that case stays with
// the canvas tool's explicit route.
const ARTIFACT_MIN_LINES = 20

/** The longest fenced code block in a reply, if any clears the promotion threshold. */
function promotableCodeBlock(text: string): { lang: string | null; code: string } | null {
  const re = /```([\w+#.-]*)[^\S\n]*\n([\s\S]*?)```/g
  let best: { lang: string | null; code: string; lines: number } | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const code = (m[2] ?? '').replace(/\n+$/, '')
    if (!code.trim()) continue
    const lines = code.split('\n').length
    if (lines >= ARTIFACT_MIN_LINES && (!best || lines > best.lines)) {
      best = { lang: (m[1] ?? '').trim() || null, code, lines }
    }
  }
  return best ? { lang: best.lang, code: best.code } : null
}

function promotedArtifactTitle(lang: string | null, message: string): string {
  const base = message.trim().replace(/\s+/g, ' ').slice(0, 48)
  if (base) return base.charAt(0).toUpperCase() + base.slice(1)
  return lang ? `${lang} snippet` : 'Code snippet'
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
    // Automatic owns the context window (fitted to VRAM); a user pref can't raise it
    // past the budget and force a spill. Manual honours the pref.
    num_ctx: isAutomatic()
      ? autotunedNumCtx()
      : ((prefs['ctx_limit'] as number | undefined) ?? autotunedNumCtx()),
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
    ? buildCompanionPrompt({ personalityPrompt: charRow.personalityPrompt, replyStyle, style: charRow.style, avatarConfig: charRow.avatarConfig, personaExamples: charRow.personaExamples, backstory: charRow.backstory })
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
