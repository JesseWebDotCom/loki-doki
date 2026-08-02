// Computable Pop-Up Facts from the locally ingested IMDb datasets (lib/imdb/ingest.ts).
// The local LLM's written trivia mostly fails the strict quality gates in popupFacts.ts,
// so density comes from facts that are correct by construction: director connections,
// co-star reunions, rating superlatives, a person's highest-rated credit. Every template
// emits a complete 15-30 word sentence; anything outside that window is dropped. Lookups
// are precision-first: case-insensitive exact match, then prefix, preferring higher vote
// counts, and an entity with multiple strong same-name candidates yields nothing at all.
// When the datasets were never ingested this module silently returns [].

import type { Database } from 'bun:sqlite'
import { triviaDb, triviaReady } from '@/lib/imdb/ingest'

export type ImdbEntityKind = 'person' | 'movie' | 'show'

interface TitleRow {
  tconst: string
  type: string
  primaryTitle: string
  startYear: number | null
  rating: number | null
  votes: number
}

interface PersonRow {
  nconst: string
  primaryName: string
  knownFor: string | null
  totalVotes: number
}

const TITLE_COLS =
  't.tconst AS tconst, t.type AS type, t.primary_title AS primaryTitle, t.start_year AS startYear, t.rating AS rating, t.votes AS votes'

// A connected title must itself be somewhat known, or the fact reads like noise.
const MIN_FACT_VOTES = 5000

const wordCount = (s: string): number => s.trim().split(/\s+/).length

/** Enforce the complete-sentence 15-30 word contract; null drops the fact. */
function keep(text: string): string | null {
  const n = wordCount(text)
  return n >= 15 && n <= 30 ? text : null
}

function fmtRating(r: number | null): string {
  return (r ?? 0).toFixed(1)
}

function fmtVotes(v: number): string {
  if (v >= 1_000_000) return `over ${(Math.floor(v / 100_000) / 10).toFixed(1)} million`
  if (v >= 1000) return `over ${(Math.floor(v / 1000) * 1000).toLocaleString('en-US')}`
  return String(v)
}

function yearSuffix(t: TitleRow): string {
  return t.startYear != null ? ` (${t.startYear})` : ''
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (ch) => '\\' + ch)

/** Exact (NOCASE) then prefix title lookup, preferring votes. Null when ambiguous:
 *  a second candidate with similar votes and a different year means we cannot tell
 *  which one the video is about, and a wrong fact is worse than none. */
function lookupTitle(d: Database, name: string, kind: 'movie' | 'show'): TitleRow | null {
  const types: [string, string] = kind === 'movie' ? ['movie', 'tvMovie'] : ['tvSeries', 'tvMiniSeries']
  let rows = d
    .query<TitleRow, [string, string, string]>(
      `SELECT ${TITLE_COLS} FROM imdb_titles t WHERE t.primary_title = ? COLLATE NOCASE AND t.type IN (?, ?) ORDER BY t.votes DESC LIMIT 4`,
    )
    .all(name, types[0], types[1])
  if (!rows.length) {
    rows = d
      .query<TitleRow, [string, string, string]>(
        `SELECT ${TITLE_COLS} FROM imdb_titles t WHERE t.primary_title LIKE ? ESCAPE '\\' AND t.type IN (?, ?) ORDER BY t.votes DESC LIMIT 4`,
      )
      .all(escapeLike(name) + '%', types[0], types[1])
  }
  const [a, b] = rows
  if (!a) return null
  if (b && b.votes * 3 >= a.votes && b.startYear !== a.startYear) return null
  return a
}

/** Person lookup with the sum of their kept titles' votes as the notability proxy. */
function lookupPerson(d: Database, name: string): PersonRow | null {
  const select =
    `SELECT n.nconst AS nconst, n.primary_name AS primaryName, n.known_for AS knownFor,
       COALESCE((SELECT SUM(t.votes) FROM imdb_principals p JOIN imdb_titles t ON t.tconst = p.tconst WHERE p.nconst = n.nconst), 0) AS totalVotes
     FROM imdb_names n`
  let rows = d
    .query<PersonRow, [string]>(`${select} WHERE n.primary_name = ? COLLATE NOCASE ORDER BY totalVotes DESC LIMIT 4`)
    .all(name)
  if (!rows.length) {
    rows = d
      .query<PersonRow, [string]>(`${select} WHERE n.primary_name LIKE ? ESCAPE '\\' ORDER BY totalVotes DESC LIMIT 4`)
      .all(escapeLike(name) + '%')
  }
  const [a, b] = rows
  if (!a || a.totalVotes < MIN_FACT_VOTES) return null
  if (b && b.totalVotes * 3 >= a.totalVotes) return null
  return a
}

function titleByTconst(d: Database, tconst: string): TitleRow | null {
  return d.query<TitleRow, [string]>(`SELECT ${TITLE_COLS} FROM imdb_titles t WHERE t.tconst = ?`).get(tconst)
}

// ── Title templates ─────────────────────────────────────────────────────────────

function directorFact(d: Database, t: TitleRow): string | null {
  const directors = d
    .query<{ nconst: string; name: string }, [string]>(
      `SELECT p.nconst AS nconst, n.primary_name AS name FROM imdb_principals p
       JOIN imdb_names n ON n.nconst = p.nconst
       WHERE p.tconst = ? AND p.category = 'director' ORDER BY p.ordering LIMIT 2`,
    )
    .all(t.tconst)
  for (const dir of directors) {
    const other = d
      .query<TitleRow, [string, string, number]>(
        `SELECT ${TITLE_COLS} FROM imdb_principals p JOIN imdb_titles t ON t.tconst = p.tconst
         WHERE p.nconst = ? AND p.category = 'director' AND t.tconst <> ? AND t.votes >= ? AND t.start_year IS NOT NULL AND t.rating IS NOT NULL
         ORDER BY t.votes DESC LIMIT 1`,
      )
      .get(dir.nconst, t.tconst, MIN_FACT_VOTES)
    if (!other) continue
    const fact = keep(
      `Director ${dir.name}, who made ${t.primaryTitle}${yearSuffix(t)}, also directed ${other.primaryTitle} (${other.startYear}), rated ${fmtRating(other.rating)} by ${fmtVotes(other.votes)} IMDb voters.`,
    )
    if (fact) return fact
  }
  return null
}

