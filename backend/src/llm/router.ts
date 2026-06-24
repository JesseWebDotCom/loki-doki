import { embedForRouter, cosineSimilarity } from './embed'
import { toolRegistry } from '@/tools'
import type { Tool } from '@/tools'
import { ollamaChat } from './ollama'
import type { OllamaChatMessage } from './ollama'
import { getRouterModel } from '@/lib/models'
import { logger } from '@/lib/logger'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const CACHE_DIR = join(process.cwd(), '..', 'data')
const CACHE_FILE = join(CACHE_DIR, 'router-index.json')

// SIMILARITY_THRESHOLD: at/above this = confident Tier 1 match.
// Below this = Tier 2 (narrowed LLM call).
const SIMILARITY_THRESHOLD = 0.65

// CONVERSATIONAL_THRESHOLD: below this = clearly not a tool request, skip Tier 2 entirely.
// Saves a full LLM round trip for greetings/chitchat that just didn't match the fast-path regex.
// Original HEAD value was 0.40 — restored to match intended ambiguous band of 0.40–0.65.
const CONVERSATIONAL_THRESHOLD = 0.40

// Matches information-seeking messages that skip Tier 2 entirely — routed directly to search.
// Covers "who is/was/played/directed/wrote/starred", "what is/was/are", temporal/location
// lookups, quantity questions, and explicit search commands. Intentionally excludes
// "how do I / how to" (routes to youtube/recipes) and "when is" (routes to datetime).
const SEARCH_INTENT_RE = /\b(what is|what are|what was|what were|who is|who was|who are|who played|who starred|who directed|who wrote|who sang|who voiced|who invented|who created|who founded|who made|tell me about|tell me more about|explain to me|explain what|how does|how do|how did|how many|how much|how long|how far|how tall|how old|how big|when did|when was|when were|where is|where was|where are|where were|where did|have you heard of|do you know about|what happened to|what's up with|search for|look up|find out about|can you find out|can you look up|can you search)\b/i

// A message shaped like a question — leads with an interrogative or ends with "?".
// Used so a LOW-confidence question still escalates to Tier 2 (which always includes
// search) instead of dropping to the conversational "no tool → answer from memory"
// path, where the model would invent facts ("what is Claude Mythos?" → a made-up
// Highlander character) rather than look them up. Greetings are filtered earlier.
const QUESTION_RE = /^(?:who|what|what'?s|whats|whatre|whens?|where'?s|where|which|whose|why|how|is|are|was|were|do|does|did|can|could|will|would|has|have|had|should)\b|\?\s*$/i

// Pure social/chitchat questions that need no tool — short-circuit so they don't pay a
// Tier 2 round trip just because QUESTION_RE matched ("how are you", "what's up").
const SOCIAL_QUESTION_RE = /^(?:how (?:are|r|have) (?:you|u|ya|been)|how'?s it going|how'?s your|what'?s up|whats up|what are you (?:up to|doing)|are you (?:ok|okay|there|sure|free|busy))\b/i

// Follow-up lookup commands whose SUBJECT lives in the prior turns, not the
// command itself ("why don't you look it up", "google it", "search that",
// "fact-check it"). These must NOT use the literal-passthrough fast path — that
// would search the command text. They route to a history-aware Tier 2 so the
// query is reconstructed from conversation context.
const CONTEXTUAL_LOOKUP_RE = /\b(?:look\s+(?:it|that|this|him|her|them|those|these)\s+up|google\s+(?:it|that|this|him|her|them)|search\s+(?:it|that|this)|find\s+(?:it|that|this)\s+out|look\s+into\s+(?:it|that|this)|fact[-\s]?check\s+(?:it|that|this)|verify\s+(?:it|that|this)|can\s+you\s+(?:look|check|verify|confirm))\b/i

// Continuation / elaboration follow-ups ("tell me more", "go on", "what else")
// whose SUBJECT lives in the PRIOR turns, not this message. A bare "tell me more"
// scores near-zero on every tool example and isn't question-shaped, so it would
// fall to the no-tool "answer from memory" path — where the companion, having lost
// the original tool data (only raw user messages survive in history, not the
// augmented turn that carried the search results), deflects ("that's old news")
// instead of fetching detail. Route these to a history-aware Tier 2 search so the
// topic is reconstructed from context and re-looked-up. Anchored to short messages
// so longer sentences that merely start with these words don't get hijacked; the
// explicit-subject form ("tell me more about X") is caught by SEARCH_INTENT_RE first.
const CONTINUATION_RE = /^(?:tell me more|more (?:about|on) (?:it|that|this|him|her|them)|go on|keep going|carry on|continue|elaborate(?: on (?:it|that|this))?|expand on (?:it|that|this)|what else|anything else|say more|what happened|then what|what(?:'s| is)? next|and then|what about (?:it|that|him|her|them|this))\b[\s.!?]*$/i

// Backchannel / emotional reactions ("wow", "no way", "really?", "oh man",
// "seriously?") — the user is reacting, not asking for anything. These must
// short-circuit to a plain conversational reply. Without this, the "?"-ending
// ones ("really?", "no way?", "for real?") match QUESTION_RE below and get
// needlessly escalated to a Tier 2 search round-trip (and risk an unwanted
// lookup); the rest waste an embed call. Anchored to whole-message reactions of
// one or two units so "wow what happened to X" still falls through to routing.
const REACTION_UNIT =
  "(?:no way|oh man|oh no|oh wow|oh my(?: god| gosh)?|my god|for real|no kidding|" +
  "you'?re kidding|shut up|get out|that'?s (?:crazy|wild|insane|nuts|awful|terrible|" +
  "amazing|hilarious|funny|something)|wow|whoa|wo+ah|omg|omfg|geez|jeez|sheesh|" +
  "yikes|dang|damn|oof|ugh|huh|hmm+|really|seriously|srsly|wild|crazy|insane|nuts|" +
  "unbelievable|incredible|lo+l|lmao|lmfao|rofl|haha+|bruh)"
const REACTION_RE = new RegExp(`^(?:${REACTION_UNIT}[\\s,!.?]*){1,2}$`, 'i')

// How many candidates to pass to the Tier 2 LLM. Search is always injected on top
// so factual questions that score low on embeddings still reach the search tool.
const TIER2_TOP_N = 5

// Trivial greetings/acks that are unambiguously non-tool. Saves a Tier 2 LLM call.
const GREETING_RE = /^(hi|hello|hey|thanks|thank you|ok|okay|sure|lol|haha|cool|nice|great|awesome|got it|sounds good|perfect|bye|goodbye|see ya|yes|no|yep|nope|yup)[\s!.?]*$/i
const TIER2_HISTORY_LIMIT = 10

const TIER2_SYSTEM = `You are a routing assistant. Call the right tool for the user's message — even when phrased naturally or implicitly, not as an explicit command.

Tool selection rules:
- search: questions about any specific title, person, show, movie, product, event, or general knowledge topic — including "have you seen X?", "what is X?", "who is X?", "tell me about X?", "do you know about X?" — prefer search over answering from memory.
- tvshows: questions about a specific TV show (cast, network, seasons, status, ratings). Use when the user asks about a show by name or says "have you seen [show name]?".
- weather: weather conditions, temperature, forecast, or what to wear.
- calculator: any arithmetic, math estimate, or percentage. "How much would..." counts.
- dictionary: what a word means, its definition, pronunciation, or etymology.
- news: current events, headlines, or what is happening in the world right now.
- recipes: cooking questions, recipe requests, or "what can I make with X?".
- youtube: requests to find a video, watch something, or "show me how to X".
- unit_conversion: converting between units of measurement.
- jokes: requests for a joke, humor, or to cheer the user up.
- datetime: read-only date/time questions: current date, time, day of week, days until/since an event, or timezone queries. NOT for creating alarms or timers (use alarms_timers).
- alarms_timers: set, change, cancel, or list the user's alarms and timers, or start/stop a countdown. "set an alarm for 7am", "wake me at 6:30", "set a timer for 10 minutes", "start a 5 minute timer", "cancel my timer", "delete my alarm", "turn off my alarm". Use this (not datetime) whenever the user wants to create or manage an alarm or timer.
- image_gen: any request to create, generate, draw, paint, sketch, illustrate, or show an image. "draw me a cat", "make an image of X", "create a picture of X", "show me what X looks like", "paint X".
- contentRating: whether a movie, show, book, game, or app is appropriate for kids/a certain age, or what objectionable content (violence, sex, language, drugs/smoking) it has. "is X ok for my kid", "is X appropriate for a 7 year old", "does X have a lot of violence/swearing", "parent guide for X". Prefer this over search and tvshows for child-suitability or content-concern questions.
- sports: live scores, results, or who is playing today in any league (MLB, World Cup, NFL, NBA, NHL, MLS). "what's the score", "who won", "is there a game on".
- localNews: hyperlocal news for the user's own town. "what's going on in town", "local news near me".
- localEvents: local events, festivals, parades, or things to do near the user. "anything happening this weekend", "events near me".
- onthisday: historical events or notable birthdays for a calendar date. "what happened on this day", "celebrity birthdays today".
- homeAssistant: commands to control a smart home — lights, switches, fans, locks, thermostats, scenes, covers/garage doors. "turn off the living room lights", "dim the bedroom", "lock the front door", "set the thermostat to 70", "is the garage open". Pass the user's full command verbatim as the text argument.

Conversational messages (greetings, opinions, "thanks", chitchat with no factual need) → respond with empty content, no tool call.

Extract all tool arguments from the full conversation context, including prior messages.`.trim()

interface RouteEntry {
  toolId: string
  embeddings: number[][]
}

let routeIndex: RouteEntry[] = []

// Stable hash of all tool examples — cache key. Changing any example text invalidates the cache.
function examplesHash(): string {
  const payload = toolRegistry.map((t) => `${t.id}:${t.examples.join('|')}`).join('\n')
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

interface CacheFile { hash: string; index: RouteEntry[] }

function loadCache(hash: string): RouteEntry[] | null {
  try {
    const raw = readFileSync(CACHE_FILE, 'utf8')
    const cache = JSON.parse(raw) as CacheFile
    if (cache.hash === hash) return cache.index
  } catch { /* miss */ }
  return null
}

function saveCache(hash: string, index: RouteEntry[]): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(CACHE_FILE, JSON.stringify({ hash, index }))
  } catch { /* non-fatal */ }
}

// Indexes tool example prompts using the dedicated router encoder (all-minilm).
// Embeddings are cached to disk (data/router-index.json) keyed by a hash of all
// example strings. Restarts with unchanged examples skip all embed calls (~instant).
// Must be called after all-minilm is warm — see warmupModel() in models.ts.
export async function initRouter(): Promise<void> {
  const hash = examplesHash()
  const cached = loadCache(hash)
  if (cached) {
    routeIndex = cached
    logger.info(`[router] loaded ${cached.length} tools from cache`)
    return
  }

  logger.info('[router] building index (examples changed or first run)…')
  routeIndex = await Promise.all(
    toolRegistry.map(async (tool) => ({
      toolId: tool.id,
      embeddings: await Promise.all(tool.examples.map(embedForRouter)),
    })),
  )
  saveCache(hash, routeIndex)
  logger.info(`[router] index built and cached (${toolRegistry.reduce((n, t) => n + t.examples.length, 0)} examples)`)
}

// Routes a prompt through a two-tier cascade:
//   Tier 1: confident match (≥ SIMILARITY_THRESHOLD) → direct tool + arg passthrough, no LLM
//   Tier 2: everything else → LLM decides (top-N candidates + search always included)
//
// Uses all-minilm for embeddings — intentionally separate from the nomic embedding
// used for memory recall. nomic's compressed similarity space prevents clean thresholding.
export async function routePrompt(
  prompt: string,
  history: OllamaChatMessage[] = [],
  model?: string,
): Promise<{ tool: Tool | null; args: unknown }> {
  if (routeIndex.length === 0) return { tool: null, args: {} }

  const excerpt = prompt.slice(0, 60).replace(/\n/g, ' ')

  // Fast path: trivial greetings/acks — skip Tier 2 LLM call entirely.
  if (GREETING_RE.test(prompt.trim())) {
    logger.info(`[ROUTER] path=greeting msg="${excerpt}"`)
    return { tool: null, args: {} }
  }

  // Fast path: emotional reactions / backchannels ("wow", "no way", "really?") —
  // the user is reacting, not requesting. Answer conversationally; never let a
  // "?"-ending reaction escalate to a search.
  if (REACTION_RE.test(prompt.trim())) {
    logger.info(`[ROUTER] path=reaction msg="${excerpt}"`)
    return { tool: null, args: {} }
  }

  // Fast path: a contextual lookup command ("look it up", "google it"). The thing
  // to search lives in earlier turns, so route to a history-aware Tier 2 (search
  // only) that rebuilds the query from context — never a literal passthrough.
  if (CONTEXTUAL_LOOKUP_RE.test(prompt)) {
    const searchTool = toolRegistry.find((t) => t.id === 'search')
    if (searchTool) {
      if (model) {
        logger.info(`[ROUTER] path=contextual-lookup→tier2 msg="${excerpt}"`)
        return tier2Call(model, prompt, history, [searchTool])
      }
      // No router model available — degrade to literal passthrough (best effort).
      logger.info(`[ROUTER] path=contextual-lookup-passthrough msg="${excerpt}"`)
      return { tool: searchTool, args: searchTool.passMessage ? { [searchTool.passMessage]: prompt } : {} }
    }
  }

  // Fast path: continuation follow-up ("tell me more", "go on") with prior turns
  // to draw on. The subject is reconstructed from history by a Tier 2 search call —
  // never a literal passthrough (that would search "tell me more"). If the prior
  // topic was just chitchat, Tier 2 returns no-tool and we fall through to a normal
  // conversational reply.
  if (CONTINUATION_RE.test(prompt.trim()) && model && history.length > 0) {
    const searchTool = toolRegistry.find((t) => t.id === 'search')
    if (searchTool) {
      logger.info(`[ROUTER] path=continuation→tier2 msg="${excerpt}"`)
      return tier2Call(model, prompt, history, [searchTool])
    }
  }

  // Fast path: regex beats embeddings for information-seeking patterns.
  // "what is X / who is X / tell me about X" are unambiguously search queries.
  // No score check needed — the regex itself is the gate. Skips the embed call too.
  if (SEARCH_INTENT_RE.test(prompt)) {
    const searchTool = toolRegistry.find(t => t.id === 'search')
    if (searchTool) {
      const args = searchTool.passMessage ? { [searchTool.passMessage]: prompt } : {}
      logger.info(`[ROUTER] path=search-intent msg="${excerpt}"`)
      return { tool: searchTool, args }
    }
  }

  let promptEmbedding: number[]
  try {
    promptEmbedding = await embedForRouter(prompt)
  } catch {
    return { tool: null, args: {} }
  }

  // Score every tool, track per-tool max for top-N selection
  const toolScores: { tool: Tool; score: number }[] = []

  for (const entry of routeIndex) {
    const tool = toolRegistry.find((t) => t.id === entry.toolId)
    if (!tool) continue
    let toolBest = 0
    for (const exampleEmbedding of entry.embeddings) {
      const score = cosineSimilarity(promptEmbedding, exampleEmbedding)
      if (score > toolBest) toolBest = score
    }
    toolScores.push({ tool, score: toolBest })
  }

  toolScores.sort((a, b) => b.score - a.score)

  const best = toolScores[0]
  const bestScore = best?.score ?? 0
  const bestTool = best?.tool ?? null

  const top3log = toolScores.slice(0, 3).map((e) => `${e.tool.id}=${e.score.toFixed(3)}`).join(' ')

  // ── Tier 1: confident match ─────────────────────────────────────────────────
  if (bestScore >= SIMILARITY_THRESHOLD && bestTool) {
    if (bestTool.passMessage !== undefined) {
      // passthrough tool — no LLM call needed for arg extraction
      logger.info(`[ROUTER] path=tier1-passthrough score=${bestScore.toFixed(3)} tool=${bestTool.id} top3=[${top3log}] msg="${excerpt}"`)
      const args = bestTool.passMessage === null
        ? {}
        : { [bestTool.passMessage]: prompt }
      return { tool: bestTool, args }
    }

    if (!model) {
      logger.info(`[ROUTER] path=tier1-no-model score=${bestScore.toFixed(3)} tool=${bestTool.id} top3=[${top3log}] msg="${excerpt}"`)
      return { tool: bestTool, args: {} }
    }

    // Confident non-passthrough tool — narrowed Tier 2 for arg extraction only (1 tool)
    logger.info(`[ROUTER] path=tier2-narrowed(${bestTool.id}) score=${bestScore.toFixed(3)} top3=[${top3log}] msg="${excerpt}"`)
    return tier2Call(model, prompt, history, [bestTool])
  }

  // ── Tier 0: low confidence ──────────────────────────────────────────────────
  // Normally "not a tool request" → skip Tier 2. BUT a question-shaped prompt that
  // merely scored low (garbled STT, an unusual proper noun the examples don't cover)
  // must NOT fall to "answer from memory" — that's how the model ends up inventing
  // facts for things it should look up. Escalate genuine questions (not social
  // chitchat) to Tier 2 with search included; let it decide search vs. no-tool.
  if (bestScore < CONVERSATIONAL_THRESHOLD) {
    const trimmed = prompt.trim()
    const isQuestion = QUESTION_RE.test(trimmed) && !SOCIAL_QUESTION_RE.test(trimmed)
    if (!(isQuestion && model)) {
      logger.info(`[ROUTER] path=conversational score=${bestScore.toFixed(3)} top3=[${top3log}] msg="${excerpt}"`)
      return { tool: null, args: {} }
    }
    logger.info(`[ROUTER] path=tier2-question score=${bestScore.toFixed(3)} top3=[${top3log}] msg="${excerpt}"`)
  }

  // ── Tier 2: LLM decides — search always included so factual questions never fall through ──
  if (!model) {
    logger.info(`[ROUTER] path=tier2-no-model score=${bestScore.toFixed(3)} top3=[${top3log}] msg="${excerpt}"`)
    return { tool: null, args: {} }
  }

  const topByScore = toolScores.slice(0, TIER2_TOP_N).map((e) => e.tool)
  const searchTool = toolRegistry.find((t) => t.id === 'search')
  const candidates = searchTool && !topByScore.some((t) => t.id === 'search')
    ? [searchTool, ...topByScore]
    : topByScore
  logger.info(`[ROUTER] path=tier2(${candidates.map((t) => t.id).join(',')}) score=${bestScore.toFixed(3)} top3=[${top3log}] msg="${excerpt}"`)
  return tier2Call(model, prompt, history, candidates)
}

async function tier2Call(
  model: string,
  prompt: string,
  history: OllamaChatMessage[],
  candidates: Tool[],
): Promise<{ tool: Tool | null; args: unknown }> {
  const t2Start = performance.now()
  try {
    const messages: OllamaChatMessage[] = [
      { role: 'system', content: TIER2_SYSTEM },
      ...history.slice(-TIER2_HISTORY_LIMIT),
      { role: 'user', content: prompt },
    ]

    // Use a dedicated router model if configured (DB setting or ROUTER_MODEL env var).
    // Falls back to the chat model if not set. When using a separate router model,
    // num_ctx doesn't need to match chat.ts (different model = separate KV cache).
    const routerModel = (await getRouterModel()) ?? model
    const opts: Record<string, unknown> = { temperature: 0.1 }
    if (routerModel === model) opts['num_ctx'] = 4096

    const response = await ollamaChat(
      routerModel,
      messages,
      candidates.map((t) => t.toolDefinition),
      opts,
    )

    const t2Ms = (performance.now() - t2Start).toFixed(0)
    const toolCall = response.message.tool_calls?.[0]
    if (!toolCall) {
      logger.info(`[ROUTER] tier2 result=no-tool-call ${t2Ms}ms`)
      return { tool: null, args: {} }
    }

    const matched = toolRegistry.find(
      (t) => t.toolDefinition.function.name === toolCall.function.name,
    )
    if (!matched) {
      logger.info(`[ROUTER] tier2 result=unknown-tool(${toolCall.function.name}) ${t2Ms}ms`)
      return { tool: null, args: {} }
    }

    logger.info(`[ROUTER] tier2 result=tool(${matched.id}) ${t2Ms}ms model=${routerModel}`)
    return { tool: matched, args: toolCall.function.arguments }
  } catch {
    const t2Ms = (performance.now() - t2Start).toFixed(0)
    logger.info(`[ROUTER] tier2 result=error ${t2Ms}ms — falling back`)
    return { tool: null, args: {} }
  }
}
