// "Made For You" taste rails + the Replay recap, computed from music_history with plain
// SQL - no ML required (the Discovery/embedding rails arrive with workstream D and slot
// in beside these). Rails are per-user, advisory-filtered, cached in-memory for 6h, and
// a rail that can't fill ~8 tracks is omitted rather than padded with junk.

import { db, sqlite } from '@/db'
import { filterTracksForUser } from '@/lib/music/advisory'
import { logger } from '@/lib/logger'

export interface RailTrack { videoId: string; title: string; artist: string }
export interface Rail { key: string; title: string; subtitle: string; tracks: RailTrack[] }

const DAY = 86_400   // seconds - played_at is stored in unix SECONDS (drizzle timestamp mode)
const MIN_RAIL = 8

// ── Raw history queries (prepared each call - SQLite compiles these cheaply) ─────────

interface Row { video_id: string; title: string; artist: string | null; plays: number; last_ms?: number }

function topTracks(userId: string, sinceMs: number, untilMs: number, limit: number): Row[] {
  return sqlite.prepare(`
    SELECT video_id, MAX(title) AS title, MAX(artist) AS artist,
           COUNT(*) AS plays, MAX(played_at) AS last_ms
    FROM music_history
    WHERE user_id = ? AND played_at >= ? AND played_at < ?
    GROUP BY video_id
    ORDER BY plays DESC, last_ms DESC
    LIMIT ?
  `).all(userId, sinceMs, untilMs, limit) as Row[]
}

function lateNightTracks(userId: string, sinceMs: number, limit: number): Row[] {
  // 22:00-04:00 in SERVER-local time (the household's clock).
  return sqlite.prepare(`
    SELECT video_id, MAX(title) AS title, MAX(artist) AS artist, COUNT(*) AS plays
    FROM music_history
    WHERE user_id = ? AND played_at >= ?
      AND CAST(strftime('%H', played_at, 'unixepoch', 'localtime') AS INTEGER) IN (22, 23, 0, 1, 2, 3)
    GROUP BY video_id
    ORDER BY plays DESC
    LIMIT ?
  `).all(userId, sinceMs, limit) as Row[]
}

function recentPlayCounts(userId: string, sinceMs: number): Map<string, number> {
  const rows = sqlite.prepare(`
    SELECT video_id, COUNT(*) AS plays FROM music_history
    WHERE user_id = ? AND played_at >= ? GROUP BY video_id
  `).all(userId, sinceMs) as Array<{ video_id: string; plays: number }>
  return new Map(rows.map(r => [r.video_id, r.plays]))
}

const toTracks = (rows: Row[]): RailTrack[] =>
  rows.filter(r => r.video_id && r.title).map(r => ({ videoId: r.video_id, title: r.title, artist: r.artist ?? '' }))

// Deterministic per-day shuffle so Daily Mixes rotate daily but stay stable within a day.
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr]
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 48271) + 11) % 2147483647
    const j = Math.abs(s) % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

// ── Rails ─────────────────────────────────────────────────────────────────────────────

async function computeRails(userId: string): Promise<Rail[]> {
  const now = Math.floor(Date.now() / 1000)
  const rails: Rail[] = []

  // On Repeat: heavy rotation in the last 14 days (≥3 plays), most-played first.
  const onRepeat = toTracks(topTracks(userId, now - 14 * DAY, now + DAY, 40).filter(r => r.plays >= 3))
  if (onRepeat.length >= MIN_RAIL) {
    rails.push({ key: 'on-repeat', title: 'On Repeat', subtitle: 'Your heavy rotation right now', tracks: onRepeat.slice(0, 24) })
  }

  // Throwbacks: big 6-24 months ago, quiet lately.
  const recent90 = recentPlayCounts(userId, now - 90 * DAY)
  const throwbacks = toTracks(
    topTracks(userId, now - 730 * DAY, now - 180 * DAY, 80)
      .filter(r => r.plays >= 2 && (recent90.get(r.video_id) ?? 0) <= 1),
  )
  if (throwbacks.length >= MIN_RAIL) {
    rails.push({ key: 'throwbacks', title: 'Throwbacks', subtitle: 'Songs you loved, due for a comeback', tracks: throwbacks.slice(0, 24) })
  }

  // Late Night: what this listener reaches for after 10pm.
  const lateNight = toTracks(lateNightTracks(userId, now - 180 * DAY, 40))
  if (lateNight.length >= 12) {
    rails.push({ key: 'late-night', title: 'Late Night', subtitle: 'Your after-hours soundtrack', tracks: lateNight.slice(0, 24) })
  }

  // Daily Mix 1-3: the last 6 months' favorites, spread across three mixes by artist
  // round-robin (no mix becomes one artist's greatest hits), reshuffled daily.
  const pool = topTracks(userId, now - 180 * DAY, now + DAY, 120)
  if (pool.length >= MIN_RAIL * 2) {
    const daySeed = Math.floor(now / DAY)   // (both in seconds)
    const byArtist = new Map<string, Row[]>()
    for (const r of seededShuffle(pool, daySeed)) {
      const k = (r.artist ?? '?').toLowerCase()
      if (!byArtist.has(k)) byArtist.set(k, [])
      byArtist.get(k)!.push(r)
    }
    const mixes: Row[][] = [[], [], []]
    let i = 0
    for (const tracks of byArtist.values()) {
      for (const t of tracks) { mixes[i % 3]!.push(t); i++ }
    }
    const mixCount = pool.length >= MIN_RAIL * 3 ? 3 : 2
    for (let m = 0; m < mixCount; m++) {
      const tracks = toTracks(seededShuffle(mixes[m]!, daySeed + m))
      if (tracks.length >= MIN_RAIL) {
        rails.push({ key: `daily-mix-${m + 1}`, title: `Daily Mix ${m + 1}`, subtitle: 'Fresh spins on your favorites', tracks: tracks.slice(0, 24) })
      }
    }
  }

  // Content protections apply to rails like everywhere else.
  for (const rail of rails) {
    rail.tracks = await filterTracksForUser(userId, rail.tracks)
  }
  return rails.filter(r => r.tracks.length >= MIN_RAIL)
}

