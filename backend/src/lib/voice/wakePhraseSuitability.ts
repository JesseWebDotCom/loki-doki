// Wake-phrase suitability scoring (design P1.6).
//
// Short, common-sounding wake phrases ("Hey Bo", "Hey Sol", "Hey Lux") are near-
// homophones of everyday speech ("hey so", "hey look") and a measured wake-word
// false-trigger source. This scores a candidate phrase heuristically so the UI can
// warn (never block) before a detector is trained for it. Picovoice's guidance is
// similar: prefer 6+ phonemes with diverse sounds, avoid single short words.

export type PhraseSuitability = 'good' | 'fair' | 'weak'

export interface PhraseScore {
  level: PhraseSuitability
  /** Human-readable notes: what's weak (or, when good, a short reassurance). */
  reasons: string[]
}

// Short words / particles a wake NAME collides with when it is itself short. Not
// exhaustive — it's a cheap guard for the worst offenders, not a pronunciation model.
const COMMON_COLLISIONS = new Set([
  'look', 'luck', 'low', 'loki', 'so', 'sol', 'soul', 'sole', 'bo', 'bow', 'go', 'no',
  'oh', 'hi', 'yo', 'okay', 'ok', 'mo', 'joe', 'row', 'know', 'now', 'new', 'you', 'who',
  'to', 'two', 'do', 'lo', 'ho', 'po', 'see', 'be', 'me', 'we', 'key', 'way', 'day',
  'they', 'pay', 'may', 'lux', 'looks', 'pip', 'volt', 'otto', 'auto', 'milo',
])

const LEAD = new Set(['hey', 'ok', 'okay', 'hi', 'yo'])

function syllableEstimate(word: string): number {
  const m = word.toLowerCase().replace(/[^a-z]/g, '').match(/[aeiouy]+/g)
  return m ? m.length : 1
}

/** Score how distinctive a wake phrase is (higher = less likely to false-trigger). */
export function scoreWakePhrase(phrase: string): PhraseScore {
  const norm = phrase.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim()
  if (!norm) return { level: 'weak', reasons: ['Enter a wake phrase.'] }
  const words = norm.split(' ').filter(Boolean)
  const reasons: string[] = []

  // The distinctive part is the NAME — the word(s) after a leading "hey"/"ok"/"hi".
  const hasLead = !!words[0] && LEAD.has(words[0])
  const nameWords = hasLead ? words.slice(1) : words
  const letters = nameWords.join('').length
  const nameSyll = nameWords.reduce((n, w) => n + syllableEstimate(w), 0)

  let score = 0
  if (nameWords.length >= 2) score += 2 // a multi-word name is inherently distinctive
  if (nameSyll >= 3) score += 2
  else if (nameSyll === 2) score += 1
  else reasons.push('The name is a single syllable, which is easy to confuse with everyday speech.')
  if (letters >= 5) score += 1
  else if (letters > 0) reasons.push('The name is very short; a longer name carries more distinctive sound.')
  if (nameWords.some((w) => COMMON_COLLISIONS.has(w))) {
    score -= 2
    reasons.push('This sounds like a common word or phrase, so it can trigger on ordinary speech. Try a longer or less common name.')
  }
  if (!hasLead) reasons.push('Starting with "Hey" (e.g. "Hey Nadia") helps the detector require the whole phrase.')

  const level: PhraseSuitability = score >= 3 ? 'good' : score >= 1 ? 'fair' : 'weak'
  // A 'good' phrase cleared the bar despite any single soft flag (e.g. a multi-word
  // name that contains a common word); don't show contradictory weakness notes.
  if (level === 'good') return { level, reasons: ['Distinctive and unlikely to false-trigger.'] }
  return { level, reasons }
}
