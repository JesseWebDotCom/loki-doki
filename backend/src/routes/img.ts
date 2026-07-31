// App-wide image proxy endpoint: GET /api/img?u=<absolute url>. Read-through disk cache
// with an SSRF guard (see lib/imageProxy). Auth-gated like the rest of the app — same-origin
// <img> requests carry the session cookie, so this Just Works for rendered images.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { getOrFetchProxyImageResized } from '@/lib/imageProxy'
import type { AppEnv } from '@/types'

const imgRoute = new Hono<AppEnv>()

imgRoute.get('/', requireAuth, async (c) => {
  const u = c.req.query('u')
  if (!u) return c.json({ error: 'Query param u is required' }, 400)

  // Optional ?w= width hint: serves a bucketed webp downscale for card/grid renders
  // (see lib/imageResize). Omitted or unresizable → original bytes, as always.
  const img = await getOrFetchProxyImageResized(u, c.req.query('w'))
  if (!img) return c.json({ error: 'Image unavailable' }, 404)

  // Buffer is a valid body at runtime; the cast sidesteps a TS Buffer-generic mismatch
  // without copying the bytes (new Uint8Array(buf) would clone the whole image).
  return new Response(img.data as unknown as BodyInit, {
    headers: {
      'Content-Type': img.contentType,
      'Cache-Control': 'public, max-age=604800, immutable',
    },
  })
})

export { imgRoute }
