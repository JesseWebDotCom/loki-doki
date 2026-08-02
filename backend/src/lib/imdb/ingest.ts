// IMDb trivia ingest: streams four of IMDb's free non-commercial TSV datasets
// (title.ratings, title.basics, title.principals, name.basics) into the dedicated
// data/imdb.db file (the same file the episode-ratings heatmap import uses; kept
// out of app.db so household backups stay small). Filtering during the stream is
// aggressive so the low-hundreds-of-MB raw downloads shrink to tens of MB kept:
// titles must be a movie/tvSeries/tvMovie/tvMiniSeries with at least 1000 votes,
// principals keep only actor/actress/director rows for those titles, and names
// keep only people referenced by a kept principal row. The result powers the
// computable Pop-Up Facts in lib/youtube/imdbFacts.ts: precise director/co-star/
// rating trivia that needs no LLM writing quality. Admin-triggered via
// POST /api/youtube/admin/imdb/ingest, coalesced, rebuilt from scratch each run.
// Pure Bun/web APIs only (fetch + DecompressionStream), so it runs unchanged on
// the production Windows box.

import type { Database } from 'bun:sqlite'
import { imdbDb, streamTsv } from './datasets'
import { logger } from '@/lib/logger'

const RATINGS_URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz'
const BASICS_URL = 'https://datasets.imdbws.com/title.basics.tsv.gz'
const PRINCIPALS_URL = 'https://datasets.imdbws.com/title.principals.tsv.gz'
const NAMES_URL = 'https://datasets.imdbws.com/name.basics.tsv.gz'

const KEPT_TYPES = new Set(['movie', 'tvSeries', 'tvMovie', 'tvMiniSeries'])
const KEPT_CATEGORIES = new Set(['actor', 'actress', 'director'])
const MIN_VOTES = 1000
const BATCH = 5000
const LOG_EVERY = 100_000
const LAST_INGEST_KEY = 'trivia_last_ingest'

let tablesEnsured = false

