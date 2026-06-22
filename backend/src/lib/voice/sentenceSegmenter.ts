// Sentence segmentation for TTS chunking — hand-rolled TS (no pysbd dependency).
//
// Ported from the intent of v2 `prosody_planner.segment_sentences` + the
// clause-fallback rule (`clause_splitter.py`, decision e-14): segment on
// sentence terminators, and for any segment longer than MAX_CHUNK, fall back to
// clause boundaries (`,;:—` / coordinating conjunctions) at >= MIN_CLAUSE chars,
// hard-capping every chunk at MAX_CHUNK so a runaway sentence never blocks synth.

const MAX_CHUNK = 160
const MIN_CLAUSE = 60

const CLAUSE_PUNCT = new Set([',', ';', ':', '—'])
const CONJUNCTIONS = [
  'and', 'but', 'or', 'because', 'so', 'which', 'that', 'while', 'although', 'however',
]
const CONJUNCTION_RE = new RegExp(`\\b(?:${CONJUNCTIONS.join('|')})\\b`, 'gi')

// Common abbreviations whose trailing period should NOT end a sentence.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'inc', 'ltd', 'co',
])

/** Split into sentences, applying clause fallback + hard cap for over-long segments. */
export function segmentSentences(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  const out: string[] = []
  for (const sentence of splitOnTerminators(trimmed)) {
    if (sentence.length <= MAX_CHUNK) {
      out.push(sentence)
    } else {
      out.push(...splitLong(sentence))
    }
  }
  return out.filter((s) => s.length > 0)
}

function splitOnTerminators(text: string): string[] {
  const sentences: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '.' || ch === '!' || ch === '?' || ch === '\n') {
      // Skip a period that is part of an abbreviation or a decimal number.
      if (ch === '.' && isMidTokenPeriod(text, i)) continue
      // Consume a run of terminators/quotes (e.g. `?!"`).
      let end = i + 1
      while (end < text.length && '.!?"\')]'.includes(text[end]!)) end++
      const piece = text.slice(start, end).trim()
      if (piece) sentences.push(piece)
      start = end
      i = end - 1
    }
  }
  const tail = text.slice(start).trim()
  if (tail) sentences.push(tail)
  return sentences
}

function isMidTokenPeriod(text: string, i: number): boolean {
  // Decimal number: digit before AND after the period.
  if (i > 0 && i < text.length - 1 && /\d/.test(text[i - 1]!) && /\d/.test(text[i + 1]!)) return true
  // Abbreviation: the alphabetic token ending here is a known abbreviation.
  let j = i - 1
  while (j >= 0 && /[A-Za-z]/.test(text[j]!)) j--
  const token = text.slice(j + 1, i).toLowerCase()
  if (token.length === 0) return false
  // Single letters are always initials or acronym components (R.E.M., U.S.A., etc.)
  if (token.length === 1) return true
  return ABBREVIATIONS.has(token)
}

/** Break an over-long sentence at clause boundaries, then hard-cap leftovers. */
function splitLong(sentence: string): string[] {
  const boundaries = clauseBoundaries(sentence).filter((b) => b >= MIN_CLAUSE)
  const chunks: string[] = []
  let start = 0
  for (const b of boundaries) {
    if (b - start >= MIN_CLAUSE && b - start <= MAX_CHUNK) {
      chunks.push(sentence.slice(start, b).trim())
      start = b
    }
  }
  const rest = sentence.slice(start).trim()
  if (rest) chunks.push(rest)
  // Hard-cap any chunk still over MAX_CHUNK by slicing on whitespace.
  return chunks.flatMap(hardCap).filter((s) => s.length > 0)
}

function clauseBoundaries(text: string): number[] {
  const offsets = new Set<number>()
  for (let i = 0; i < text.length; i++) {
    if (CLAUSE_PUNCT.has(text[i]!)) offsets.add(i + 1) // break AFTER the punctuation
  }
  CONJUNCTION_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CONJUNCTION_RE.exec(text)) !== null) offsets.add(m.index)
  return [...offsets].sort((a, b) => a - b)
}

function hardCap(chunk: string): string[] {
  if (chunk.length <= MAX_CHUNK) return [chunk]
  const out: string[] = []
  let s = chunk
  while (s.length > MAX_CHUNK) {
    let cut = s.lastIndexOf(' ', MAX_CHUNK)
    if (cut < MIN_CLAUSE) cut = MAX_CHUNK // no good space — cut hard
    out.push(s.slice(0, cut).trim())
    s = s.slice(cut).trim()
  }
  if (s) out.push(s)
  return out
}
