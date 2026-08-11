// Honest Titles: AI de-clickbait for the YouTube titles DeArrow has never seen.
//
// DeArrow (lib/youtube/dearrow.ts) is crowdsourced, so it only ever covers videos a
// stranger has bothered to retitle, which in practice means large channels. A small
// creator's "the secret is out" / "let's address this" / "guitar players: WAKE UP!"
// passes through untouched because nobody has submitted anything for it. This module
// fills that gap with a local model, and it is served through the same batch endpoint
// DeArrow already uses, so every client (TV, phone, web) picks it up with no change.
//
// Precedence is deliberate: a human-voted DeArrow title always wins, an AI title is
// only a fallback, and the creator's own title stands when neither exists.
//
// Two rules keep this cheap. First, a lexical gate (looksClickbaity) means an already
// honest title is never sent to a model, so a normal feed costs nothing. Second,
// generation and display are split the way lib/videos/smartTitle.ts splits them: every
// read path only ever PEEKS the cache (zero added latency) and warms misses in the
// background.
//
// Display happens twice over, deliberately. stampHonestTitles runs at the list choke
// point (lib/videos/policy.ts) so cards arrive already correct, and the DeArrow batch
// carries the same titles for anything that asks about ids it did not get from a list.
// Precompute (lib/precompute.ts) writes them for new uploads before anyone looks.

import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { ytVideos, userPreferences } from '@/db/schema'
import { cachedLookupPut, cachedLookupStale, THIRTY_DAYS_MS } from '@/lib/lookupCache'
import { ollamaChat } from '@/llm/ollama'
import { getFastModel } from '@/lib/models'
import { stripUrls } from '@/lib/youtube/textClean'
import { logger } from '@/lib/logger'

const PREF_KEY = 'youtube.honest_titles'

/** Defaults on, matching Smart Description, Smart Titles, SponsorBlock and DeArrow. */
export async function isHonestTitlesEnabled(userId: string): Promise<boolean> {
  const [row] = await db.select({ value: userPreferences.value }).from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, PREF_KEY)))
    .limit(1)
  return row ? row.value !== 'false' : true
}

// ── The gate ────────────────────────────────────────────────────────────────────
// Scored rather than boolean so no single signal can convict a title on its own.
// Threshold 3 clears ordinary titles ("Building a Telecaster from scratch, part 3")
// while catching the curiosity-gap house style.

/** All-caps words that are ordinary vocabulary, not shouting. */
const ACRONYMS = new Set([
  'DIY', 'AI', 'CPU', 'GPU', 'USB', 'LED', 'PC', 'TV', 'USA', 'UK', 'EU', 'NASA', 'FBI',
  'CIA', 'NFL', 'NBA', 'MLB', 'UFC', 'F1', 'EV', 'VR', 'AR', 'HDR', 'RAM', 'SSD', 'OS',
  'API', 'SQL', 'CSS', 'HTML', 'JS', 'MIDI', 'DAW', 'EQ', 'DI', 'PA', 'IR', 'BPM', 'LP',
  'EP', 'CD', 'HD', 'FPS', 'RPG', 'FPS', 'MMO', 'ASMR', 'Q&A', 'NYC', 'LA', 'UFO',
])

/** Curiosity-gap openers and hooks: the title promises a payoff instead of naming one. */
const HOOK_PHRASES = [
  'the secret', 'secrets', 'the truth about', 'what really happened', "you won't believe",
  'you wont believe', 'nobody tells you', 'no one tells you', 'nobody talks about',
  'what they don', 'they don\'t want you', 'they dont want you', 'this changes everything',
  'gone wrong', 'gone right', 'i was wrong', 'we need to talk', "let's talk about",
  'lets talk about', "let's address", 'lets address', 'it\'s over', 'its over',
  'the end of', 'read the description', 'watch before', 'before it\'s too late',
  'wake up', 'stop doing', 'you are doing', "you're doing it wrong", 'doing it wrong',
  'is out', 'finally', 'shocking', 'insane', 'i can\'t believe', 'i cant believe',
  'this is why', 'here\'s why', 'heres why', 'what happened to', 'the real reason',
  'changed my life', 'blew my mind', 'must watch', 'please watch', 'i quit',
]

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u

/** Words that carry no subject on their own: a title built only from these promises
 *  something without naming it. */
const DEIXIS = /\b(this|that|these|those|it|they|them|he|she|him|her|everything|something|anything)\b/i

function hasProperNoun(title: string): boolean {
  // Anything capitalized past the first word, or any digit, counts as a concrete subject.
  const words = title.trim().split(/\s+/).slice(1)
  return /\d/.test(title) || words.some(w => /^[A-Z][a-z]{2,}/.test(w))
}

/**
 * How much this title reads as a hook rather than a description. Exported for tests and
 * for the admin surface; callers should use looksClickbaity.
 */
