// IMDb non-commercial datasets (datasets.imdbws.com) — the per-episode ratings behind the
// show-page heatmap. Two daily TSVs (title.ratings ~8.6MB gz, title.episode ~54MB gz) are
// streamed into a DEDICATED sqlite file (data/imdb.db, not app.db — ~200MB of rows that
// don't belong in app backups), denormalized to one episodes table so queries are a single
// indexed lookup. Refreshed at most weekly, imported lazily on first heatmap request.
// License: IMDb's datasets are free for personal, non-commercial use with attribution —
// which this self-hosted household app satisfies. Do not re-expose the data publicly.

import { Database } from 'bun:sqlite'
import { dirname, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

const DB_PATH = process.env.IMDB_DB_PATH ?? resolve(import.meta.dir, '../../../../data/imdb.db')
const REFRESH_MS = 7 * 24 * 60 * 60 * 1000
const RATINGS_URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz'
const EPISODES_URL = 'https://datasets.imdbws.com/title.episode.tsv.gz'

export interface EpisodeRating {
  season: number
  episode: number
  rating: number
  votes: number
}

let dbInstance: Database | null = null
function db(): Database {
  if (!dbInstance) {
    mkdirSync(dirname(DB_PATH), { recursive: true })
    dbInstance = new Database(DB_PATH)
    dbInstance.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS episodes (
        parent TEXT NOT NULL,
        season INTEGER NOT NULL,
        episode INTEGER NOT NULL,
        rating REAL NOT NULL,
        votes INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_episodes_parent ON episodes(parent);
      CREATE TABLE IF NOT EXISTS title_ratings (tconst TEXT PRIMARY KEY, rating REAL NOT NULL, votes INTEGER NOT NULL);
    `)
  }
  return dbInstance
}

function lastImportAt(): number {
  const row = db().query<{ value: string }, []>(`SELECT value FROM meta WHERE key = 'last_import'`).get()
  return row ? Number(row.value) || 0 : 0
}

export function datasetsReady(): boolean {
  return lastImportAt() > 0
}

function datasetsFresh(): boolean {
  return Date.now() - lastImportAt() < REFRESH_MS
}

/** Stream a gzipped TSV and invoke cb per data line (header skipped). */
async function streamTsv(url: string, cb: (cols: string[]) => void): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) })
  if (!res.ok || !res.body) throw new Error(`Download failed: ${url} (${res.status})`)
  const lines = res.body.pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream())
  let buf = ''
  let first = true
  const reader = lines.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += value
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (first) { first = false; continue }
      if (line) cb(line.split('\t'))
    }
  }
  if (buf && !first) cb(buf.split('\t'))
}

let importPromise: Promise<void> | null = null

/** Import/refresh both datasets. Ratings first (into memory), then episodes joined against
 *  them so only rated episodes are stored (~4M rows instead of ~9M). Takes a few minutes on
 *  first run; concurrent callers share one import. */
export function ensureImdbDatasets(): Promise<void> {
  if (datasetsFresh()) return Promise.resolve()
  if (importPromise) return importPromise
  importPromise = (async () => {
    const d = db()
    // 1. Ratings → in-memory map (~1.6M entries) + title_ratings table (movie fallback).
    const ratings = new Map<string, { rating: number; votes: number }>()
    await streamTsv(RATINGS_URL, (cols) => {
      const [tconst, avg, votes] = cols
      const r = Number(avg), v = Number(votes)
      if (tconst && r > 0 && v > 0) ratings.set(tconst, { rating: r, votes: v })
    })

    d.exec('BEGIN')
    try {
      d.exec('DELETE FROM title_ratings')
      const insR = d.prepare('INSERT OR REPLACE INTO title_ratings (tconst, rating, votes) VALUES (?, ?, ?)')
      for (const [tconst, { rating, votes }] of ratings) insR.run(tconst, rating, votes)
      d.exec('COMMIT')
    } catch (e) { d.exec('ROLLBACK'); throw e }

    // 2. Episodes joined to ratings, denormalized.
    d.exec('BEGIN')
    try {
      d.exec('DELETE FROM episodes')
      const insE = d.prepare('INSERT INTO episodes (parent, season, episode, rating, votes) VALUES (?, ?, ?, ?, ?)')
      await streamTsv(EPISODES_URL, (cols) => {
        const [tconst, parent, seasonRaw, episodeRaw] = cols
        if (!tconst || !parent) return
        const rated = ratings.get(tconst)
        if (!rated) return
        const season = Number(seasonRaw), episode = Number(episodeRaw)
        if (!Number.isInteger(season) || !Number.isInteger(episode) || season <= 0 || episode <= 0) return
        insE.run(parent, season, episode, rated.rating, rated.votes)
      })
      d.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('last_import', ?)`).run(String(Date.now()))
      d.exec('COMMIT')
    } catch (e) { d.exec('ROLLBACK'); throw e }
  })().finally(() => { importPromise = null })
  return importPromise
}

/** Per-episode IMDb ratings for a show (by its tt… id), season/episode ascending. */
export function episodeRatings(parentTconst: string): EpisodeRating[] {
  return db()
    .query<EpisodeRating, [string]>(
      'SELECT season, episode, rating, votes FROM episodes WHERE parent = ? ORDER BY season, episode',
    )
    .all(parentTconst)
}

/** IMDb rating for any title id (movie fallback when JustWatch has no score). */
export function titleRating(tconst: string): { rating: number; votes: number } | null {
  return db().query<{ rating: number; votes: number }, [string]>('SELECT rating, votes FROM title_ratings WHERE tconst = ?').get(tconst)
}
