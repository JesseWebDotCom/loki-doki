// Movies app API. Mirrors the Shows API (discovery + rich detail + lazy reviews/trivia) but
// keyed by title (+year) since JustWatch/Fandango feeds share no stable numeric id. Adds the
// movie-only extras: an "In Theaters" shelf and a per-movie showtimes panel (Fandango).

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import {
  getHomeShelves,
  getInTheaters,
  getMovieCore,
  getMovieShowtimes,
  getMovieMediaById,
  getMovieOverviewById,
  getMovieParentsGuideById,
  getMovieBackdropById,
  resolveUserZip,
  getSavedZip,
  setSavedZip,
  getShowtimesNear,
  getTopRatedMovies,
  getNewMovies,
  getMoviesForAge,
} from '@/lib/movies'
import { searchTitles } from '@/lib/titles/justwatch'
import { serveMediaRail } from '@/lib/interests/media'
import { getReviews } from '@/lib/titles/reviews'
import { getTrivia } from '@/lib/titles/trivia'
import { ensureAndQueueMoviePodcast, getMoviePodcast } from '@/lib/podcast/mediaPodcast'
import type { AppEnv } from '@/types'

const moviesRoute = new Hono<AppEnv>()

function parseYear(raw: string | undefined): number | null {
  const y = Number(raw)
  return Number.isInteger(y) && y > 1870 ? y : null
}

moviesRoute.get('/home', requireAuth, async (c) => {
  const shelves = await getHomeShelves()
  return c.json({ shelves })
})

// "Suggested for you" — interest-engine rail (lib/interests/media.ts): watchlist signals,
// JustWatch similar/genre candidates, watchlist excluded, rotation + "Not interested".
moviesRoute.get('/suggested', requireAuth, async (c) => {
  const { items, building } = await serveMediaRail(c.get('user').id, 'movie')
  return c.json({ items, building })
})

moviesRoute.get('/in-theaters', requireAuth, async (c) => {
  const user = c.get('user')
  const zip = c.req.query('zip')?.trim() || (await resolveUserZip(user.id)).zip || ''
  const items = await getInTheaters(zip)
  return c.json({ items })
})

// Full "what's playing near you" discovery payload — movies + theaters + showtimes. Resolves
// the household ZIP when none is passed, so the section works with zero setup.
moviesRoute.get('/near-me', requireAuth, async (c) => {
  const user = c.get('user')
  const explicit = c.req.query('zip')?.trim()
  const resolved = explicit ? { zip: explicit, source: 'setting' as const } : await resolveUserZip(user.id)
  if (!resolved.zip) return c.json({ zip: null, source: null, data: null })
  const data = await getShowtimesNear(resolved.zip)
  return c.json({ zip: resolved.zip, source: resolved.source, data })
})

// The saved Showtimes ZIP setting (household location used as the geocoded default).
moviesRoute.get('/zip', requireAuth, async (c) => {
  const user = c.get('user')
  const [saved, resolved] = await Promise.all([getSavedZip(user.id), resolveUserZip(user.id)])
  return c.json({ saved, zip: resolved.zip, source: resolved.source })
})

moviesRoute.put('/zip', requireAuth, async (c) => {
  const user = c.get('user')
  const body = (await c.req.json().catch(() => ({}))) as { zip?: string }
  const saved = await setSavedZip(user.id, body.zip ?? '')
  return c.json({ saved })
})

moviesRoute.get('/top-rated', requireAuth, async (c) => {
  return c.json({ items: await getTopRatedMovies() })
})

moviesRoute.get('/new', requireAuth, async (c) => {
  return c.json({ items: await getNewMovies() })
})

moviesRoute.get('/for-age', requireAuth, async (c) => {
  const age = Math.min(17, Math.max(2, Number(c.req.query('age')) || 8))
  return c.json({ age, items: await getMoviesForAge(age) })
})

