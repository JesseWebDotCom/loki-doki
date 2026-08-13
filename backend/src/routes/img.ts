// App-wide image proxy endpoint: GET /api/img?u=<absolute url>. Read-through disk cache
// with an SSRF guard (see lib/imageProxy). Auth-gated like the rest of the app — same-origin
// <img> requests carry the session cookie, so this Just Works for rendered images.

import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { getOrFetchProxyImageResized } from '@/lib/imageProxy'
import type { AppEnv } from '@/types'

const imgRoute = new Hono<AppEnv>()

// stale-while-revalidate: past max-age a client may keep painting its copy while it
// revalidates in the background - on a slow phone that means art stays instant instead
// of blocking on the refresh.
const CACHE_CONTROL = 'public, max-age=604800, stale-while-revalidate=2592000, immutable'

imgRoute.get('/', requireAuth, async (c) => {
  const u = c.req.query('u')
  if (!u) return c.json({ error: 'Query param u is required' }, 400)

  // Optional ?w= width hint: serves a bucketed webp downscale for card/grid renders
  // (see lib/imageResize). Omitted or unresizable → original bytes, as always.
  const img = await getOrFetchProxyImageResized(u, c.req.query('w'))
  if (!img) return c.json({ error: 'Image unavailable' }, 404)

  // Strong ETag over the BYTES (not the URL): after the browser's copy ages out or gets
  // evicted-then-revalidated, an unchanged image costs a 304 instead of a re-download,
  // and a changed one (same URL, new bytes) still comes through. Hashing a few tens of
  // KB is microseconds against a disk-cache read.
  const etag = `"${createHash('sha256').update(img.data).digest('hex').slice(0, 32)}"`
  if (c.req.header('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': CACHE_CONTROL } })
  }

  // Buffer is a valid body at runtime; the cast sidesteps a TS Buffer-generic mismatch
  // without copying the bytes (new Uint8Array(buf) would clone the whole image).
  return new Response(img.data as unknown as BodyInit, {
    headers: {
      'Content-Type': img.contentType,
      'Cache-Control': CACHE_CONTROL,
      ETag: etag,
    },
  })
})

export { imgRoute }
