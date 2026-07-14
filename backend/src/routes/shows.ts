// Shows app API. Rich discovery + show detail over keyless sources (TVMaze + the shared
// title enrichment). Reviews and trivia are LLM-heavy, so they live on their own lazy
// endpoints rather than blocking the detail bundle.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { mediaWatchlist } from '@/db/schema'
import {
  getHomeShelves,
  getShowCore,
  getShowStreaming,
  getShowMediaById,
  getShowOverviewById,
  getShowParentsGuideById,
  getShowBackdropById,
  getTopRatedShows,
  getShowsForAge,
} from '@/lib/shows'
import { getShowDetails, searchShows, getOnTvTonight, getNextEpisode } from '@/lib/shows/tvmaze'
import { datasetsReady, ensureImdbDatasets, episodeRatings } from '@/lib/imdb/datasets'
import { getReviews } from '@/lib/titles/reviews'
import { getTrivia } from '@/lib/titles/trivia'
import { ensureTvShowPodcast, queueTvShowBatch, getTvShowPodcast } from '@/lib/podcast/mediaPodcast'
import type { AppEnv } from '@/types'

const showsRoute = new Hono<AppEnv>()

showsRoute.get('/home', requireAuth, async (c) => {
  const shelves = await getHomeShelves()
  return c.json({ shelves })
})

showsRoute.get('/search', requireAuth, async (c) => {
  const q = c.req.query('q')?.trim()
  if (!q) return c.json({ error: 'Query param q is required' }, 400)
  const results = await searchShows(q, 24)
  return c.json({ results })
})

// What's airing tonight — broadcast/cable + streaming premieres. Registered BEFORE '/:id'
// so the static path isn't swallowed by the numeric-id param route.
showsRoute.get('/on-tv', requireAuth, async (c) => {
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const entries = await getOnTvTonight(date)
  return c.json({ date, entries })
})

showsRoute.get('/for-age', requireAuth, async (c) => {
  const age = Math.min(17, Math.max(2, Number(c.req.query('age')) || 8))
  return c.json({ age, items: await getShowsForAge(age) })
})

showsRoute.get('/top-rated', requireAuth, async (c) => {
  return c.json({ items: await getTopRatedShows() })
})

// Upcoming episodes for the user's tracked shows (watchlist), soonest first — the Calendar.
// Registered BEFORE '/:id' so the static path isn't swallowed by the numeric-id route.
showsRoute.get('/calendar', requireAuth, async (c) => {
  const user = c.get('user')
  const rows = await db
    .select({ refId: mediaWatchlist.refId })
    .from(mediaWatchlist)
    .where(and(eq(mediaWatchlist.userId, user.id), eq(mediaWatchlist.mediaType, 'show'), isNull(mediaWatchlist.deletedAt)))
    .limit(40)
  const ids = rows.map((r) => Number(r.refId)).filter((n) => Number.isInteger(n) && n > 0)
  const results = await Promise.all(ids.map((id) => getNextEpisode(id)))
  const entries = results
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .sort((a, b) => (a.airstamp ?? a.airdate ?? '9999').localeCompare(b.airstamp ?? b.airdate ?? '9999'))
  return c.json({ entries })
})

function parseId(raw: string | undefined): number | null {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

// Fast core (TVMaze) — renders the page immediately. Enrichments stream in via the
// per-section endpoints below.
showsRoute.get('/:id', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid show id' }, 400)
  const core = await getShowCore(id)
  if (!core) return c.json({ error: 'Show not found' }, 404)
  return c.json(core)
})

showsRoute.get('/:id/streaming', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid show id' }, 400)
  return c.json({ streaming: await getShowStreaming(id) })
})

showsRoute.get('/:id/media', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid show id' }, 400)
  return c.json({ media: await getShowMediaById(id) })
})

showsRoute.get('/:id/overview', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid show id' }, 400)
  return c.json({ overview: await getShowOverviewById(id) })
})

showsRoute.get('/:id/parents-guide', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid show id' }, 400)
  return c.json({ parentsGuide: await getShowParentsGuideById(id) })
})

showsRoute.get('/:id/backdrop', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid show id' }, 400)
  return c.json({ backdrop: await getShowBackdropById(id) })
})

// Per-episode IMDb ratings grid (the heatmap). First-ever call kicks off the dataset import
// in the background and reports building:true; once imported (refreshed weekly), instant.
showsRoute.get('/:id/ratings-heatmap', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid show id' }, 400)
  const details = await getShowDetails(id)
  const imdb = details?.externals.imdb
  if (!imdb) return c.json({ available: false, building: false, episodes: [] })
  if (!datasetsReady()) {
    void ensureImdbDatasets().catch(() => {})
    return c.json({ available: false, building: true, episodes: [] })
  }
  void ensureImdbDatasets().catch(() => {}) // freshness refresh in the background
  const episodes = episodeRatings(imdb)
  return c.json({ available: episodes.length > 0, building: false, episodes })
})

showsRoute.get('/:id/reviews', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid show id' }, 400)
  const details = await getShowDetails(id)
  if (!details) return c.json({ error: 'Show not found' }, 404)
  const reviews = await getReviews(details.name, details.year, 'show')
  return c.json({ reviews })
})

showsRoute.get('/:id/trivia', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid show id' }, 400)
  const details = await getShowDetails(id)
  if (!details) return c.json({ error: 'Show not found' }, 404)
  const trivia = await getTrivia(details.name, details.year, 'show')
  return c.json({ trivia })
})

// ── AI podcast (one episode per TV episode, generated in batches of 5) ──────────────

showsRoute.get('/:id/podcast', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid show id' }, 400)
  const user = c.get('user')
  const podcast = await getTvShowPodcast(id, user.id)
  return c.json({ podcast })
})

showsRoute.post('/:id/podcast', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid show id' }, 400)
  const user = c.get('user')
  const show = await ensureTvShowPodcast(id, user.id, user.role === 'admin')
  if (!show) return c.json({ error: 'Could not create podcast — no companion available to host it.' }, 400)
  const result = await queueTvShowBatch(show.id, id, user.id)
  return c.json({ podcastShowId: show.id, ...result })
})

showsRoute.post('/:id/podcast/next-batch', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: 'Invalid show id' }, 400)
  const user = c.get('user')
  const show = await ensureTvShowPodcast(id, user.id, user.role === 'admin')
  if (!show) return c.json({ error: 'Could not create podcast — no companion available to host it.' }, 400)
  const result = await queueTvShowBatch(show.id, id, user.id)
  return c.json({ podcastShowId: show.id, ...result })
})

export { showsRoute }
