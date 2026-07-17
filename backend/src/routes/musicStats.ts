// All-time listening stats explorer over the full music_history table. Pure SQL
// aggregation (same listened-seconds formula as the Replay recap in lib/music/rails.ts:
// progress-beacon position when present, else known duration, else a 3.5min estimate).

import { Hono } from 'hono'
import { sqlite } from '@/db'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'

export const musicStats = new Hono<AppEnv>()
musicStats.use('*', requireAuth)

const LISTENED_SQL = `SUM(CASE WHEN position_sec > 0 THEN MIN(position_sec, COALESCE(duration_sec, position_sec))
                               ELSE COALESCE(duration_sec, 210) END)`

function yearRange(year: number): [number, number] {
  return [
    Math.floor(new Date(year, 0, 1).getTime() / 1000),
    Math.floor(new Date(year + 1, 0, 1).getTime() / 1000),
  ]
}

// GET /api/music/stats/overview?year=2026 — totals, per-year, and the chosen year's months.
musicStats.get('/overview', (c) => {
  const userId = c.get('user').id
  const yearRaw = c.req.query('year')
  const year = yearRaw && /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : new Date().getFullYear()

  const [totals] = sqlite.prepare(`
    SELECT COUNT(*) AS plays, ${LISTENED_SQL} AS listened,
           COUNT(DISTINCT video_id) AS tracks,
           COUNT(DISTINCT LOWER(COALESCE(artist, ''))) AS artists,
           MIN(played_at) AS firstAt
    FROM music_history WHERE user_id = ?
  `).all(userId) as Array<{ plays: number; listened: number | null; tracks: number; artists: number; firstAt: number | null }>

  const years = sqlite.prepare(`
    SELECT CAST(strftime('%Y', played_at, 'unixepoch', 'localtime') AS INTEGER) AS year,
           COUNT(*) AS plays, ${LISTENED_SQL} AS listened
    FROM music_history WHERE user_id = ?
    GROUP BY year ORDER BY year ASC
  `).all(userId) as Array<{ year: number; plays: number; listened: number | null }>

  const [from, to] = yearRange(year)
  const monthRows = sqlite.prepare(`
    SELECT CAST(strftime('%m', played_at, 'unixepoch', 'localtime') AS INTEGER) AS month,
           COUNT(*) AS plays, ${LISTENED_SQL} AS listened
    FROM music_history WHERE user_id = ? AND played_at >= ? AND played_at < ?
    GROUP BY month
  `).all(userId, from, to) as Array<{ month: number; plays: number; listened: number | null }>
  const months = Array.from({ length: 12 }, (_, i) => {
    const row = monthRows.find(r => r.month === i + 1)
    return { month: i + 1, plays: row?.plays ?? 0, minutes: Math.round((row?.listened ?? 0) / 60) }
  })

  return c.json({
    totals: {
      plays: totals?.plays ?? 0,
      minutes: Math.round((totals?.listened ?? 0) / 60),
      distinctTracks: totals?.tracks ?? 0,
      distinctArtists: Math.max(0, (totals?.artists ?? 0) - 1),  // the '' bucket
      firstPlayAtMs: totals?.firstAt ? totals.firstAt * 1000 : null,
    },
    years: years.map(y => ({ year: y.year, plays: y.plays, minutes: Math.round((y.listened ?? 0) / 60) })),
    monthsYear: year,
    months,
  })
})

// GET /api/music/stats/top?kind=artists|tracks&q=&year=&limit= — ranked with counts,
// searchable. year omitted = all time.
musicStats.get('/top', (c) => {
  const userId = c.get('user').id
  const kind = c.req.query('kind') === 'artists' ? 'artists' : 'tracks'
  const q = (c.req.query('q') ?? '').trim().toLowerCase()
  const limit = Math.max(1, Math.min(100, Number(c.req.query('limit')) || 50))
  const yearRaw = c.req.query('year')
  const hasYear = Boolean(yearRaw && /^\d{4}$/.test(yearRaw))
  const [from, to] = hasYear ? yearRange(Number(yearRaw)) : [0, 0]

  const timeClause = hasYear ? 'AND played_at >= ? AND played_at < ?' : ''
  const timeParams = hasYear ? [from, to] : []
  // Escape LIKE wildcards so a literal % or _ in the search behaves.
  const like = `%${q.replace(/[\\%_]/g, m => `\\${m}`)}%`

  if (kind === 'artists') {
    const rows = sqlite.prepare(`
      SELECT MAX(artist) AS artist, COUNT(*) AS plays, ${LISTENED_SQL} AS listened, MAX(played_at) AS lastAt
      FROM music_history
      WHERE user_id = ? AND artist IS NOT NULL AND artist != '' ${timeClause}
        ${q ? `AND LOWER(artist) LIKE ? ESCAPE '\\'` : ''}
      GROUP BY LOWER(artist)
      ORDER BY plays DESC, lastAt DESC
      LIMIT ?
    `).all(userId, ...timeParams, ...(q ? [like] : []), limit) as Array<{ artist: string; plays: number; listened: number | null; lastAt: number }>
    return c.json({
      rows: rows.map(r => ({ artist: r.artist, plays: r.plays, minutes: Math.round((r.listened ?? 0) / 60), lastPlayedAtMs: r.lastAt * 1000 })),
    })
  }

  const rows = sqlite.prepare(`
    SELECT video_id AS videoId, MAX(title) AS title, MAX(artist) AS artist,
           COUNT(*) AS plays, ${LISTENED_SQL} AS listened, MAX(played_at) AS lastAt
    FROM music_history
    WHERE user_id = ? ${timeClause}
      ${q ? `AND (LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(artist, '')) LIKE ? ESCAPE '\\')` : ''}
    GROUP BY video_id
    ORDER BY plays DESC, lastAt DESC
    LIMIT ?
  `).all(userId, ...timeParams, ...(q ? [like, like] : []), limit) as Array<{ videoId: string; title: string; artist: string | null; plays: number; listened: number | null; lastAt: number }>
  return c.json({
    rows: rows.map(r => ({
      videoId: r.videoId, title: r.title, artist: r.artist ?? '',
      plays: r.plays, minutes: Math.round((r.listened ?? 0) / 60), lastPlayedAtMs: r.lastAt * 1000,
    })),
  })
})