export function clickbaitScore(rawTitle: string): number {
  const title = rawTitle.trim()
  if (!title) return 0
  const lower = title.toLowerCase()
  let score = 0

  // Shouting: a fully capitalized word that is neither an acronym nor a roman numeral
  // (sequels and mission numbers are not hype: "Artemis III", "Part IV").
  const shouted = title.split(/[\s|,:;.!?()\[\]-]+/)
    .filter(w => w.length >= 3 && /^[A-Z]+$/.test(w)
      && !ACRONYMS.has(w) && !/^[IVXLC]+$/.test(w))
  if (shouted.length) score += 2

  // Trailing ellipsis: the payoff is deliberately withheld ("finally...").
  if (/(\.\.\.|…)\s*$/.test(title)) score += 2

  if (HOOK_PHRASES.some(p => lower.includes(p))) score += 3

  // Promises a subject it never names.
  if (DEIXIS.test(title) && !hasProperNoun(title)) score += 2

  if (/!{2,}|\?!|!\?|\?{2,}/.test(title)) score += 2
  else if ((title.match(/[!?]/g) ?? []).length >= 1 && !hasProperNoun(title)) score += 1

  if (EMOJI.test(title)) score += 1

  // Terse and subjectless ("let's address this").
  if (title.split(/\s+/).length <= 4 && !hasProperNoun(title)) score += 1

  return score
}

const CLICKBAIT_THRESHOLD = 3

export function looksClickbaity(title: string | null | undefined): boolean {
  return !!title && clickbaitScore(title) >= CLICKBAIT_THRESHOLD
}

// ── Generation ──────────────────────────────────────────────────────────────────

const HONEST_TITLE_SYSTEM =
  'You rewrite clickbait video titles into plain, factual ones. You are given the ' +
  'creator\'s original title and a description of what the video actually contains. ' +
  'Write a single title that names the real subject: what the video is about, who or ' +
  'what it covers, what happens in it. Under 70 characters. Sentence case, not Title ' +
  'Case, and never all caps. No hype words, no questions aimed at the viewer, no ' +
  'ellipsis, no exclamation marks, no emoji, no quotation marks. Do not start with the ' +
  'channel name. If the material given does not actually say what the video is about, ' +
  'output exactly NONE. Output only the title, nothing else.'

const NONE_SENTINEL = /^\s*none\s*[.!]?\s*$/i

/** Everything we know about what the video actually contains, best first. The
 *  transcript summary is the most reliable (it describes the video, not the marketing),
 *  the cleaned description next, the raw description last. */
function evidenceFrom(v: { summary: string | null; descriptionClean: string | null; description: string | null }): string | null {
  const candidates = [v.summary, v.descriptionClean, v.description ? stripUrls(v.description) : null]
  for (const c of candidates) {
    const text = c?.trim()
    if (text && text.length >= 120) return text.slice(0, 4000)
  }
  // Nothing substantial: a short description is still better than nothing, but only if
  // it says something beyond a link dump.
  const short = v.description ? stripUrls(v.description).trim() : ''
  return short.length >= 40 ? short.slice(0, 4000) : null
}

/**
 * "Ask me again later", as an exception rather than a value. The cache stores whatever
 * the fetcher RETURNS, including null, but never caches a throw. That distinction is the
 * whole point here: "this title is fine" is a verdict worth keeping for 30 days, while
 * "we do not know what this video contains yet" must not be, or the first grid render
 * that sees a brand new upload (before the hub has its description, let alone a summary)
 * would settle the question for a month. That is exactly what happened to "finally..."
 * (Jesse, 2026-08-10).
 */
class NotYet extends Error {}

async function generate(videoId: string): Promise<string | null> {
  const [v] = await db.select().from(ytVideos).where(eq(ytVideos.videoId, videoId)).limit(1)
  const original = v?.title?.trim()
  // No row yet means no title to judge, which is a "later", not a "no".
  if (!original) throw new NotYet(videoId)
  if (!looksClickbaity(original)) return null

  const evidence = evidenceFrom(v)
  if (!evidence) {
    logger.info({ videoId }, 'honest title: not yet (nothing describing the video)')
    throw new NotYet(videoId)
  }

  logger.info({ videoId }, 'honest title: generating')
  const model = await getFastModel()
  const result = await ollamaChat(model, [
    { role: 'system', content: HONEST_TITLE_SYSTEM },
    {
      role: 'user',
      content: `Channel: ${v?.author ?? 'unknown'}\nOriginal title: ${original}\n\nWhat the video contains:\n${evidence}`,
    },
  ], undefined, { temperature: 0.2, num_predict: 40 })

  let title = result.message.content.trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!title || NONE_SENTINEL.test(title)) return null
  // A model that ignored the length rule, or answered with a sentence, is not a title.
  if (title.length > 90 || title.split(/\s+/).length > 16) return null
  // No point swapping a title for itself, and a rewrite that is still clickbait is worse
  // than useless: it spends a model call to change nothing.
  if (title.toLowerCase() === original.toLowerCase()) return null
  if (looksClickbaity(title)) {
    logger.info({ videoId, title }, 'honest title: rejected (rewrite still reads as a hook)')
    return null
  }
  return title
}

