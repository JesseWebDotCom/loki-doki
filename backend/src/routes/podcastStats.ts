// Podcast Replay (year-in-review) + all-time podcast stats, computed from
// podcast_watch_state (the per-episode listening positions the player beacons).
// Honest caveat baked into the numbers: watch state stores the LATEST position per
// episode with its last-updated time, so a listen counts toward the year it was last
// touched and re-listens don't double-count. Minutes are real progress, not durations.

import { Hono } from 'hono'
import { sqlite } from '@/db'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'

export const podcastStats = new Hono<AppEnv>()
podcastStats.use('*', requireAuth)

// Listened seconds for one watch-state row: full duration when marked completed,
// otherwise the furthest position (clamped to duration when known).
const LISTENED_SQL = `
  SUM(CASE WHEN w.completed = 1 THEN COALESCE(e.duration_sec, w.position_sec)
           ELSE MIN(w.position_sec, COALESCE(e.duration_sec, w.position_sec)) END)`

const BASE_JOIN = `
  FROM podcast_watch_state w
  JOIN podcast_episodes e ON e.id = w.episode_id
  JOIN podcast_shows s ON s.id = e.show_id`

function yearRange(year: number): [number, number] {
  return [
    Math.floor(new Date(year, 0, 1).getTime() / 1000),
    Math.floor(new Date(year + 1, 0, 1).getTime() / 1000),
  ]
}

interface ShowAgg { showId: string; name: string; episodes: number; minutes: number }

function topShows(where: string, params: unknown[], limit: number): ShowAgg[] {
  const rows = sqlite.prepare(`
    SELECT s.id AS showId, s.name AS name, COUNT(*) AS episodes, ${LISTENED_SQL} AS listened
    ${BASE_JOIN}
    WHERE ${where}
    GROUP BY s.id ORDER BY listened DESC LIMIT ?
  `).all(...params, limit) as Array<{ showId: string; name: string; episodes: number; listened: number | null }>
  return rows.map(r => ({ showId: r.showId, name: r.name, episodes: r.episodes, minutes: Math.round((r.listened ?? 0) / 60) }))
}

// GET /api/podcasts/replay?year=2026 — the podcast year-in-review.
podcastStats.get('/replay', (c) => {
  const user = c.get('user')
  const yearRaw = c.req.query('year')
  const year = yearRaw && /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : new Date().getFullYear()
  const [from, to] = yearRange(year)

  const [totals] = sqlite.prepare(`
    SELECT COUNT(*) AS episodes, ${LISTENED_SQL} AS listened, COUNT(DISTINCT s.id) AS shows
    ${BASE_JOIN}
    WHERE w.user_id = ? AND w.updated_at >= ? AND w.updated_at < ?
  `).all(user.id, from, to) as Array<{ episodes: number; listened: number | null; shows: number }>

  const shows = topShows('w.user_id = ? AND w.updated_at >= ? AND w.updated_at < ?', [user.id, from, to], 8)

  const [longest] = sqlite.prepare(`
    SELECT e.title AS title, s.id AS showId, s.name AS showName,
           CASE WHEN w.completed = 1 THEN COALESCE(e.duration_sec, w.position_sec)
                ELSE MIN(w.position_sec, COALESCE(e.duration_sec, w.position_sec)) END AS listened
    ${BASE_JOIN}
    WHERE w.user_id = ? AND w.updated_at >= ? AND w.updated_at < ?
    ORDER BY listened DESC LIMIT 1
  `).all(user.id, from, to) as Array<{ title: string; showId: string; showName: string; listened: number | null }>

  // Trim-silence time saved is an all-time counter (user_preferences), not per-year:
  // reported separately and labeled as such in the UI.
  const [saved] = sqlite.prepare(`
    SELECT value FROM user_preferences WHERE user_id = ? AND key = 'podcasts.timeSavedSec'
  `).all(user.id) as Array<{ value: string }>
  let timeSavedSec = 0
  try { timeSavedSec = Math.max(0, Number(JSON.parse(saved?.value ?? '0')) || 0) } catch { /* keep 0 */ }

  // Household-combined section: admins only.
  let household: {
    minutes: number; episodes: number
    topShows: ShowAgg[]
    byUser: Array<{ firstName: string; minutes: number; episodes: number }>
  } | null = null
  if (user.role === 'admin') {
    const [hTotals] = sqlite.prepare(`
      SELECT COUNT(*) AS episodes, ${LISTENED_SQL} AS listened
      ${BASE_JOIN}
      WHERE w.updated_at >= ? AND w.updated_at < ?
    `).all(from, to) as Array<{ episodes: number; listened: number | null }>
    const byUser = sqlite.prepare(`
      SELECT u.first_name AS firstName, COUNT(*) AS episodes, ${LISTENED_SQL} AS listened
      ${BASE_JOIN}
      JOIN users u ON u.id = w.user_id
      WHERE w.updated_at >= ? AND w.updated_at < ?
      GROUP BY w.user_id ORDER BY listened DESC
    `).all(from, to) as Array<{ firstName: string; episodes: number; listened: number | null }>
    household = {
      minutes: Math.round((hTotals?.listened ?? 0) / 60),
      episodes: hTotals?.episodes ?? 0,
      topShows: topShows('w.updated_at >= ? AND w.updated_at < ?', [from, to], 6),
      byUser: byUser.map(r => ({ firstName: r.firstName, minutes: Math.round((r.listened ?? 0) / 60), episodes: r.episodes })),
    }
  }

  return c.json({
    year,
    minutes: Math.round((totals?.listened ?? 0) / 60),
    episodes: totals?.episodes ?? 0,
    showCount: totals?.shows ?? 0,
    topShows: shows,
    longestListen: longest && (longest.listened ?? 0) > 0
      ? { title: longest.title, showId: longest.showId, showName: longest.showName, minutes: Math.round((longest.listened ?? 0) / 60) }
      : null,
    timeSavedSec,
    household,
  })
})

// GET /api/podcasts/stats — all-time podcast numbers for the Stats explorer.
podcastStats.get('/stats', (c) => {
  const user = c.get('user')

  const [totals] = sqlite.prepare(`
    SELECT COUNT(*) AS episodes, ${LISTENED_SQL} AS listened, COUNT(DISTINCT s.id) AS shows
    ${BASE_JOIN}
    WHERE w.user_id = ?
  `).all(user.id) as Array<{ episodes: number; listened: number | null; shows: number }>

  const years = sqlite.prepare(`
    SELECT CAST(strftime('%Y', w.updated_at, 'unixepoch', 'localtime') AS INTEGER) AS year,
           COUNT(*) AS episodes, ${LISTENED_SQL} AS listened
    ${BASE_JOIN}
    WHERE w.user_id = ?
    GROUP BY year ORDER BY year ASC
  `).all(user.id) as Array<{ year: number; episodes: number; listened: number | null }>

  return c.json({
    totals: {
      episodes: totals?.episodes ?? 0,
      minutes: Math.round((totals?.listened ?? 0) / 60),
      shows: totals?.shows ?? 0,
    },
    years: years.map(y => ({ year: y.year, episodes: y.episodes, minutes: Math.round((y.listened ?? 0) / 60) })),
    topShows: topShows('w.user_id = ?', [user.id], 20),
  })
})