moviesRoute.get('/search', requireAuth, async (c) => {
  const q = c.req.query('q')?.trim()
  if (!q) return c.json({ error: 'Query param q is required' }, 400)
  const results = await searchTitles(q, 'MOVIE', 24)
  return c.json({
    results: results.map((r) => ({ title: r.title, year: r.year, poster: r.poster, genre: r.genres[0] ?? null })),
  })
})

moviesRoute.get('/detail', requireAuth, async (c) => {
  const title = c.req.query('title')?.trim()
  if (!title) return c.json({ error: 'Query param title is required' }, 400)
  const core = await getMovieCore(title, parseYear(c.req.query('year')))
  if (!core) return c.json({ error: 'Movie not found' }, 404)
  return c.json(core)
})

moviesRoute.get('/media', requireAuth, async (c) => {
  const title = c.req.query('title')?.trim()
  if (!title) return c.json({ error: 'Query param title is required' }, 400)
  return c.json({ media: await getMovieMediaById(title, parseYear(c.req.query('year'))) })
})

moviesRoute.get('/overview', requireAuth, async (c) => {
  const title = c.req.query('title')?.trim()
  if (!title) return c.json({ error: 'Query param title is required' }, 400)
  return c.json({ overview: await getMovieOverviewById(title, parseYear(c.req.query('year'))) })
})

moviesRoute.get('/parents-guide', requireAuth, async (c) => {
  const title = c.req.query('title')?.trim()
  if (!title) return c.json({ error: 'Query param title is required' }, 400)
  return c.json({ parentsGuide: await getMovieParentsGuideById(title, parseYear(c.req.query('year'))) })
})

moviesRoute.get('/backdrop', requireAuth, async (c) => {
  const title = c.req.query('title')?.trim()
  if (!title) return c.json({ error: 'Query param title is required' }, 400)
  return c.json({ backdrop: await getMovieBackdropById(title, parseYear(c.req.query('year'))) })
})

moviesRoute.get('/showtimes', requireAuth, async (c) => {
  const user = c.get('user')
  const title = c.req.query('title')?.trim()
  if (!title) return c.json({ error: 'Query param title is required' }, 400)
  const zip = c.req.query('zip')?.trim() || (await resolveUserZip(user.id)).zip || ''
  const movie = await getMovieShowtimes(title, zip)
  return c.json({ movie })
})

moviesRoute.get('/reviews', requireAuth, async (c) => {
  const title = c.req.query('title')?.trim()
  if (!title) return c.json({ error: 'Query param title is required' }, 400)
  const year = parseYear(c.req.query('year'))
  const reviews = await getReviews(title, year ? String(year) : null, 'movie')
  return c.json({ reviews })
})

moviesRoute.get('/trivia', requireAuth, async (c) => {
  const title = c.req.query('title')?.trim()
  if (!title) return c.json({ error: 'Query param title is required' }, 400)
  const year = parseYear(c.req.query('year'))
  const trivia = await getTrivia(title, year ? String(year) : null, 'movie')
  return c.json({ trivia })
})

// ── AI podcast (single deep-dive discussion per movie) ──────────────────────────────

moviesRoute.get('/podcast', requireAuth, async (c) => {
  const title = c.req.query('title')?.trim()
  if (!title) return c.json({ error: 'Query param title is required' }, 400)
  const user = c.get('user')
  const podcast = await getMoviePodcast(title, user.id)
  return c.json({ podcast })
})

moviesRoute.post('/podcast', requireAuth, async (c) => {
  const user = c.get('user')
  const body = (await c.req.json().catch(() => ({}))) as { title?: string; year?: number | null; overview?: string }
  const title = body.title?.trim()
  if (!title) return c.json({ error: 'title is required' }, 400)
  const result = await ensureAndQueueMoviePodcast(title, body.year ?? null, body.overview ?? '', user.id, user.role === 'admin')
  if (!result) return c.json({ error: 'Could not create podcast — no companion available to host it.' }, 400)
  return c.json(result)
})

export { moviesRoute }