/** imdb.db handle with the trivia tables guaranteed to exist. */
export function triviaDb(): Database {
  const d = imdbDb()
  if (!tablesEnsured) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS imdb_titles (
        tconst TEXT NOT NULL PRIMARY KEY,
        type TEXT NOT NULL,
        primary_title TEXT NOT NULL,
        start_year INTEGER,
        genres TEXT,
        rating REAL,
        votes INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_imdb_titles_title ON imdb_titles(primary_title COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS imdb_names (
        nconst TEXT NOT NULL PRIMARY KEY,
        primary_name TEXT NOT NULL,
        birth_year INTEGER,
        known_for TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_imdb_names_name ON imdb_names(primary_name COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS imdb_principals (
        tconst TEXT NOT NULL,
        nconst TEXT NOT NULL,
        category TEXT NOT NULL,
        ordering INTEGER NOT NULL DEFAULT 0,
        character TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_imdb_principals_tconst ON imdb_principals(tconst);
      CREATE INDEX IF NOT EXISTS idx_imdb_principals_nconst ON imdb_principals(nconst);
    `)
    tablesEnsured = true
  }
  return d
}

let readyCache = false

/** True once a full ingest has completed and the tables actually hold rows. */
export function triviaReady(): boolean {
  if (readyCache) return true
  try {
    const d = triviaDb()
    const meta = d.query<{ value: string }, []>(`SELECT value FROM meta WHERE key = '${LAST_INGEST_KEY}'`).get()
    if (!meta) return false
    const row = d.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM imdb_titles').get()
    readyCache = (row?.n ?? 0) > 0
    return readyCache
  } catch {
    return false
  }
}

// ── Ingest state (surfaced by the admin status route) ───────────────────────────

let running = false
let phase: string | null = null
let phaseLines = 0
let lastError: string | null = null

export interface TriviaIngestStatus {
  running: boolean
  phase: string | null
  phaseLines: number
  error: string | null
  lastIngestAt: number | null
  counts: { titles: number; names: number; principals: number }
}

export function triviaIngestStatus(): TriviaIngestStatus {
  let lastIngestAt: number | null = null
  const counts = { titles: 0, names: 0, principals: 0 }
  try {
    const d = triviaDb()
    const meta = d.query<{ value: string }, []>(`SELECT value FROM meta WHERE key = '${LAST_INGEST_KEY}'`).get()
    lastIngestAt = meta ? Number(meta.value) || null : null
    counts.titles = d.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM imdb_titles').get()?.n ?? 0
    counts.names = d.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM imdb_names').get()?.n ?? 0
    counts.principals = d.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM imdb_principals').get()?.n ?? 0
  } catch { /* counts stay zero when the db is unreadable */ }
  return { running, phase, phaseLines, error: lastError, lastIngestAt, counts }
}

/** Kick a background ingest. Coalesced: returns false when one is already running. */
export function kickTriviaIngest(): boolean {
  if (running) return false
  running = true
  phase = 'starting'
  phaseLines = 0
  lastError = null
  void runIngest()
    .then(() => {
      const s = triviaIngestStatus()
      logger.info({ counts: s.counts }, 'imdb trivia ingest: complete')
    })
    .catch((err) => {
      lastError = err instanceof Error ? err.message : String(err)
      logger.warn({ err }, 'imdb trivia ingest: failed')
    })
    .finally(() => {
      running = false
      phase = null
    })
  return true
}

function startPhase(name: string): void {
  phase = name
  phaseLines = 0
  logger.info({ phase: name }, 'imdb trivia ingest: phase start')
}

function countLine(): void {
  if (++phaseLines % LOG_EVERY === 0) logger.info({ phase, lines: phaseLines }, 'imdb trivia ingest: progress')
}

/** Commit every BATCH inserts so the write transaction never grows unbounded. */
function makeBatcher(d: Database) {
  let pending = 0
  d.exec('BEGIN')
  return {
    tick() {
      if (++pending >= BATCH) {
        pending = 0
        d.exec('COMMIT')
        d.exec('BEGIN')
      }
    },
    done() {
      d.exec('COMMIT')
    },
  }
}

const nul = (v: string | undefined): string | null => (v == null || v === '\\N' || v === '' ? null : v)
const nulInt = (v: string | undefined): number | null => {
  const s = nul(v)
  if (s == null) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

async function runIngest(): Promise<void> {
  const d = triviaDb()
  // Drop the ready flag first: a half-rebuilt dataset must never serve facts.
  d.prepare(`DELETE FROM meta WHERE key = ?`).run(LAST_INGEST_KEY)
  readyCache = false

  try {
    // Phase 1: ratings into memory, filtered to the vote floor. Roughly 1.6M rows
    // stream by, a few hundred thousand entries are kept.
    startPhase('ratings')
    const ratings = new Map<string, { rating: number; votes: number }>()
    await streamTsv(RATINGS_URL, (cols) => {
      countLine()
      const votes = Number(cols[2])
      const rating = Number(cols[1])
      if (cols[0] && votes >= MIN_VOTES && rating > 0) ratings.set(cols[0], { rating, votes })
    })

    // Phase 2: title.basics joined against the ratings map, kept types only.
    startPhase('titles')
    const keptTitles = new Set<string>()
    {
      const batch = makeBatcher(d)
      d.exec('DELETE FROM imdb_titles')
      const ins = d.prepare(
        'INSERT OR REPLACE INTO imdb_titles (tconst, type, primary_title, start_year, genres, rating, votes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      await streamTsv(BASICS_URL, (cols) => {
        countLine()
        const [tconst, titleType, primaryTitle, , isAdult, startYear, , , genres] = cols
        if (!tconst || !primaryTitle || !titleType || !KEPT_TYPES.has(titleType)) return
        if (isAdult === '1') return
        const r = ratings.get(tconst)
        if (!r) return
        ins.run(tconst, titleType, primaryTitle, nulInt(startYear), nul(genres), r.rating, r.votes)
        keptTitles.add(tconst)
        batch.tick()
      })
      batch.done()
    }
    ratings.clear()

    // Phase 3: principals for kept titles, cast and directors only. This is the
    // big file (tens of millions of rows); nearly all are filtered out.
    startPhase('principals')
    const neededNames = new Set<string>()
    {
      const batch = makeBatcher(d)
      d.exec('DELETE FROM imdb_principals')
      const ins = d.prepare(
        'INSERT INTO imdb_principals (tconst, nconst, category, ordering, character) VALUES (?, ?, ?, ?, ?)',
      )
      await streamTsv(PRINCIPALS_URL, (cols) => {
        countLine()
        const [tconst, ordering, nconst, category, , characters] = cols
        if (!tconst || !nconst || !category || !KEPT_CATEGORIES.has(category)) return
        if (!keptTitles.has(tconst)) return
        ins.run(tconst, nconst, category, Number(ordering) || 0, nul(characters))
        neededNames.add(nconst)
        batch.tick()
      })
      batch.done()
    }

    // Phase 4: names referenced by a kept principal row.
    startPhase('names')
    {
      const batch = makeBatcher(d)
      d.exec('DELETE FROM imdb_names')
      const ins = d.prepare(
        'INSERT OR REPLACE INTO imdb_names (nconst, primary_name, birth_year, known_for) VALUES (?, ?, ?, ?)',
      )
      await streamTsv(NAMES_URL, (cols) => {
        countLine()
        const [nconst, primaryName, birthYear, , , knownFor] = cols
        if (!nconst || !primaryName || !neededNames.has(nconst)) return
        ins.run(nconst, primaryName, nulInt(birthYear), nul(knownFor))
        batch.tick()
      })
      batch.done()
    }

    d.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(LAST_INGEST_KEY, String(Date.now()))
  } catch (err) {
    try { d.exec('ROLLBACK') } catch { /* no open transaction */ }
    throw err
  }
}
