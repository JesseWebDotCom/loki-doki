// ── CSAM guard ────────────────────────────────────────────────────────────────
//
// Reusable, centralized child-sexual-abuse-material defense for every image/video
// surface. This is the one non-negotiable floor referenced by IRREDUCIBLE_CORE in
// lib/contentPolicy.ts, but expressed for *pixels* instead of an LLM prompt — a
// diffusion model can't be "instructed" out of it, so we screen inputs and outputs
// directly.
//
// Two layers, both exported so callers can compose them:
//   screenPrompt(text)  — synchronous term-intersection blocklist. Runs at submit,
//                         before any GPU work, so it's ~free and refusing a blocked
//                         prompt costs nothing. This is the always-on floor and is
//                         NOT bypassable by the `uncensored_images` consent.
//   screenImage(base64) — one CPU VLM pass over a supplied or in-progress image, for
//                         the cases a prompt blocklist can't see (i2v inputs, uploads,
//                         mid-generation previews).
//
// Honest about limits: a blocklist is evadable and a VLM classifier has false
// negatives. This is responsible defense-in-depth that stops casual/accidental
// generation and the obvious cases — not a guarantee. See docs/SECURITY.md.

import { ollamaChat } from '@/llm/ollama'
import { getVisionModel } from '@/lib/models'
import { logger } from '@/lib/logger'

// Terms that are CSAM-coded on their own — block regardless of context.
const STANDALONE_TERMS = [
  'loli', 'lolicon', 'shota', 'shotacon', 'lolita',
  'csam', 'jailbait', 'pedo', 'pedophil', 'childporn', 'child porn',
  'cp ', 'underage sex', 'underage porn', 'preteen sex',
]

// Indicators that a depicted person is (or appears to be) a minor.
const AGE_TERMS = [
  'child', 'children', 'kid', 'kids', 'toddler', 'infant', 'baby', 'babies',
  'preteen', 'pre-teen', 'tween', 'pubescent', 'prepubescent', 'pre-pubescent',
  'underage', 'under-age', 'underaged', 'minor', 'minors', 'juvenile',
  'schoolgirl', 'schoolboy', 'school girl', 'school boy', 'schoolkid',
  'elementary school', 'middle school', 'grade school', 'kindergarten',
  'little girl', 'little boy', 'young girl', 'young boy', 'small girl', 'small boy',
  'newborn', 'baby girl', 'baby boy',
  // Child-FACE cues — attackers push these to steer a model toward child features even
  // under a "little person/adult" framing. Caught here when paired with a sexual term.
  'childlike', 'child-like', 'childish', 'baby-faced', 'babyface', 'baby face',
  'infantile', 'childlike face', 'child face', 'childlike body',
]

// Sexual / explicit indicators.
const SEXUAL_TERMS = [
  'sex', 'sexual', 'sexy', 'nude', 'naked', 'nudity', 'nsfw', 'porn', 'porno',
  'explicit', 'erotic', 'lewd', 'hentai', 'ecchi', 'ahegao', 'fetish',
  'genital', 'genitalia', 'penis', 'vagina', 'pussy', 'cock', 'dick',
  'breast', 'breasts', 'boob', 'nipple', 'areola', 'cleavage',
  'cum', 'creampie', 'penetration', 'penetrated', 'intercourse', 'fellatio',
  'masturbat', 'orgasm', 'spread legs', 'spreading legs', 'topless', 'bottomless',
  'lingerie', 'thong', 'panties', 'undress', 'undressing', 'bikini', 'suggestive',
  'seductive', 'provocative', 'in heat', 'in bed', 'molest',
]

export interface PromptVerdict {
  blocked: boolean
  /** Why it was blocked. Server-side/log use only — never echo verbatim to the user. */
  reason?: string
}

// Any explicitly-stated age under 18 (e.g. "12yo", "age 12", "12 years old").
function hasMinorAge(haystack: string): boolean {
  const patterns = [
    /\b(\d{1,2})\s*(?:yo|y\/o|y\.o\.?|yrs?|years?[\s-]*old)\b/g,
    /\bage[d]?\s*(?:of\s*)?(\d{1,2})\b/g,
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(haystack)) !== null) {
      const n = Number(m[1])
      if (Number.isFinite(n) && n < 18) return true
    }
  }
  return false
}

/**
 * Synchronous CSAM screen for a text prompt (positive + negative). Blocks when a
 * standalone CSAM term appears, or when a minor indicator (word OR sub-18 age)
 * co-occurs with any sexual indicator. Cheap enough to run on every submit.
 */
export function screenPrompt(text: string): PromptVerdict {
  if (!text) return { blocked: false }
  // Normalize: lowercase, strip combining marks, collapse separators that are often
  // used to slip terms past a naive contains() (l.o.l.i, l-o-l-i, l_o_l_i).
  const norm = text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  const compact = norm.replace(/[\s._\-*]+/g, ' ')
  const tight = norm.replace(/[\s._\-*]+/g, '')

  for (const t of STANDALONE_TERMS) {
    const needle = t.trim()
    if (compact.includes(needle) || tight.includes(needle.replace(/\s+/g, ''))) {
      return { blocked: true, reason: `standalone term: "${t.trim()}"` }
    }
  }

  const hasAge = AGE_TERMS.some((a) => compact.includes(a)) || hasMinorAge(compact)
  if (!hasAge) return { blocked: false }

  const sexual = SEXUAL_TERMS.find((s) => compact.includes(s))
  if (sexual) return { blocked: true, reason: `minor indicator + sexual term: "${sexual}"` }

  return { blocked: false }
}

