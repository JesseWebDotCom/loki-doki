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

// Explicit playback commands → always route to play_music, which then decides
// song vs. music video vs. radio station. Embeddings alone miss misspelled
// artists ("play some zepplin") and let Tier-2 escalate to a conversational
// reply, so the companion roleplays "which one?" instead of just playing it.
// Anchored near the start so "I went out to play" etc. don't trip it.
const PLAY_INTENT_RE = /^(?:(?:hey|ok|okay|yo)\b[\s,]+\w+[\s,!]+)?(?:can you|could you|would you|will you|please|i(?:'?d| would)?\s+(?:like|want|wanna)(?:\s+to)?|let'?s|go ahead and|now)?[\s,]*(?:play|put on|throw on|spin up|fire up|queue up|start playing|listen to)\b/i
// …but not non-media uses of "play" (games, instruments, sports).
const NOT_MEDIA_PLAY_RE = /\bplay(?:ing)?\s+(?:a\s+|some\s+)?(?:game|games|chess|checkers|cards|a\s+round|outside|sports?|football|basketball|tag|the\s+(?:guitar|piano|drums|violin|keyboard))\b/i

// Arithmetic the embeddings can't see: symbols and money-math score near-zero on
// all-minilm ("what is 17 × 23?" → calculator=0.24), so a regex is the only gate
// that catches them before the search-intent path swallows the question. WORD forms
// ("17 times 23", "100 divided by 4") also miss the symbol class and, worse, embed
// closer to unit_conversion than calculator — so spell out the common word operators.
const MATH_INTENT_RE = /\d\s*[+\-×x*/÷^]\s*\d|\b\d+(?:\.\d+)?\s*(?:times|multiplied by|plus|minus|divided by)\s+\d|\d+(?:\.\d+)?\s*%\s*(?:tip|of|on)|\b(?:tip|split|divide)\b[^.?!]{0,40}\$?\d/i

// Unit conversions phrased as questions ("how many km is 5 miles?", "what is 6
// foot 2 in cm?") sit just below the tier-2 band on embeddings (0.33–0.39) and
// used to fall through to web search.
const UNIT_WORD = '(?:km|kilometers?|miles?|mi|cm|centimeters?|meters?|millimeters?|mm|feet|foot|ft|inch(?:es)?|kg|kilograms?|lbs?|pounds?|oz|ounces?|grams?|stone|celsius|fahrenheit|°\\s?[cf]|kelvin|liters?|litres?|gallons?|quarts?|pints?|cups?|tablespoons?|teaspoons?|tbsp|tsp|ml|milliliters?|acres?|hectares?|mph|kph|knots)'
const UNIT_CONVERT_RE = new RegExp(
  `\\bconvert\\b[^.?!]*\\b${UNIT_WORD}\\b|\\bhow many\\s+${UNIT_WORD}\\b|\\b${UNIT_WORD}\\b[^.?!]{0,30}\\b(?:in|to|into)\\s+${UNIT_WORD}\\b|\\bwhat(?:'s| is) that in\\s+${UNIT_WORD}\\b|\\d\\s*${UNIT_WORD}\\b[^.?!]{0,30}\\bin\\s+${UNIT_WORD}\\b`,
  'i',
)

// "define X" / "what does X mean" — dictionary scores only ~0.25 on these under
// all-minilm, so without the regex they dropped to the conversational path.
const DEFINE_RE = /^(?:define\s+\w|definition of\b|what(?:'s| is) the definition of\b|what does\s+["']?\w+["']?\s+mean\b|how do you (?:pronounce|spell)\b)/i

// A message shaped like a question — leads with an interrogative or ends with "?".
// Used so a LOW-confidence question still escalates to Tier 2 (which always includes
// search) instead of dropping to the conversational "no tool → answer from memory"
// path, where the model would invent facts ("what is Claude Mythos?" → a made-up
// Highlander character) rather than look them up. Greetings are filtered earlier.
const QUESTION_RE = /^(?:who|what|what'?s|whats|whatre|whens?|where'?s|where|which|whose|why|how|is|are|was|were|do|does|did|can|could|will|would|has|have|had|should)\b|\?\s*$/i

// Pure social/chitchat questions that need no tool — short-circuit so they don't pay a
// Tier 2 round trip just because QUESTION_RE matched ("how are you", "what's up").
const SOCIAL_QUESTION_RE = /^(?:how (?:are|r|have) (?:you|u|ya|been)|how'?s it going|how'?s your|what'?s up|whats up|what are you (?:up to|doing)|are you (?:ok|okay|there|sure|free|busy))\b/i

// First-person possessive recall about the USER's OWN life facts ("what's my son's
// name?", "when is my wedding anniversary?", "what's my dog's name?"). These embed
// right onto the remember tool (so tier-1 STORED the question as a junk memory instead
// of answering it) OR trip the search fast path (which then CONFABULATES a personal
// fact it cannot possibly know — e.g. inventing a child's name from web results). They
// must be answered from the injected memory block, or the companion admits it doesn't
// know. Matches only when the message is a QUESTION (QUESTION_RE) AND names a personal
// fact/relationship after "my"/"our" — so tool-bearing possessives ("my local weather",
// "my alarms", "my thermostat") still route to their tools.
const PERSONAL_FACT_RE = /\b(?:my|our)\s+(?:\w+\s+){0,2}(?:names?|nicknames?|birth\s?days?|anniversar\w*|addresse?s?|phone|emails?|ages?|jobs?|allerg\w*|son|daughter|kids?|child|children|wife|husband|spouse|partner|fianc\w*|mom|mother|dad|father|parents?|brothers?|sisters?|siblings?|grandmothers?|grandfathers?|grandma|grandpa|aunts?|uncles?|cousins?|pets?|dogs?|cats?|favou?rite|hometowns?)\b/i

// Questions directed AT the companion itself ("who are you?", "how do you feel?",
// "what is wrong with you") — these must never take the literal search-intent fast
// path (which would web-search the companion's own identity/feelings). Excludes
// knowledge-seeking verbs ("what do you know about X", "have you heard of X") so
// genuine lookups still fast-path. Only guards the fast path — the embedding tiers
// and Tier 2 can still choose search for ambiguous cases.
const SELF_DIRECTED_RE = /^(?:so\s+|hey\s+|and\s+)?(?:who|what|how|why)\b[^,.!?]{0,50}\byou\b(?!\s+(?:know|heard|seen|watched|read|find|found|look|looked|search|tell|think|check|recommend|suggest))/i

// Follow-up lookup commands whose SUBJECT lives in the prior turns, not the
// command itself ("why don't you look it up", "google it", "search that",
// "fact-check it"). These must NOT use the literal-passthrough fast path — that
// would search the command text. They route to a history-aware Tier 2 so the
// query is reconstructed from conversation context.
// NOTE: the "can you …" alternative REQUIRES a contextual object (it/that/this).
// A bare `can you (look|check|verify|confirm)` used to hijack "can you check the
// weather?" / "can you check if the garage is closed?" into a search-only Tier 2
// where the weather/HA tools were unreachable.
const CONTEXTUAL_LOOKUP_RE = /\b(?:look\s+(?:it|that|this|him|her|them|those|these)\s+up|google\s+(?:it|that|this|him|her|them)|search\s+(?:it|that|this)|find\s+(?:it|that|this)\s+out|look\s+into\s+(?:it|that|this)|fact[-\s]?check\s+(?:it|that|this)|verify\s+(?:it|that|this)|can\s+you\s+(?:(?:go\s+)?look\s+(?:it|that|this)\s+up|(?:double[-\s]?)?check\s+(?:it|that|this)|verify\s+(?:it|that|this)|confirm\s+(?:it|that|this)))\b/i

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

// Tier-1 requires this much separation between the top two scores. Anything closer
// is ambiguous (known confusable clusters: tvshows/search/whereToWatch,
// youtube/play_music) and escalates to Tier 2 with both as candidates.
const TIER1_MARGIN = 0.05

// Trivial greetings/acks that are unambiguously non-tool. Saves a Tier 2 LLM call.
// "good morning/evening/…" included: without it, "good evening!" embeds closer to
// the sleep tool (0.747) than the conversational exemplars and paid a ~600ms
// Tier-2 call just to learn it's a greeting. "good night" deliberately stays OUT —
// it's a real sleep-tool trigger.
const GREETING_RE = /^(hi|hello|hey|good (morning|afternoon|evening|day)|thanks|thank you|ok|okay|sure|lol|haha|cool|nice|great|awesome|got it|sounds good|perfect|bye|goodbye|see ya|yes|no|yep|nope|yup)[\s!.?]*$/i
const TIER2_HISTORY_LIMIT = 10

// Per-tool routing rules, keyed by TOOL ID. The Tier-2 system prompt is assembled
// from the rules of the actual candidates only — the old static prompt always
// advertised 18 tools even when just 1–6 schemas were callable, steering the model
// toward naming non-candidates and wasting ~200–400 prefill tokens per route.
const TIER2_RULES: Record<string, string> = {
  search: 'search: questions about any specific title, person, show, movie, product, event, or general knowledge topic — including "have you seen X?", "what is X?", "who is X?", "tell me about X?", "do you know about X?" — prefer search over answering from memory.',
  tvshows: 'tvshows: questions about a specific TV show (cast, network, seasons, status, ratings). Use when the user asks about a show by name or says "have you seen [show name]?".',
  weather: 'weather: weather conditions, temperature, forecast, or what to wear.',
  calculator: 'calculator: any arithmetic, math estimate, or percentage. "How much would..." counts.',
  dictionary: 'dictionary: what a word means, its definition, pronunciation, or etymology.',
  news: 'news: current events, headlines, or what is happening in the world right now.',
  recipes: 'recipes: cooking questions, recipe requests, or "what can I make with X?".',
  youtube: 'youtube: requests to FIND or SEARCH for a video, or "show me how to X" — browsing, not immediate playback. Do NOT use for "play X" (use play_music).',
  play_music: 'play_music: requests to PLAY or PUT ON something now — a specific song, music video, movie/show trailer, theme song, an artist, a genre/mood, or a radio station. "play X", "put on X", "start an X station", "play the X trailer", "play the X music video". Prefer this over youtube whenever the user says play/put on.',
  unit_conversion: 'unit_conversion: converting between units of measurement.',
  jokes: 'jokes: requests for a joke, humor, or to cheer the user up.',
  datetime: 'datetime: read-only date/time questions: current date, time, day of week, days until/since an event, or timezone queries. NOT for creating alarms or timers (use alarms_timers).',
  time: 'alarms_timers: set, change, cancel, or list the user\'s alarms and timers, or start/stop a countdown. "set an alarm for 7am", "wake me at 6:30", "set a timer for 10 minutes", "start a 5 minute timer", "cancel my timer", "delete my alarm", "turn off my alarm". Use this (not datetime) whenever the user wants to create or manage an alarm or timer.',
  image_gen: 'image_gen: any request to create, generate, draw, paint, sketch, illustrate, or show an image. "draw me a cat", "make an image of X", "create a picture of X", "show me what X looks like", "paint X".',
  contentRating: 'contentRating: whether a movie, show, book, game, or app is appropriate for kids/a certain age, or what objectionable content (violence, sex, language, drugs/smoking) it has. "is X ok for my kid", "is X appropriate for a 7 year old", "does X have a lot of violence/swearing", "parent guide for X". Prefer this over search and tvshows for child-suitability or content-concern questions.',
  sports: 'sports: live scores, results, or who is playing today in any league (MLB, World Cup, NFL, NBA, NHL, MLS). "what\'s the score", "who won", "is there a game on".',
  localNews: 'localNews: hyperlocal news for the user\'s own town. "what\'s going on in town", "local news near me".',
  localEvents: 'localEvents: local events, festivals, parades, or things to do near the user. "anything happening this weekend", "events near me".',
  onthisday: 'onthisday: historical events or notable birthdays for a calendar date. "what happened on this day", "celebrity birthdays today".',
  homeAssistant: 'homeAssistant: control or query smart-home devices — lights, switches, fans, locks, thermostats (temperature + mode), home TVs/speakers (pause, skip, volume, mute), scenes, covers/garage doors. "turn off the living room lights", "set the thermostat to 72", "pause the living room tv", "is the garage open", "what temperature is it inside". Only for devices in the home — outdoor conditions are weather, and starting new music by name is play_music. Pass the user\'s full command verbatim as the text argument.',
}

function tier2System(candidates: Tool[]): string {
  const rules = candidates
    .map((t) => TIER2_RULES[t.id])
    .filter(Boolean)
    .map((r) => `- ${r}`)
    .join('\n')
  return [
    `You are a routing assistant. Call the right tool for the user's message — even when phrased naturally or implicitly, not as an explicit command.`,
    rules ? `Tool selection rules:\n${rules}` : null,
    `Conversational messages (greetings, opinions, "thanks", chitchat with no factual need) → respond with empty content, no tool call.`,
    `Extract all tool arguments from the full conversation context, including prior messages.`,
  ].filter(Boolean).join('\n\n')
}

interface RouteEntry {
  toolId: string
  embeddings: number[][]
}

// Pseudo-tool absorber: social chitchat that GREETING_RE/REACTION_RE miss ("hey,
// how has your day been?") used to land in the 0.40–0.65 band against a random
// tool (sleep, news) and pay a 1.4–1.8s Tier-2 LLM call just to hear "no tool".
// These exemplars give chitchat something to match INSTEAD — when this entry wins,
// the router returns conversational directly at embed cost (~30ms).
const CONVERSATIONAL_ID = '__conversational'
const CONVERSATIONAL_EXAMPLES = [
  'hey, how has your day been?',
  'how was your day today?',
  'good morning! how are you feeling?',
  'what have you been up to lately?',
  "I'm so tired today",
  'I had a rough day at work',
  'that made me laugh so hard',
  'I really appreciate you',
  "you're the best, thanks for the help",
  'do you ever get bored?',
  'what do you think about me?',
  'tell me something about yourself',
  'who are you?',
  'what are you exactly?',
  'are you a real person?',
  'how do you feel today?',
  'I missed talking to you',
  'guess what happened to me today',
]

let routeIndex: RouteEntry[] = []

// Stable hash of all tool examples — cache key. Changing any example text invalidates the cache.
function examplesHash(): string {
  const payload = toolRegistry.map((t) => `${t.id}:${t.examples.join('|')}`).join('\n')
    + `\n${CONVERSATIONAL_ID}:${CONVERSATIONAL_EXAMPLES.join('|')}`
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

interface CacheFile { hash: string; index: RouteEntry[] }

function loadCache(hash: string): RouteEntry[] | null {
  try {
    const raw = readFileSync(CACHE_FILE, 'utf8')
    const cache = JSON.parse(raw) as CacheFile
    // Entry-count check besides the hash: a dev hot-reload mid-edit can persist an
    // index built from a partial module state under the final hash.
    if (cache.hash === hash && cache.index.length === toolRegistry.length + 1) return cache.index
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
    [
      ...toolRegistry.map((t) => ({ id: t.id, examples: t.examples })),
      { id: CONVERSATIONAL_ID, examples: CONVERSATIONAL_EXAMPLES },
    ].map(async (tool) => ({
      toolId: tool.id,
      embeddings: await Promise.all(tool.examples.map(embedForRouter)),
    })),
  )
  saveCache(hash, routeIndex)
  logger.info(`[router] index built and cached (${toolRegistry.reduce((n, t) => n + t.examples.length, 0)} examples)`)
}

// Lazy self-heal: in dev, Bun's hot-reload re-evaluates this module and resets the
// in-memory `routeIndex` to [], but initRouter() only runs once at boot — so every
// route would silently fall through to "no tool" until a full restart. Repopulate
// from the on-disk cache (or rebuild) on first use if the index is empty.
let initPromise: Promise<void> | null = null
async function ensureRouter(): Promise<void> {
  if (routeIndex.length > 0) return
  if (!initPromise) initPromise = initRouter().catch((e) => { initPromise = null; throw e })
  await initPromise
}

// Routes a prompt through a two-tier cascade:
//   Tier 1: confident match (≥ SIMILARITY_THRESHOLD) → direct tool + arg passthrough, no LLM
//   Tier 2: everything else → LLM decides (top-N candidates + search always included)
//
// Uses all-minilm for embeddings — intentionally separate from the nomic embedding
// used for memory recall. nomic's compressed similarity space prevents clean thresholding.
export interface RouteResult {
  tool: Tool | null
  args: unknown
  /** Set when the best route was a tool this user is denied — the caller can
   *  tell the user instead of silently answering from model memory. */
  deniedToolId?: string
  /** Which routing path produced this decision (fast-path label / tier1 / tier2 /
   *  conversational) — consumed by the admin benchmarks for honest tier
   *  attribution (they used to infer tier from wall-clock time). */
  path?: string
  /** Additional tool calls from a multi-intent Tier-2 turn ("lights off and play
   *  jazz"), executed serially after the primary. Bounded at 2. */
  extraCalls?: { tool: Tool; args: unknown }[]
}

export async function routePrompt(
  prompt: string,
  history: OllamaChatMessage[] = [],
  model?: string,
  routeOpts?: {
    /** The caller's chat num_ctx — matched by a same-model Tier-2 call so Ollama
     *  never reloads the runner over a context-size mismatch. */
    numCtx?: number
    /** Tools this user may run (from getAllowedToolIds). Denied tools are excluded
     *  from every fast path and candidate list; undefined = no filtering. */
    allowedToolIds?: Set<string>
  },
): Promise<RouteResult> {
  const chatNumCtx = routeOpts?.numCtx
  const allowedToolIds = routeOpts?.allowedToolIds
  const isAllowed = (t: Tool) => !allowedToolIds || allowedToolIds.has(t.id)
  // Repopulate the index if a hot-reload wiped it (no-op once warm).
  if (routeIndex.length === 0) {
    try { await ensureRouter() } catch { /* embed model not ready — degrade below */ }
    if (routeIndex.length === 0) return { tool: null, args: {}, path: 'no-index' }
  }

  const excerpt = prompt.slice(0, 60).replace(/\n/g, ' ')

  // Fast path: trivial greetings/acks — skip Tier 2 LLM call entirely.
  if (GREETING_RE.test(prompt.trim())) {
    logger.info(`[ROUTER] path=greeting msg="${excerpt}"`)
    return { tool: null, args: {}, path: 'greeting' }
  }

  // Fast path: emotional reactions / backchannels ("wow", "no way", "really?") —
  // the user is reacting, not requesting. Answer conversationally; never let a
  // "?"-ending reaction escalate to a search.
  if (REACTION_RE.test(prompt.trim())) {
    logger.info(`[ROUTER] path=reaction msg="${excerpt}"`)
    return { tool: null, args: {}, path: 'reaction' }
  }

  // Fast path: recall QUESTIONS ("do you remember when we first met?") are asking
  // the companion to use its memory, not to store anything — but they embed right
  // on top of the remember tool's examples, so tier-1 passthrough was STORING the
  // question text as a junk memory and never answering it. The injected memory
  // block is what answers these; route to plain conversation.
  if (/^(?:hey\s+\w+[\s,]+)?(?:do|did|don'?t|can|would|will) you (?:remember|recall|still remember)\b/i.test(prompt.trim())) {
    logger.info(`[ROUTER] path=recall-question msg="${excerpt}"`)
    return { tool: null, args: {}, path: 'recall-question' }
  }

  // Fast path: possessive recall about the user's own life ("what's my son's name?",
  // "when is my anniversary?"). Answer from the injected memory block — never STORE the
  // question (remember tool) or WEB-SEARCH a personal fact (search confabulates one). If
  // nothing is stored, the conversational reply admits it rather than inventing a fact.
  if (QUESTION_RE.test(prompt.trim()) && PERSONAL_FACT_RE.test(prompt)) {
    logger.info(`[ROUTER] path=personal-recall msg="${excerpt}"`)
    return { tool: null, args: {}, path: 'personal-recall' }
  }

  // Fast path: a contextual lookup command ("look it up", "google it"). The thing
  // to search lives in earlier turns, so route to a history-aware Tier 2 (search
  // only) that rebuilds the query from context — never a literal passthrough.
  if (CONTEXTUAL_LOOKUP_RE.test(prompt)) {
    const searchTool = toolRegistry.find((t) => t.id === 'search')
    if (searchTool && isAllowed(searchTool)) {
      if (model) {
        logger.info(`[ROUTER] path=contextual-lookup→tier2 msg="${excerpt}"`)
        return tier2Call(model, prompt, history, [searchTool], chatNumCtx)
      }
      // No router model available — degrade to literal passthrough (best effort).
      logger.info(`[ROUTER] path=contextual-lookup-passthrough msg="${excerpt}"`)
      return { tool: searchTool, args: searchTool.passMessage ? { [searchTool.passMessage]: prompt } : {}, path: 'contextual-lookup-passthrough' }
    }
  }

  // Fast path: continuation follow-up ("tell me more", "go on") with prior turns
  // to draw on. The subject is reconstructed from history by a Tier 2 search call —
  // never a literal passthrough (that would search "tell me more"). If the prior
  // topic was just chitchat, Tier 2 returns no-tool and we fall through to a normal
  // conversational reply.
  if (CONTINUATION_RE.test(prompt.trim()) && model && history.length > 0) {
    const searchTool = toolRegistry.find((t) => t.id === 'search')
    if (searchTool && isAllowed(searchTool)) {
      logger.info(`[ROUTER] path=continuation→tier2 msg="${excerpt}"`)
      return tier2Call(model, prompt, history, [searchTool], chatNumCtx)
    }
  }

  // Fast path: an explicit "play X" / "put on X" command always goes to play_music.
  // The tool itself classifies song vs. video vs. station, so passthrough is enough.
  if (PLAY_INTENT_RE.test(prompt) && !NOT_MEDIA_PLAY_RE.test(prompt)) {
    const playTool = toolRegistry.find((t) => t.id === 'play_music')
    if (playTool && isAllowed(playTool)) {
      logger.info(`[ROUTER] path=play-intent msg="${excerpt}"`)
      return { tool: playTool, args: playTool.passMessage ? { [playTool.passMessage]: prompt } : {}, path: 'play-intent' }
    }
  }

  // Fast path: natural-language directions requests ("how do I get to X", "navigate to Y").
  // Must fire BEFORE SEARCH_INTENT_RE because "how do" in that regex would otherwise
  // funnel directions queries to web search instead of the offline maps tool.
  const MAPS_DIRECTIONS_RE = /\b(?:how (?:do i|can i) (?:get|go|drive|walk) (?:to|from)|get (?:me )?directions? to|navigate to)\b/i
  if (MAPS_DIRECTIONS_RE.test(prompt)) {
    const mapsTool = toolRegistry.find((t) => t.id === 'maps')
    if (mapsTool && model && isAllowed(mapsTool)) {
      logger.info(`[ROUTER] path=maps-directions msg="${excerpt}"`)
      return tier2Call(model, prompt, history, [mapsTool], chatNumCtx)
    }
  }

  // Fast path: arithmetic — symbols/money-math score near-zero on embeddings, and
  // SEARCH_INTENT_RE ("what is", "how much") would otherwise web-search them.
  if (MATH_INTENT_RE.test(prompt)) {
    const calcTool = toolRegistry.find((t) => t.id === 'calculator')
    if (calcTool && model && isAllowed(calcTool)) {
      logger.info(`[ROUTER] path=math-intent msg="${excerpt}"`)
      return tier2Call(model, prompt, history, [calcTool], chatNumCtx)
    }
  }

  // Fast path: unit conversions ("how many km is 5 miles") — they embed at
  // 0.33–0.39, below the tier-2 band, so without the regex they fell to search.
  if (UNIT_CONVERT_RE.test(prompt)) {
    const unitTool = toolRegistry.find((t) => t.id === 'unit_conversion')
    if (unitTool && model && isAllowed(unitTool)) {
      logger.info(`[ROUTER] path=unit-intent msg="${excerpt}"`)
      return tier2Call(model, prompt, history, [unitTool], chatNumCtx)
    }
  }

  // Fast path: "define X" / "what does X mean" → dictionary (embeds at ~0.25).
  if (DEFINE_RE.test(prompt.trim())) {
    const dictTool = toolRegistry.find((t) => t.id === 'dictionary')
    if (dictTool && model && isAllowed(dictTool)) {
      logger.info(`[ROUTER] path=define-intent msg="${excerpt}"`)
      return tier2Call(model, prompt, history, [dictTool], chatNumCtx)
    }
  }

  // Information-seeking patterns ("what is X / who is X / tell me about X") are
  // still search-shaped, but the regex is no longer an unconditional gate: it used
  // to fire BEFORE the embedding tiers and hijacked calculator/datetime/recipes
  // questions ("how much is a 20% tip on $85" → web search). Now it only decides
  // AFTER scoring: if any specialized tool clears the ambiguous band, the normal
  // cascade adjudicates (search stays a Tier-2 candidate); only when nothing else
  // is plausible does it passthrough to search directly (keeping the 0ms win for
  // "who is Ada Lovelace"-style lookups, which score <0.4 on every tool).
  const searchIntent = SEARCH_INTENT_RE.test(prompt)
    && !SOCIAL_QUESTION_RE.test(prompt.trim())
    && !SELF_DIRECTED_RE.test(prompt.trim())

  let promptEmbedding: number[]
  try {
    promptEmbedding = await embedForRouter(prompt)
  } catch {
    return { tool: null, args: {}, path: 'embed-failed' }
  }

  // Score every tool, track per-tool max for top-N selection. Denied tools are
  // scored (to detect "the best route was denied") but excluded from candidates.
  const toolScores: { tool: Tool; score: number }[] = []
  let deniedBest: { tool: Tool; score: number } | null = null
  let conversationalScore = 0

  for (const entry of routeIndex) {
    let toolBest = 0
    for (const exampleEmbedding of entry.embeddings) {
      const score = cosineSimilarity(promptEmbedding, exampleEmbedding)
      if (score > toolBest) toolBest = score
    }
    if (entry.toolId === CONVERSATIONAL_ID) {
      conversationalScore = toolBest
      continue
    }
    const tool = toolRegistry.find((t) => t.id === entry.toolId)
    if (!tool) continue
    if (!isAllowed(tool)) {
      if (!deniedBest || toolBest > deniedBest.score) deniedBest = { tool, score: toolBest }
      continue
    }
    toolScores.push({ tool, score: toolBest })
  }

  toolScores.sort((a, b) => b.score - a.score)

  const best = toolScores[0]
  const bestScore = best?.score ?? 0
  const bestTool = best?.tool ?? null

  const top3log = toolScores.slice(0, 3).map((e) => `${e.tool.id}=${e.score.toFixed(3)}`).join(' ')

  // Chitchat absorber: when the conversational exemplars outscore every tool, the
  // message is social — answer directly instead of paying a Tier-2 call to learn
  // "no tool". Never absorbs search-shaped prompts ("tell me about X" can sit
  // close to "tell me something about yourself"). A bare ">" comparison let the
  // absorber steal tool questions by a hair ("what's the weather like today?" —
  // absorber 0.633 vs weather 0.596), so a near-tie with a plausible tool falls
  // through to the normal cascade instead (Tier 2 can still answer no-tool).
  if (!searchIntent && conversationalScore >= 0.45 && conversationalScore > bestScore) {
    const nearTieWithTool =
      bestScore >= CONVERSATIONAL_THRESHOLD && conversationalScore - bestScore < TIER1_MARGIN
    if (!nearTieWithTool) {
      logger.info(`[ROUTER] path=conversational-absorber score=${conversationalScore.toFixed(3)} top3=[${top3log}] msg="${excerpt}"`)
      return { tool: null, args: {}, path: 'conversational-absorber' }
    }
    logger.info(`[ROUTER] path=absorber-near-tie score=${conversationalScore.toFixed(3)} top3=[${top3log}] msg="${excerpt}"`)
  }

  // The user's denied tool would have won confidently — surface that instead of
  // silently answering from model memory (e.g. a weather question with weather off).
  const deniedWouldWin = deniedBest && deniedBest.score >= SIMILARITY_THRESHOLD && deniedBest.score > bestScore
  if (deniedWouldWin) {
    logger.info(`[ROUTER] path=denied-tool tool=${deniedBest!.tool.id} score=${deniedBest!.score.toFixed(3)} msg="${excerpt}"`)
    return { tool: null, args: {}, deniedToolId: deniedBest!.tool.id, path: 'denied-tool' }
  }

  // Search-shaped prompt with no plausible specialized tool → direct passthrough,
  // same 0ms cost the old unconditional fast path had. Anything at/above the
  // ambiguous band falls through so Tier 1/Tier 2 can pick the specialized tool.
  if (searchIntent && bestScore < CONVERSATIONAL_THRESHOLD) {
    const searchTool = toolRegistry.find((t) => t.id === 'search')
    if (searchTool && isAllowed(searchTool)) {
      logger.info(`[ROUTER] path=search-intent score=${bestScore.toFixed(3)} top3=[${top3log}] msg="${excerpt}"`)
      return { tool: searchTool, args: searchTool.passMessage ? { [searchTool.passMessage]: prompt } : {}, path: 'search-intent' }
    }
  }

  // ── Tier 1: confident match ─────────────────────────────────────────────────
  if (bestScore >= SIMILARITY_THRESHOLD && bestTool) {
    // Margin gate: two tools scoring within a hair of each other (e.g. tvshows vs
    // search at 0.66/0.65) is a coin flip, not confidence — let Tier 2 adjudicate
    // with BOTH as candidates instead of blindly passing through the winner.
    const second = toolScores[1]
    if (model && second && second.score >= SIMILARITY_THRESHOLD && bestScore - second.score < TIER1_MARGIN) {
      logger.info(`[ROUTER] path=tier2-margin(${bestTool.id},${second.tool.id}) score=${bestScore.toFixed(3)} top3=[${top3log}] msg="${excerpt}"`)
      return tier2Call(model, prompt, history, [bestTool, second.tool], chatNumCtx)
    }

    if (bestTool.passMessage !== undefined) {
      // passthrough tool — no LLM call needed for arg extraction
      logger.info(`[ROUTER] path=tier1-passthrough score=${bestScore.toFixed(3)} tool=${bestTool.id} top3=[${top3log}] msg="${excerpt}"`)
      const args = bestTool.passMessage === null
        ? {}
        : { [bestTool.passMessage]: prompt }
      return { tool: bestTool, args, path: 'tier1-passthrough' }
    }

    if (!model) {
      logger.info(`[ROUTER] path=tier1-no-model score=${bestScore.toFixed(3)} tool=${bestTool.id} top3=[${top3log}] msg="${excerpt}"`)
      return { tool: bestTool, args: {}, path: 'tier1-no-model' }
    }

    // Confident non-passthrough tool — narrowed Tier 2 for arg extraction only (1 tool)
    logger.info(`[ROUTER] path=tier2-narrowed(${bestTool.id}) score=${bestScore.toFixed(3)} top3=[${top3log}] msg="${excerpt}"`)
    return tier2Call(model, prompt, history, [bestTool], chatNumCtx)
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
      return { tool: null, args: {}, path: 'conversational' }
    }
    logger.info(`[ROUTER] path=tier2-question score=${bestScore.toFixed(3)} top3=[${top3log}] msg="${excerpt}"`)
  }

  // ── Tier 2: LLM decides — search always included so factual questions never fall through ──
  if (!model) {
    logger.info(`[ROUTER] path=tier2-no-model score=${bestScore.toFixed(3)} top3=[${top3log}] msg="${excerpt}"`)
    return { tool: null, args: {}, path: 'tier2-no-model' }
  }

  const topByScore = toolScores.slice(0, TIER2_TOP_N).map((e) => e.tool)
  const searchTool = toolRegistry.find((t) => t.id === 'search')
  const candidates = searchTool && isAllowed(searchTool) && !topByScore.some((t) => t.id === 'search')
    ? [searchTool, ...topByScore]
    : topByScore
  logger.info(`[ROUTER] path=tier2(${candidates.map((t) => t.id).join(',')}) score=${bestScore.toFixed(3)} top3=[${top3log}] msg="${excerpt}"`)
  return tier2Call(model, prompt, history, candidates, chatNumCtx)
}

// Routing must never stall a turn: it fails open to plain conversation, so a wedged
// router model should cost seconds, not the global 120s chat timeout of pre-stream silence.
const TIER2_TIMEOUT_MS = 10_000

async function tier2Call(
  model: string,
  prompt: string,
  history: OllamaChatMessage[],
  candidates: Tool[],
  chatNumCtx?: number,
): Promise<RouteResult> {
  const t2Start = performance.now()
  try {
    const messages: OllamaChatMessage[] = [
      { role: 'system', content: tier2System(candidates) },
      ...history.slice(-TIER2_HISTORY_LIMIT),
      { role: 'user', content: prompt },
    ]

    // Use a dedicated router model if configured (DB setting or ROUTER_MODEL env var).
    // Falls back to the chat model if not set. When using a separate router model,
    // num_ctx doesn't need to match chat.ts (different model = separate KV cache).
    // When SHARING the chat model, num_ctx must match the chat call exactly —
    // Ollama re-initializes the runner on any context-size change, so a 4096-route
    // followed by an 8192-chat forced two model reloads per message.
    const routerModel = (await getRouterModel()) ?? model
    // num_predict: a tool call is a name + short JSON args (~50 tokens); without a
    // cap a chatty router model can ramble for hundreds of tokens before the
    // tool_calls array closes. 200 leaves room for 3 multi-intent calls.
    const opts: Record<string, unknown> = { temperature: 0.1, num_predict: 200 }
    if (routerModel === model) opts['num_ctx'] = chatNumCtx ?? 8192

    const response = await ollamaChat(
      routerModel,
      messages,
      candidates.map((t) => t.toolDefinition),
      opts,
      undefined,
      TIER2_TIMEOUT_MS,
    )

    const t2Ms = (performance.now() - t2Start).toFixed(0)
    const toolCalls = response.message.tool_calls ?? []
    if (toolCalls.length === 0) {
      logger.info(`[ROUTER] tier2 result=no-tool-call ${t2Ms}ms`)
      return { tool: null, args: {}, path: 'tier2-no-call' }
    }

    // Resolve against the CANDIDATE set only. The old full-registry match silently
    // accepted any hallucinated-but-real tool name outside the shortlist — an
    // undocumented, unmeasured escape hatch. Off-candidate picks are now logged
    // distinctly and dropped (fail open to conversation).
    // Multi-intent turns ("lights off and play jazz") used to half-execute
    // silently — only tool_calls[0] was read. All matched calls are returned now
    // (bounded at 3 total), executed serially by the caller.
    const matchedCalls: { tool: Tool; args: unknown }[] = []
    for (const tc of toolCalls.slice(0, 3)) {
      const m = candidates.find((t) => t.toolDefinition.function.name === tc.function.name)
      if (m) {
        // Skip duplicate calls to the same tool — some models repeat themselves.
        if (!matchedCalls.some((c) => c.tool.id === m.id)) {
          matchedCalls.push({ tool: m, args: tc.function.arguments })
        }
      } else {
        const inRegistry = toolRegistry.some((t) => t.toolDefinition.function.name === tc.function.name)
        logger.info(`[ROUTER] tier2 result=${inRegistry ? 'off-candidate-tool' : 'unknown-tool'}(${tc.function.name}) ${t2Ms}ms`)
      }
    }
    if (matchedCalls.length === 0) {
      return { tool: null, args: {}, path: 'tier2-unmatched' }
    }

    const primary = matchedCalls[0]!
    const extraCalls = matchedCalls.slice(1)
    logger.info(`[ROUTER] tier2 result=tool(${matchedCalls.map((c) => c.tool.id).join('+')}) ${t2Ms}ms model=${routerModel}`)
    return { tool: primary.tool, args: primary.args, path: 'tier2', ...(extraCalls.length > 0 && { extraCalls }) }
  } catch {
    const t2Ms = (performance.now() - t2Start).toFixed(0)
    logger.info(`[ROUTER] tier2 result=error ${t2Ms}ms — falling back`)
    return { tool: null, args: {}, path: 'tier2-error' }
  }
}
