// Shows app API. Rich discovery + show detail over keyless sources (TVMaze + the shared
// title enrichment). Reviews and trivia are LLM-heavy, so they live on their own lazy
// endpoints rather than blocking the detail bundle.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import {
  getHomeShelves,
  getShowCore,
  getShowStreaming,
  getShowMediaById,
  getShowOverviewById,
  getShowParentsGuideById,
  getShowBackdropById,
} from '@/lib/shows'
import { getShowDetails, searchShows } from '@/lib/shows/tvmaze'
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