// v2: the namespace carries the ruleset version, so tuning the gate or the prompt
// retires every verdict written under the old one instead of leaving videos judged by
// rules that no longer exist.
const NS = 'youtube:honest-title-v2'
/** A rewrite (or a title that reads fine) is settled: neither the upload's title nor
 *  its content is going to change. */
const KEEP_MS = THIRTY_DAYS_MS
/** A "no" is softer than a yes. The model declining, or a rewrite that came back still
 *  reading as a hook, is a verdict about a model on a particular day, and re-deciding
 *  costs one cheap gate check for titles that were simply fine. */
const RETRY_MS = 3 * 24 * 60 * 60 * 1000

/**
 * Generate and cache the honest title for a video if absent. Returns null when the title
 * is already fine, when we have nothing describing the video yet, or when the model
 * declined. Safe on single-item paths only (one model call, 1 to 3s); lists must use
 * stampHonestTitles.
 */
export async function ensureHonestTitle(videoId: string): Promise<string | null> {
  const cached = await cachedLookupStale<string | null>(NS, videoId)
  if (cached.value !== undefined && cached.fresh) return cached.value
  try {
    const title = await generate(videoId)
    await cachedLookupPut(NS, videoId, title ? KEEP_MS : RETRY_MS, title)
    return title
  } catch {
    // NotYet, or the model failed: cache nothing so the next pass tries again.
    return null
  }
}

/** Read-only cache peek. Never generates, so it is always safe on a batch path. A stale
 *  entry still hands back its title (a card keeps a good title while we re-decide). */
async function peekHonestTitle(videoId: string): Promise<{ title: string | null; settled: boolean }> {
  const cached = await cachedLookupStale<string | null>(NS, videoId)
  return { title: cached.value ?? null, settled: cached.value !== undefined && cached.fresh }
}

// Background warming for cache misses seen by the batch route. Bounded hard: a feed
// scroll can surface a hundred unseen ids at once and every one of them is a model call,
// so we run a few at a time and drop the rest (the next render re-offers them).
const WARM_CONCURRENCY = 2
const WARM_QUEUE_CAP = 24
const warming = new Set<string>()
const warmQueue: string[] = []

function pumpWarmQueue(): void {
  while (warming.size < WARM_CONCURRENCY && warmQueue.length) {
    const id = warmQueue.shift()!
    warming.add(id)
    void ensureHonestTitle(id).finally(() => {
      warming.delete(id)
      pumpWarmQueue()
    })
  }
}

function warmLater(videoId: string): void {
  if (warming.has(videoId) || warmQueue.includes(videoId)) return
  if (warmQueue.length >= WARM_QUEUE_CAP) return
  warmQueue.push(videoId)
  pumpWarmQueue()
}

/**
 * Batch path: the cached honest title for each id that has one, plus a background warm
 * for the clickbaity ones that do not. Returns only ids with a title, so callers can
 * spread it straight over their branding map.
 */
export async function honestTitlesFor(videoIds: string[], userId: string): Promise<Record<string, string>> {
  if (!videoIds.length || !(await isHonestTitlesEnabled(userId))) return {}

  const out: Record<string, string> = {}
  const misses: string[] = []
  await Promise.all(videoIds.map(async id => {
    const { title, settled } = await peekHonestTitle(id)
    if (title) out[id] = title
    // Queue anything not settled: never looked at, or a soft "no" whose retry window
    // has passed. A stale-but-present title still shows above while we re-decide.
    if (!settled) misses.push(id)
  }))

  if (misses.length) {
    // One query for the whole miss list, then only the hooks get queued.
    const rows = await db.select({ videoId: ytVideos.videoId, title: ytVideos.title })
      .from(ytVideos).where(inArray(ytVideos.videoId, misses))
    const byId = new Map(rows.map(r => [r.videoId, r.title]))
    for (const id of misses) {
      if (looksClickbaity(byId.get(id))) warmLater(id)
    }
  }
  return out
}

/**
 * Swap each item's title for its honest one before the list ever leaves the server.
 * The DeArrow batch the clients run after first paint can do this too, but only after
 * the card has already painted the clickbait, so you watch the title change under you.
 * Stamping here means a card arrives correct (Jesse, 2026-08-10: "I see the old titles
 * and then quickly see the new"), and it reaches surfaces that never call that endpoint
 * at all. Peek-only, so it adds no model latency to a list response.
 */
export async function stampHonestTitles<T extends { videoId: string; title: string }>(
  items: T[], userId: string,
): Promise<T[]> {
  if (!items.length) return items
  const titles = await honestTitlesFor(items.map(i => i.videoId), userId)
  if (!Object.keys(titles).length) return items
  return items.map(i => (titles[i.videoId] ? { ...i, title: titles[i.videoId]! } : i))
}
