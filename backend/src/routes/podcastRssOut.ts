// Private RSS feeds OUT, token-authed with no app session (podcatchers can't send our
// session cookie). Mirrors the OPDS server's posture: /api/podcast-rss/<token>/... and
// every enclosure under it resolves the same per-user token. See lib/podcast/rssOut.ts.

import { Hono } from 'hono'
import { statSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { musicRadioRecordings, podcastEpisodes, podcastShows } from '@/db/schema'
import { resolveUserPath } from '@/lib/storage/paths'
import { buildRadioFeed, buildShowFeed, resolveRssToken } from '@/lib/podcast/rssOut'
import { streamLocalAudio } from '@/routes/podcasts'
import type { AppEnv } from '@/types'

export const podcastRssOut = new Hono<AppEnv>()

/** Absolute origin for the links inside a feed. A podcatcher on the LAN fetched us at
 *  some host:port; reuse exactly that so its enclosure requests come back here. */
function originOf(c: { req: { url: string; header(n: string): string | undefined } }): string {
  const url = new URL(c.req.url)
  const forwardedHost = c.req.header('x-forwarded-host')
  const forwardedProto = c.req.header('x-forwarded-proto')
  const host = forwardedHost ?? c.req.header('host') ?? url.host
  const proto = forwardedProto ?? url.protocol.replace(':', '')
  return `${proto}://${host}`
}

// GET /api/podcast-rss/:token/show/:showId.xml
podcastRssOut.get('/:token/show/:showId{.+\\.xml}', async (c) => {
  const token = c.req.param('token')
  const userId = await resolveRssToken(token)
  if (!userId) return c.text('Unauthorized', 401)
  const showId = c.req.param('showId').replace(/\.xml$/, '')
  const xml = await buildShowFeed(userId, showId, originOf(c), token)
  if (!xml) return c.text('Not found', 404)
  return c.body(xml, 200, { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'no-store' })
})

// GET /api/podcast-rss/:token/radio.xml — the whole radio-recordings collection.
podcastRssOut.get('/:token/radio.xml', async (c) => {
  const token = c.req.param('token')
  const userId = await resolveRssToken(token)
  if (!userId) return c.text('Unauthorized', 401)
  const xml = await buildRadioFeed(userId, originOf(c), token)
  return c.body(xml, 200, { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'no-store' })
})

// Enclosure: one generated episode's audio. Token-authed and re-checked against the
// token user's access, so a leaked episode id alone buys nothing.
podcastRssOut.get('/:token/episode/:episodeId{.+\\.mp3}', async (c) => {
  const userId = await resolveRssToken(c.req.param('token'))
  if (!userId) return c.text('Unauthorized', 401)
  const episodeId = c.req.param('episodeId').replace(/\.mp3$/, '')

  const [row] = await db.select({
    audioRelPath: podcastEpisodes.audioRelPath,
    status: podcastEpisodes.status,
    ownerUserId: podcastShows.ownerUserId,
    visibility: podcastShows.visibility,
    source: podcastShows.source,
  })
    .from(podcastEpisodes)
    .innerJoin(podcastShows, eq(podcastEpisodes.showId, podcastShows.id))
    .where(eq(podcastEpisodes.id, episodeId))
    .limit(1)

  if (!row || row.source === 'rss') return c.text('Not found', 404)
  if (row.ownerUserId !== userId && row.visibility !== 'shared') return c.text('Not found', 404)
  if (row.status !== 'ready' || !row.audioRelPath) return c.text('Not ready', 404)

  let absPath: string
  try { absPath = await resolveUserPath(row.audioRelPath) } catch { return c.text('File missing', 404) }
  return streamLocalAudio(c, absPath, 'audio/mpeg')
})

// Enclosure: one radio recording's audio (owner only).
podcastRssOut.get('/:token/recording/:recordingId{.+\\.mp3}', async (c) => {
  const userId = await resolveRssToken(c.req.param('token'))
  if (!userId) return c.text('Unauthorized', 401)
  const recordingId = c.req.param('recordingId').replace(/\.mp3$/, '')

  const [rec] = await db.select().from(musicRadioRecordings)
    .where(and(eq(musicRadioRecordings.id, recordingId), eq(musicRadioRecordings.userId, userId)))
    .limit(1)
  if (!rec?.relPath || rec.status !== 'ready') return c.text('Not ready', 404)

  let absPath: string
  try { absPath = await resolveUserPath(rec.relPath) } catch { return c.text('File missing', 404) }
  return streamLocalAudio(c, absPath, 'audio/mpeg')
})

// Show cover for the feed's <itunes:image>.
podcastRssOut.get('/:token/show/:showId/cover', async (c) => {
  const userId = await resolveRssToken(c.req.param('token'))
  if (!userId) return c.text('Unauthorized', 401)

  const [show] = await db.select({
    coverRelPath: podcastShows.coverRelPath,
    ownerUserId: podcastShows.ownerUserId,
    visibility: podcastShows.visibility,
  }).from(podcastShows).where(eq(podcastShows.id, c.req.param('showId'))).limit(1)
  if (!show?.coverRelPath) return c.text('No cover', 404)
  if (show.ownerUserId !== userId && show.visibility !== 'shared') return c.text('Not found', 404)

  let absPath: string
  try { absPath = await resolveUserPath(show.coverRelPath) } catch { return c.text('Missing', 404) }
  let stat: ReturnType<typeof statSync>
  try { stat = statSync(absPath) } catch { return c.text('Missing', 404) }
  return new Response(createReadStream(absPath) as any, {
    headers: { 'Content-Type': 'image/png', 'Content-Length': String(stat.size), 'Cache-Control': 'private, max-age=3600' },
  })
})
