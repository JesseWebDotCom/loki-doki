// Per-sentence punctuation refinement for TTS (Phase 2 of voice-prosody).
//
// Kokoro has no SSML and limited expressiveness, but its intonation IS driven by
// terminal punctuation: `?` raises pitch, `…` adds a trailing pause, `!` clips it
// short. The LLM's punctuation is often sloppy (missing terminals, statement-form
// questions like "Is that what you meant."), so we lightly normalize each
// segmented sentence before synthesis and derive a per-sentence trailing pause.
//
// Conservative on purpose: we only convert to `?` when a sentence is led by an
// auxiliary verb (do/are/can/…) — a reliable interrogative signal — never on
// wh-words ("What a day!" is an exclamation, not a question).

export interface RefinedSentence {
  /** The text actually sent to the engine (punctuation normalized). */
  text: string
  /** Trailing silence after this sentence, in seconds. */
  pausePost: number
}

const BASE_PAUSE = 0.3

// Sentence-initial auxiliaries → strong interrogative signal. Allows a leading
// coordinating conjunction ("And do you…", "But is it…").
const AUX_START =
  /^(?:and |but |so )?(?:do|does|did|are|is|am|was|were|can|could|would|will|should|shall|have|has|had|may|might|won'?t|isn'?t|aren'?t|don'?t|doesn'?t|didn'?t|couldn'?t|wouldn'?t|shouldn'?t|haven'?t|hasn'?t)\b/i

function looksLikeQuestion(s: string): boolean {
  return AUX_START.test(s.replace(/^["'“‘\s]+/, ''))
}

function pauseFor(s: string): number {
  if (s.endsWith('…')) return 0.5 // trailing off / hesitation — let it breathe
  if (s.endsWith('!')) return 0.22 // energetic — keep it moving
  if (s.endsWith('?')) return 0.38 // give the question room
  return BASE_PAUSE
}

/** Normalize one segmented sentence's punctuation and compute its trailing pause. */
export function refineSentence(raw: string): RefinedSentence {
  let s = raw.trim()
  if (!s) return { text: s, pausePost: BASE_PAUSE }

  // A fragment ending in clause punctuation (from a long-sentence backend split)
  // keeps flowing into the next chunk — don't append a terminal or convert to a
  // question ("Was it on social media," must NOT become "…media,?"). Short pause.
  if (/[,;:—–]$/.test(s)) return { text: s, pausePost: 0.15 }

  // Collapse ASCII "..." (and longer runs) to a single ellipsis — cleaner pause.
  s = s.replace(/\.{3,}/g, '…')

  if (!/[.!?…]$/.test(s)) {
    // Missing terminal punctuation: question if auxiliary-led, else a period.
    s += looksLikeQuestion(s) ? '?' : '.'
  } else if (s.endsWith('.') && looksLikeQuestion(s)) {
    // Statement-terminated question → swap for rising intonation.
    s = s.slice(0, -1) + '?'
  }

  return { text: s, pausePost: pauseFor(s) }
}
