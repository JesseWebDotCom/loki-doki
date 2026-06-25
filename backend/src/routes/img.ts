// App-wide image proxy endpoint: GET /api/img?u=<absolute url>. Read-through disk cache
// with an SSRF guard (see lib/imageProxy). Auth-gated like the rest of the app — same-origin
// <img> requests carry the session cookie, so this Just Works for rendered images.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { getOrFetchProxyImage } from '@/lib/imageProxy'
import type { AppEnv } from '@/types'

const imgRoute = new Hono<AppEnv>()

imgRoute.get('/', requireAuth, async (c) => {
  const u = c.req.query('u')
  if (!u) return c.json({ error: 'Query param u is required' }, 400)

  const img = await getOrFetchProxyImage(u)
  if (!img) return c.json({ error: 'Image unavailable' }, 404)

  return new Response(new Uint8Array(img.data), {
    headers: {
      'Content-Type': img.contentType,
      'Cache-Control': 'public, max-age=604800, immutable',
    },
  })
})

export { imgRoute }
