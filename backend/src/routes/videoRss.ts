// Token-authed video RSS: per-creator and per-folder feeds any RSS reader can subscribe
// to. Deliberately a SEPARATE router from /api/videos (which requires a session on every
// path) because readers can't send our session cookie: the opaque per-user token in the
// URL is the credential, exactly like the OPDS catalog server. See lib/videos/portability.

import { Hono } from 'hono'
import type { AppEnv } from '@/types'
import { creatorFeed, folderFeed, resolveRssToken } from '@/lib/videos/portability'

const videoRss = new Hono<AppEnv>()

/** A subscription folder's merged feed: /api/video-rss/<token>/folder/<folderId>
 *  Registered BEFORE the creator route below, which would otherwise match it with
 *  source='folder' (Hono takes the first matching pattern). */
videoRss.get('/:token/folder/:folderId', async (c) => {
  const userId = await resolveRssToken(c.req.param('token'))
  if (!userId) return c.text('Not found', 404)
  const xml = await folderFeed(userId, c.req.param('folderId'), c.req.url)
  if (!xml) return c.text('Not found', 404)
  c.header('Content-Type', 'application/rss+xml; charset=utf-8')
  c.header('Cache-Control', 'private, max-age=300')
  return c.body(xml)
})

/** One creator's recent videos: /api/video-rss/<token>/<source>/<externalId> */
videoRss.get('/:token/:source/:externalId', async (c) => {
  const userId = await resolveRssToken(c.req.param('token'))
  if (!userId) return c.text('Not found', 404)
  const xml = await creatorFeed(userId, c.req.param('source'), c.req.param('externalId'), c.req.url)
  // A creator this user doesn't follow is a 404, not an empty feed: the token grants
  // access to THEIR follows, not to arbitrary lookups.
  if (!xml) return c.text('Not found', 404)
  c.header('Content-Type', 'application/rss+xml; charset=utf-8')
  c.header('Cache-Control', 'private, max-age=300')
  return c.body(xml)
})

export { videoRss }