function costarFact(d: Database, t: TitleRow): string | null {
  const cast = d
    .query<{ nconst: string; name: string }, [string]>(
      `SELECT p.nconst AS nconst, n.primary_name AS name FROM imdb_principals p
       JOIN imdb_names n ON n.nconst = p.nconst
       WHERE p.tconst = ? AND p.category IN ('actor', 'actress') ORDER BY p.ordering LIMIT 3`,
    )
    .all(t.tconst)
  for (let i = 0; i < cast.length; i++) {
    for (let j = i + 1; j < cast.length; j++) {
      const shared = d
        .query<TitleRow, [string, string, string, number]>(
          `SELECT ${TITLE_COLS} FROM imdb_principals a
           JOIN imdb_principals b ON b.tconst = a.tconst AND b.nconst = ? AND b.category IN ('actor', 'actress')
           JOIN imdb_titles t ON t.tconst = a.tconst
           WHERE a.nconst = ? AND a.category IN ('actor', 'actress') AND a.tconst <> ? AND t.votes >= ? AND t.start_year IS NOT NULL AND t.rating IS NOT NULL
           ORDER BY t.votes DESC LIMIT 1`,
        )
        .get(cast[j]!.nconst, cast[i]!.nconst, t.tconst, MIN_FACT_VOTES)
      if (!shared) continue
      const fact = keep(
        `${cast[i]!.name} and ${cast[j]!.name}, both in ${t.primaryTitle}, also appeared together in ${shared.primaryTitle} (${shared.startYear}), rated ${fmtRating(shared.rating)} on IMDb.`,
      )
      if (fact) return fact
    }
  }
  return null
}

function ratingFact(t: TitleRow, kind: 'movie' | 'show'): string | null {
  if (t.rating == null || t.votes < 50_000) return null
  if (t.rating < 8.5 && t.rating > 3.0) return null
  const side = t.rating >= 8.5 ? 'highest' : 'lowest'
  const kindWord = kind === 'movie' ? 'movies' : 'shows'
  return keep(
    `With a ${fmtRating(t.rating)} rating from ${fmtVotes(t.votes)} IMDb voters, ${t.primaryTitle}${yearSuffix(t)} stands among the ${side}-rated ${kindWord} on the site.`,
  )
}

// ── Person templates ────────────────────────────────────────────────────────────

function bestCredit(d: Database, nconst: string): TitleRow | null {
  return d
    .query<TitleRow, [string, number]>(
      `SELECT ${TITLE_COLS} FROM imdb_principals p JOIN imdb_titles t ON t.tconst = p.tconst
       WHERE p.nconst = ? AND t.votes >= ? AND t.rating IS NOT NULL AND t.start_year IS NOT NULL
       ORDER BY t.rating DESC, t.votes DESC LIMIT 1`,
    )
    .get(nconst, MIN_FACT_VOTES)
}

function highestRatedFact(p: PersonRow, best: TitleRow): string | null {
  return keep(
    `${p.primaryName}'s highest-rated IMDb credit is ${best.primaryTitle} (${best.startYear}), which holds a ${fmtRating(best.rating)} rating from ${fmtVotes(best.votes)} voters.`,
  )
}

function earliestKnownForFact(d: Database, p: PersonRow, exclude: string | null): string | null {
  if (!p.knownFor) return null
  const ids = p.knownFor.split(',').filter((id) => /^tt\d+$/.test(id)).slice(0, 8)
  let earliest: TitleRow | null = null
  for (const id of ids) {
    if (id === exclude) continue
    const row = titleByTconst(d, id)
    if (!row || row.startYear == null || row.rating == null) continue
    if (!earliest || row.startYear < earliest.startYear!) earliest = row
  }
  if (!earliest) return null
  return keep(
    `Among ${p.primaryName}'s best-known IMDb titles, the earliest is ${earliest.primaryTitle} (${earliest.startYear}), rated ${fmtRating(earliest.rating)} by ${fmtVotes(earliest.votes)} voters.`,
  )
}

// ── Public API ──────────────────────────────────────────────────────────────────

/** Up to 2 computable facts for an entity, or [] when the datasets are missing,
 *  the lookup is ambiguous, or no template produces a well-formed sentence. */
export function computeImdbFacts(name: string, kind: ImdbEntityKind): string[] {
  try {
    if (!triviaReady()) return []
    const trimmed = name.trim()
    if (trimmed.length < 2 || trimmed.length > 80) return []
    const d = triviaDb()
    const out: string[] = []
    if (kind === 'person') {
      const p = lookupPerson(d, trimmed)
      if (!p) return []
      const best = bestCredit(d, p.nconst)
      if (best) {
        const f = highestRatedFact(p, best)
        if (f) out.push(f)
      }
      const f2 = earliestKnownForFact(d, p, best?.tconst ?? null)
      if (f2) out.push(f2)
    } else {
      const t = lookupTitle(d, trimmed, kind)
      if (!t) return []
      for (const f of [directorFact(d, t), costarFact(d, t), ratingFact(t, kind)]) {
        if (f) out.push(f)
        if (out.length >= 2) break
      }
    }
    return out.slice(0, 2)
  } catch {
    return []
  }
}
