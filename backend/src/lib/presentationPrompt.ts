// Presentation & response-shaping policy — how the companion FORMATS a reply and
// how LONG it runs, kept separate from WHAT it says (the persona / answer-first
// discipline). Adapted from the published claude.ai formatting prompt and the
// leaked Perplexity structure rules (see
// docs/internal/interpretation-and-presentation-plan.md), compressed to what a
// small local model can actually follow.
//
// TEXT SURFACES ONLY. Voice surfaces (pod, and the character VOICE_RULE) speak
// their replies aloud, where "use a Markdown table" / "put source markers inline"
// are nonsense — so this must never reach a spoken surface. The caller gates on
// surface; PRESENTATION_POLICY is also reused verbatim by warmupModel() so the
// KV-cache prefix of the first real chat turn matches.

import type { RouteResult } from '@/llm/router'

// Global, static, identical for every text user — so it sits at the very FRONT of
// the system prompt (before the per-profile content block) and can be centrally
// pre-warmed, giving even non-default-profile users a turn-1 KV hit on this prefix.
export const PRESENTATION_POLICY = [
  'Formatting: default to plain, natural prose, and never open a reply with a heading or bold text.',
  'Answer a simple or casual question in a sentence or two — no headings and no bullet lists.',
  'When you compare two or more things across several features, use a small Markdown table rather than a bulleted list.',
  'Keep any list flat and short, never write a list of a single item, and fold a short set into the sentence ("things like x, y, and z") instead of bulleting it.',
  'Write longer explanations as paragraphs; reserve headings and lists for genuinely long, multi-part answers or when the user asks for them.',
  'When your answer draws on search or tool results, place the source markers inline right after the sentence they support and never add a "Sources" list at the end.',
  // Fold-echo guard (minimal on purpose). History folds tool payloads onto
  // earlier replies as "[tool data behind this reply: ...]"; a small model
  // imitating that tail emitted raw JSON at the user (2026-08-12/13; an output
  // scrub in companionTurn backstops this). Keep the wording SHORT and free of
  // any "data you provided" framing: longer provenance language here measurably
  // primed meta-commentary about the data plumbing and cost conciseness. The
  // prompt-injection guard lives in the per-turn tool-fold instruction
  // (companionTurn) and the attached-documents blocks, not here.
  'A bracketed note like "[tool data behind this reply: ...]" on an earlier message is an internal record: use its facts, but never mention it or write anything in that format yourself.',
].join(' ')

/** The presentation policy for a given surface, or null when it must be suppressed
 *  (pure-voice pod, where nothing here is speakable). Chat and Telegram are text;
 *  the overlay renders a character whose spoken VOICE_RULE already governs it, so
 *  it's treated as voice and skipped. */
export function presentationPolicyFor(surface: string | undefined): string | null {
  const isText = surface === undefined || surface === 'chat' || surface === 'telegram'
  return isText ? PRESENTATION_POLICY : null
}

// ── Per-message verbosity (Phase 3) ───────────────────────────────────────────
// The router already classified the message BEFORE generation, so length can be
// calibrated per message instead of per character. This is a prompt nudge only —
// num_predict stays a ceiling (per-query token budgeting was tried and abandoned;
// it cut off list answers, see docs/internal/chat-latency.md).

// Tools whose answer is a single fact or a card — the reply should be one or two
// sentences and stop. (The card/block carries the data; the prose just states it.)
const QUICK_DATA_TOOLS = new Set([
  'weather', 'datetime', 'time', 'calculator', 'unit_conversion',
  'homeAssistant', 'sports', 'dictionary', 'moonphase', 'holidays',
])

// Open-ended asks that genuinely benefit from a fuller, structured answer.
const OPEN_ENDED_RE = /\b(explain|compare|difference between|pros and cons|walk me through|help me (?:decide|choose|understand|figure out)|how does .{3,40}\bwork|why (?:do|does|is|are|would)|what(?:'s| is) the best way)\b/i

const QUICK_FRAGMENT =
  'This is a quick factual question — give just the answer in a sentence or two, then stop.'
const FULLER_FRAGMENT =
  'This is an open-ended question — a fuller, well-structured answer is appropriate here; take the space to explain it properly.'

/**
 * A one-line per-message length nudge, or null for the neutral middle (where the
 * character's own reply-style + answer-first discipline already govern length).
 * Voice surfaces never get the "fuller" nudge — spoken replies stay short.
 */
export function verbosityFragment(
  route: RouteResult,
  message: string,
  surface: string | undefined,
): string | null {
  const toolId = route.tool?.id
  if (toolId && QUICK_DATA_TOOLS.has(toolId)) return QUICK_FRAGMENT

  const isVoice = surface === 'pod' || surface === 'overlay'
  if (!isVoice && OPEN_ENDED_RE.test(message)) return FULLER_FRAGMENT

  return null
}