// 6h per-user cache: rails move slowly and the queries touch the whole history table.
const railsCache = new Map<string, { at: number; rails: Rail[] }>()
const RAILS_TTL = 6 * 60 * 60 * 1000

export async function buildRails(userId: string): Promise<Rail[]> {
  const hit = railsCache.get(userId)
  if (hit && Date.now() - hit.at < RAILS_TTL) return hit.rails
  try {
    const rails = await computeRails(userId)
    railsCache.set(userId, { at: Date.now(), rails })
    return rails
  } catch (err) {
    logger.debug(`[rails] build failed for ${userId}: ${String(err)}`)
    return hit?.rails ?? []
  }
}

// ── Replay (year recap) ───────────────────────────────────────────────────────────────

export interface Replay {
  year: number
  totalPlays: number
  totalMinutes: number
  topSongs: Array<RailTrack & { plays: number }>
  topArtists: Array<{ artist: string; plays: number }>
  topStations: Array<{ stationId: string; plays: number }>
  clock: number[]          // plays per hour-of-day, 24 buckets
  firstPlay: { title: string; artist: string; atMs: number } | null
}

export function buildReplay(userId: string, year: number): Replay {
  const from = Math.floor(new Date(year, 0, 1).getTime() / 1000)
  const to = Math.floor(new Date(year + 1, 0, 1).getTime() / 1000)

  const [totals] = sqlite.prepare(`
    SELECT COUNT(*) AS plays,
           SUM(CASE WHEN position_sec > 0 THEN MIN(position_sec, COALESCE(duration_sec, position_sec))
                    ELSE COALESCE(duration_sec, 210) END) AS listened
    FROM music_history WHERE user_id = ? AND played_at >= ? AND played_at < ?
  `).all(userId, from, to) as Array<{ plays: number; listened: number | null }>

  const topSongs = (topTracks(userId, from, to, 10)).map(r => ({
    videoId: r.video_id, title: r.title, artist: r.artist ?? '', plays: r.plays,
  }))

  const topArtists = sqlite.prepare(`
    SELECT artist, COUNT(*) AS plays FROM music_history
    WHERE user_id = ? AND played_at >= ? AND played_at < ? AND artist IS NOT NULL AND artist != ''
    GROUP BY LOWER(artist) ORDER BY plays DESC LIMIT 10
  `).all(userId, from, to) as Array<{ artist: string; plays: number }>

  const topStations = sqlite.prepare(`
    SELECT station_id AS stationId, COUNT(*) AS plays FROM music_history
    WHERE user_id = ? AND played_at >= ? AND played_at < ? AND station_id IS NOT NULL
    GROUP BY station_id ORDER BY plays DESC LIMIT 6
  `).all(userId, from, to) as Array<{ stationId: string; plays: number }>

  const clockRows = sqlite.prepare(`
    SELECT CAST(strftime('%H', played_at, 'unixepoch', 'localtime') AS INTEGER) AS hour, COUNT(*) AS plays
    FROM music_history WHERE user_id = ? AND played_at >= ? AND played_at < ?
    GROUP BY hour
  `).all(userId, from, to) as Array<{ hour: number; plays: number }>
  const clock = Array(24).fill(0) as number[]
  for (const r of clockRows) clock[r.hour] = r.plays

  const [first] = sqlite.prepare(`
    SELECT title, artist, played_at AS atMs FROM music_history
    WHERE user_id = ? AND played_at >= ? AND played_at < ?
    ORDER BY played_at ASC LIMIT 1
  `).all(userId, from, to) as Array<{ title: string; artist: string | null; atMs: number }>

  return {
    year,
    totalPlays: totals?.plays ?? 0,
    totalMinutes: Math.round((totals?.listened ?? 0) / 60),
    topSongs,
    topArtists,
    topStations,
    clock,
    firstPlay: first ? { title: first.title, artist: first.artist ?? '', atMs: first.atMs * 1000 } : null,
  }
}