/**
 * True if the text contains a minor/age indicator (word or sub-18 age) — WITHOUT
 * requiring a sexual term. Used to risk-gate output screening and to block
 * "transform a supplied person image toward a child" at submit.
 */
export function hasMinorIndicator(text: string): boolean {
  if (!text) return false
  const norm = text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  const compact = norm.replace(/[\s._\-*]+/g, ' ')
  return AGE_TERMS.some((a) => compact.includes(a)) || hasMinorAge(compact)
}

export interface ImageVerdict {
  /** True only when the classifier affirmatively flagged minor + sexual content. */
  flagged: boolean
  /** True when the screen could not run (model error/timeout). Lets the caller decide fail-open vs fail-closed. */
  error?: boolean
  reason?: string
}

const IMAGE_PROMPT =
  'You are a strict child-safety classifier. Look at this image — it may be blurry, ' +
  'noisy, or partially generated. Decide ONE thing: does it depict a real or apparent ' +
  'MINOR (a person whose DEVELOPMENTAL age looks under 18) in a sexual, nude, or sexualized way? ' +
  'Sexualized includes nudity, exposed genitals/breasts, underwear focus, or sexual posing. ' +
  '\n\nCRITICAL — judge developmental maturity from the FACE, NOT body size or height. ' +
  'A short, petite, or little-person (dwarfism) adult has an ADULT FACE on a small body — ' +
  'mature facial structure, adult jaw/brow, adult proportions. That is an ADULT; do NOT flag. ' +
  'Small size or a small frame is NOT evidence of being a minor by itself. ' +
  'BUT this exception is ONLY for an adult face on a small body. If the FACE and head read as ' +
  'a young child (large rounded forehead, small chin, childlike features), treat the subject ' +
  'as a MINOR and flag it — regardless of body size, art style, or any framing. A small adult ' +
  'body does NOT excuse a child\'s face, and a child\'s face is NOT excused by calling it a ' +
  '"little person", "dwarf", or "adult". The face decides when it is visible. ' +
  '\n\nIf the face is hidden, masked, turned away, cropped, or obscured, judge developmental ' +
  'age from the BODY instead: head-to-body ratio (children are proportionally much ' +
  'larger-headed), limb and torso proportions, and the presence or absence of adult secondary ' +
  'sexual characteristics. A clearly pre-pubescent or young-child body in a sexual context is ' +
  'flagged even with no visible face. ' +
  '\n\nOrdinary clothed children, family photos, and non-sexual nudity of adults are NOT flagged. ' +
  'Be conservative: only flag when an apparent minor AND sexualization are both clearly present. ' +
  'Return JSON only, no other text: {"flagged": true|false, "reason": "<=10 words"}'

/**
 * Screen an image for apparent-minor sexual content. Requires TWO independent flags
 * before reporting `flagged` — a single VLM hallucination (e.g. misreading an adult
 * little person, or a stylized adult) no longer blocks a legitimate image, while a
 * genuine positive is confirmed. The second pass only runs on the rare flagged case,
 * so normal generation pays no extra latency.
 */
export async function screenImage(base64: string): Promise<ImageVerdict> {
  if (!base64) return { flagged: false }
  const first = await classifyImageOnce(base64)
  if (!first.flagged) return first // clean, or {error:true} — caller decides fail-open/closed
  const second = await classifyImageOnce(base64)
  if (second.flagged) return { flagged: true, reason: first.reason }
  return { flagged: false } // the two passes disagreed → do not act on a single flag
}

/**
 * One VLM pass over an image (input upload, i2v source, or in-progress preview).
 * Forces CPU (num_gpu:0) so it never competes with an active diffusion job on the GPU.
 * On any error returns { flagged:false, error:true } — the CALLER chooses fail-open
 * (quality previews) vs fail-closed (untrusted uploads).
 */
async function classifyImageOnce(base64: string): Promise<ImageVerdict> {
  if (!base64) return { flagged: false }
  try {
    const visionModel = await getVisionModel()
    const res = await ollamaChat(
      visionModel,
      [{ role: 'user', content: IMAGE_PROMPT, images: [base64] }],
      [],
      { num_gpu: 0, num_predict: 80, temperature: 0 },
    )
    const raw = res.message?.content?.trim() ?? ''
    const json = raw.match(/\{[\s\S]*\}/)
    if (!json) return { flagged: false }
    const parsed = JSON.parse(json[0]) as { flagged?: unknown; reason?: unknown }
    if (parsed.flagged === true) {
      const reason = typeof parsed.reason === 'string' ? parsed.reason : 'classifier flag'
      return { flagged: true, reason }
    }
    return { flagged: false }
  } catch (err) {
    logger.warn(`[safety] screenImage failed: ${err instanceof Error ? err.message : String(err)}`)
    return { flagged: false, error: true }
  }
}

/** Standard structured log line for a blocked attempt (no raw prompt/image content). */
export function logCsamBlock(surface: string, userId: string, reason: string): void {
  logger.warn(`[safety] CSAM guard blocked ${surface} for user=${userId} (${reason})`)
}
