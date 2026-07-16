// Conservative, rule-based cleanup of a raw Whisper final transcript before it is shown
// as the user's message and sent to the LLM. No model call (latency-free). The rules only
// remove obvious speech disfluencies and never change wording, so meaning is preserved.
//
// Deliberately conservative: if cleaning would empty the utterance, the original trimmed
// text is returned (so a user who genuinely only said "um" still submits something, and
// stop-word detection upstream keeps operating on the raw text).

// Standalone filler tokens dropped only when they stand alone as a word. "hmm" is left in
// (it can be a meaningful acknowledgement); "like"/"you know" are left in (too risky to
// strip without changing meaning).
const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'erm', 'ah', 'er'])

/** Remove filler words, collapse immediate word repeats (false starts) and extra spaces. */
export function cleanTranscript(raw: string): string {
  const original = raw.trim()
  if (!original) return original

  // Tokenize on whitespace; keep trailing punctuation attached to each token.
  const tokens = original.split(/\s+/)

  // 1) Drop standalone filler tokens (compare on the letters only, case-insensitive).
  const kept: string[] = []
  for (const tok of tokens) {
    const bare = tok.toLowerCase().replace(/[^a-z]/g, '')
    if (FILLERS.has(bare)) continue
    kept.push(tok)
  }

  // 2) Collapse an immediately repeated word (a common false start: "I I want" -> "I want",
  //    "the the dog" -> "the dog"). Only collapse when the bare letters match exactly.
  const deduped: string[] = []
  for (const tok of kept) {
    const prev = deduped[deduped.length - 1]
    const sameAsPrev =
      prev !== undefined &&
      prev.toLowerCase().replace(/[^a-z]/g, '') === tok.toLowerCase().replace(/[^a-z]/g, '') &&
      tok.replace(/[^a-z]/gi, '').length > 0
    if (sameAsPrev) continue
    deduped.push(tok)
  }

  let out = deduped.join(' ').replace(/\s+([,.;:!?])/g, '$1').trim()

  // 3) Capitalize the first alphabetic character (Whisper sometimes lowercases the opener
  //    after we strip a leading filler).
  out = out.replace(/^(\W*)([a-z])/, (_m, lead: string, ch: string) => lead + ch.toUpperCase())

  // Never return empty from a non-empty utterance (fall back to the original, with interior
  // whitespace normalized).
  return out || original.replace(/\s+/g, ' ')
}
