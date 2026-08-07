// YouTube's free films are titled for the algorithm, not for a catalogue:
//   "FULL COMEDY MOVIE / GROWING UP, BLACK NOTICE - Jason Statham"
//   "ACTION MOVIE 2026 | Tom Hardy, Idris Elba | Full HD"
//   "New English Action Movie 2026 Full HD"
// This reduces one of those to a probable film title and year with plain
// code and no model. Anything it can't crack is handed to a small LLM pass
// by the caller (Jesse, 2026-08-07: "do an initial fix with code, then a
// quick pass on that").

/** Marketing words that are never part of a title. */
const NOISE = [
  'full movie', 'full film', 'free movie', 'full length movie', 'free full movie',
  'watch free', 'free to watch', 'english movie', 'hollywood movie', 'blockbuster',
  'official trailer', 'exclusive', 'premiere', 'full hd', 'hd', '4k', '1080p', '720p',
  'subtitled', 'english subtitles', 'no ads',
]

const GENRES = [
  'action', 'comedy', 'horror', 'drama', 'thriller', 'family', 'romance', 'romantic',
  'sci-fi', 'scifi', 'science fiction', 'western', 'crime', 'adventure', 'fantasy',
  'animation', 'animated', 'kids', 'mystery', 'war', 'documentary',
]

/** A segment that is pure marketing: "FULL COMEDY MOVIE", "Action Movie 2026". */
function isMarketing(segment: string): boolean {
  const s = segment.toLowerCase().replace(/[0-9]{4}/g, ' ').replace(/[^a-z\s-]/g, ' ')
  const words = s.split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const allowed = new Set([...GENRES, 'full', 'free', 'new', 'best', 'movie', 'film', 'movies',
    'length', 'english', 'hollywood', 'latest', 'hd', 'watch', 'online', 'complete'])
  return words.every((w) => allowed.has(w))
}

/** A person's name: 2-3 capitalised words, no lowercase connectives. */
const NAME_RE = /^[A-Z][\w'’.-]+(?:\s+[A-Z][\w'’.-]+){1,2}$/

/** A segment that is nothing but a cast list: "Tom Hardy, Idris Elba". */
function isCastList(segment: string): boolean {
  const parts = segment.split(',').map((p) => p.trim()).filter(Boolean)
  return parts.length >= 2 && parts.every((p) => NAME_RE.test(p))
}

/** Strip a trailing cast list: " - Jason Statham", ", Tom Hardy, Idris Elba". */
function dropCastTail(text: string): string {
  // A name is 2-3 capitalised words. Two or more in a row after a separator,
  // or one after a dash, is a cast credit rather than part of the title.
  const name = "[A-Z][\\w'’.-]+(?:\\s+[A-Z][\\w'’.-]+){1,2}"
  let out = text.replace(new RegExp(`\\s*[-–—|]\\s*${name}(?:\\s*,\\s*${name})*\\s*$`), '')
  out = out.replace(new RegExp(`\\s*,\\s*${name}(?:\\s*,\\s*${name})+\\s*$`), '')
  return out
}

