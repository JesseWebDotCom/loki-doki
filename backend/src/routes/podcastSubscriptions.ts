// Real podcast subscriptions: directory browse/search + subscribe/unsubscribe +
// per-episode offline downloads. Mounted beside the main podcasts router under
// /api/podcasts (distinct sub-paths, no collisions).

import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { podcastEpisodes, podcastShows, podcastSubscriptions } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { chartPodcasts, lookupItunes, PODCAST_GENRES, podcastIndexConfigured, previewFeed, searchPodcasts } from '@/lib/podcast/directory'
import { filterDirectoryForUser } from '@/lib/podcast/policy'
import { refreshPodcastFeed, subscribeToFeed, unsubscribe, runAutoDownloadPass, DEFAULT_AUTO_KEEP } from '@/lib/podcast/feeds'
import { enqueueEpisodeDownload, removeEpisodeDownload } from '@/lib/podcast/offline'
import type { AppEnv } from '@/types'

export const podcastSubscriptionsRoute = new Hono<AppEnv>()
podcastSubscriptionsRoute.use('*', requireAuth)

// ── Directory ─────────────────────────────────────────────────────────────────────

podcastSubscriptionsRoute.get('/directory/search', async (c) => {
  const q = c.req.query('q')?.trim() ?? ''
  const limit = Math.min(Number.parseInt(c.req.query('limit') ?? '25', 10) || 25, 50)
  if (!q) return c.json({ results: [] })
  try {
    return c.json({ results: await filterDirectoryForUser(c.get('user').id, await searchPodcasts(q, limit)) })
  } catch (err) {
    return c.json({ results: [], error: String(err) })
  }
})

podcastSubscriptionsRoute.get('/directory/charts', async (c) => {
  const genreRaw = c.req.query('genre')
  const genreId = genreRaw ? Number.parseInt(genreRaw, 10) || null : null
  const limit = Math.min(Number.parseInt(c.req.query('limit') ?? '40', 10) || 40, 100)
  try {
    const { results, provider } = await chartPodcasts(genreId, limit)
    return c.json({ results: await filterDirectoryForUser(c.get('user').id, results), provider, genres: PODCAST_GENRES })
  } catch (err) {
    return c.json({ results: [], provider: 'itunes', genres: PODCAST_GENRES, error: String(err) })
  }
})

podcastSubscriptionsRoute.get('/directory/status', async (c) => {
  return c.json({ podcastIndexConfigured: await podcastIndexConfigured() })
})

// Pre-subscribe show details: description, categories, recent episodes — straight from
// the feed. Accepts ?feedUrl= or ?itunesId= (chart rows carry only the latter).
podcastSubscriptionsRoute.get('/directory/preview', async (c) => {
  let feedUrl = c.req.query('feedUrl')?.trim()
  const itunesRaw = c.req.query('itunesId')
  if (!feedUrl && itunesRaw) {
    const looked = await lookupItunes(Number.parseInt(itunesRaw, 10)).catch(() => null)
    if (!looked?.feedUrl) return c.json({ error: 'Podcast is no longer listed in the directory' }, 404)
    feedUrl = looked.feedUrl
  }
  if (!feedUrl) return c.json({ error: 'feedUrl or itunesId required' }, 400)
  try {
    return c.json({ preview: await previewFeed(feedUrl) })
  } catch (err) {
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 502)
  }
})

// ── Subscriptions ─────────────────────────────────────────────────────────────────

podcastSubscriptionsRoute.get('/subscriptions', async (c) => {
  const user = c.get('user')
  const rows = await db.select({
    showId: podcastSubscriptions.showId,
    autoDownload: podcastSubscriptions.autoDownload,
    autoDownloadKeep: podcastSubscriptions.autoDownloadKeep,
    addedAt: podcastSubscriptions.addedAt,
    name: podcastShows.name,
    feedUrl: podcastShows.feedUrl,
    artworkUrl: podcastShows.artworkUrl,
    author: podcastShows.author,
  }).from(podcastSubscriptions)
    .innerJoin(podcastShows, eq(podcastSubscriptions.showId, podcastShows.id))
    .where(eq(podcastSubscriptions.userId, user.id))
  return c.json({ subscriptions: rows })
})