/** Sentence-case a SHOUTED title, leaving mixed-case titles alone. */
function unshout(text: string): string {
  if (text !== text.toUpperCase()) return text
  return text
    .toLowerCase()
    .replace(/(^|[\s(\-:/])([a-z])/g, (_m, lead: string, ch: string) => lead + ch.toUpperCase())
}

export interface ParsedFilmTitle {
  title: string
  year?: number
  /** True when the result still looks like junk and deserves the LLM pass. */
  uncertain: boolean
}

export function parseFilmTitle(raw: string): ParsedFilmTitle {
  let text = (raw ?? '').replace(/\s+/g, ' ').trim()

  // The year, wherever it sits.
  let year: number | undefined
  const yearMatch = text.match(/(?:^|[^0-9])((?:19|20)\d{2})(?:[^0-9]|$)/)
  if (yearMatch) {
    year = Number(yearMatch[1])
    text = text.replace(yearMatch[1], ' ')
  }

  // Uploaders separate title from marketing with | / •; keep the segment
  // that isn't marketing, preferring the longest.
  const segments = text.split(/[|/•]/).map((s) => s.trim()).filter(Boolean)
  if (segments.length > 1) {
    // FIRST wins, not longest: uploaders put the film name ahead of the cast,
    // so "Free Full Movie | THE LAST STAND | Arnold Schwarzenegger" is The
    // Last Stand, even though the actor's name is the longer string.
    const candidates = segments.filter((s) => !isMarketing(s) && !isCastList(s))
    // Nothing but marketing and cast: leave it empty and let the model pass
    // read the original, rather than presenting an actor as the film.
    text = candidates[0] ?? ''
    if (!text) return { title: '', year, uncertain: true }
  }

  text = dropCastTail(text)
  for (const word of NOISE) {
    text = text.replace(new RegExp(`\\b${word.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'gi'), ' ')
  }
  // Leftover genre+movie wording once the segment is mixed in with the title.
  text = text.replace(new RegExp(`\\b(?:full|new|best|latest)?\\s*(?:${GENRES.join('|')})?\\s*(?:movie|film)\\b`, 'gi'), ' ')
  // Brackets left empty by the year removal: "RAMPAGE ( )".
  text = text.replace(/[([{]\s*[)\]}]/g, ' ')
  text = text.replace(/\s{2,}/g, ' ').replace(/^[\s\-–—|:,.]+|[\s\-–—|:,.]+$/g, '').trim()
  text = unshout(text)

  // Still generic, empty, or carrying multiple candidate names? Say so.
  const words = text.split(/\s+/).filter(Boolean)
  const uncertain =
    text.length < 2 ||
    words.length > 8 ||
    (text.match(/,/g) ?? []).length >= 1 ||
    NAME_RE.test(text) ||          // we may have kept an actor, not a film
    isMarketing(text)

  return { title: text, year, uncertain }
}

/** Normalised form for comparing two titles: no case, no punctuation, no
 *  leading article, no doubled spaces. */
function normalise(text: string): string {
  return text
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^(the|a|an)\s+/, '')
    .trim()
}

/**
 * Does a catalogue hit actually correspond to what we searched for?
 *
 * JustWatch fuzzy-matches, so a query it cannot place lands on whatever
 * shares a word: "No Rules, No Fear ..." came back as the film "Fear"
 * (Jesse, 2026-08-07). A wrong synopsis is worse than none, so a hit has to
 * earn it — most of the query's words have to be in the matched title.
 */
export function titleMatches(query: string, matched: string, opts: { queryYear?: number; matchedYear?: number | null } = {}): boolean {
  const a = normalise(query)
  const b = normalise(matched)
  if (!a || !b) return false
  if (a === b) return yearOk(opts)
  const at = new Set(a.split(' ').filter(Boolean))
  const bt = new Set(b.split(' ').filter(Boolean))
  // A one-word film answering a multi-word query is the classic false
  // positive; demand an exact match in that case.
  if (bt.size === 1 && at.size > 1) return false
  // A bare sequel number is not evidence: "Colombiana 2" and "Zootopia 2"
  // share the "2" and nothing else (Jesse, 2026-08-07). Count only real
  // words toward the overlap, but keep the numbers in the union so they
  // still cost a mismatch.
  let shared = 0
  for (const word of at) if (bt.has(word) && !/^\d+$/.test(word)) shared++
  const union = new Set([...at, ...bt]).size
  const jaccard = shared / union
  // Also allow a clean subtitle difference ("Rampage" vs "Rampage: Big
  // Meets Bigger"): the match must START with the whole query, so a shared
  // word in the middle never counts.
  const coversQuery = (shared === at.size && at.size >= 2) || b.startsWith(a + ' ')
  return (jaccard >= 0.6 || coversQuery) && yearOk(opts)
}

function yearOk({ queryYear, matchedYear }: { queryYear?: number; matchedYear?: number | null }): boolean {
  if (!queryYear || !matchedYear) return true
  // Upload years drift from release years; a couple of years is fine, a
  // decade is a different film.
  return Math.abs(queryYear - matchedYear) <= 2
}