// Subscribe by explicit feed URL (manual add / directory rows that carry feedUrl) or by
// iTunes collection id (chart rows omit the feed URL — resolve it here).
podcastSubscriptionsRoute.post('/subscriptions', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ feedUrl?: string; itunesId?: number; seed?: { title?: string; artworkUrl?: string; author?: string; genre?: string } }>()
    .catch(() => ({} as { feedUrl?: undefined; itunesId?: undefined; seed?: undefined }))

  let feedUrl = body.feedUrl?.trim()
  let seed = body.seed
  if (!feedUrl && body.itunesId) {
    const looked = await lookupItunes(body.itunesId).catch(() => null)
    if (!looked?.feedUrl) return c.json({ error: 'Podcast is no longer listed in the directory' }, 404)
    feedUrl = looked.feedUrl
    seed = { title: looked.title, artworkUrl: looked.artworkUrl ?? undefined, author: looked.author ?? undefined, genre: looked.genre ?? undefined }
  }
  if (!feedUrl) return c.json({ error: 'feedUrl or itunesId required' }, 400)

  try {
    const { showId } = await subscribeToFeed(user.id, feedUrl, seed)
    const [show] = await db.select().from(podcastShows).where(eq(podcastShows.id, showId))
    return c.json({ show })
  } catch (err) {
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 400)
  }
})

podcastSubscriptionsRoute.put('/subscriptions/:showId', async (c) => {
  const user = c.get('user')
  const showId = c.req.param('showId')
  const body = await c.req.json<{ autoDownload?: boolean; autoDownloadKeep?: number | null }>()
    .catch(() => ({} as { autoDownload?: undefined }))

  const [sub] = await db.select().from(podcastSubscriptions)
    .where(and(eq(podcastSubscriptions.userId, user.id), eq(podcastSubscriptions.showId, showId)))
    .limit(1)
  if (!sub) return c.json({ error: 'Not subscribed' }, 404)

  await db.update(podcastSubscriptions).set({
    ...(typeof body.autoDownload === 'boolean' && { autoDownload: body.autoDownload }),
    ...('autoDownloadKeep' in body && {
      autoDownloadKeep: body.autoDownloadKeep == null ? null : Math.max(1, Math.min(Math.round(body.autoDownloadKeep), 20)),
    }),
  }).where(eq(podcastSubscriptions.id, sub.id))

  // Turning auto-download on should start fetching immediately, not at the next poll.
  if (body.autoDownload === true && !sub.autoDownload) {
    runAutoDownloadPass(showId).catch(() => {})
  }
  return c.json({ ok: true, defaultKeep: DEFAULT_AUTO_KEEP })
})

podcastSubscriptionsRoute.delete('/subscriptions/:showId', async (c) => {
  const user = c.get('user')
  await unsubscribe(user.id, c.req.param('showId'))
  return c.json({ ok: true })
})

podcastSubscriptionsRoute.post('/subscriptions/:showId/refresh', async (c) => {
  const user = c.get('user')
  const showId = c.req.param('showId')
  const [sub] = await db.select({ id: podcastSubscriptions.id }).from(podcastSubscriptions)
    .where(and(eq(podcastSubscriptions.userId, user.id), eq(podcastSubscriptions.showId, showId)))
    .limit(1)
  if (!sub) return c.json({ error: 'Not subscribed' }, 404)
  try {
    const added = await refreshPodcastFeed(showId)
    return c.json({ ok: true, added })
  } catch (err) {
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 502)
  }
})

// ── Episode downloads (offline archiving) ─────────────────────────────────────────

podcastSubscriptionsRoute.post('/episodes/:id/download', async (c) => {
  const user = c.get('user')
  const episodeId = c.req.param('id')
  // Any household member may play an RSS episode, but only download episodes of shows
  // they subscribe to — downloads pin blob space to membership.
  const [episode] = await db.select({ showId: podcastEpisodes.showId }).from(podcastEpisodes)
    .where(eq(podcastEpisodes.id, episodeId)).limit(1)
  if (!episode) return c.json({ error: 'Not found' }, 404)
  const [sub] = await db.select({ id: podcastSubscriptions.id }).from(podcastSubscriptions)
    .where(and(eq(podcastSubscriptions.userId, user.id), eq(podcastSubscriptions.showId, episode.showId)))
    .limit(1)
  if (!sub) return c.json({ error: 'Subscribe to the show to download episodes' }, 403)

  try {
    await enqueueEpisodeDownload(user.id, episodeId, { auto: false })
    return c.json({ ok: true })
  } catch (err) {
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 400)
  }
})

podcastSubscriptionsRoute.delete('/episodes/:id/download', async (c) => {
  const user = c.get('user')
  await removeEpisodeDownload(user.id, c.req.param('id'))
  return c.json({ ok: true })
})
