// Shared media helpers for the Shows / Movies apps. Currently the read-through image proxy:
// the frontend renders posters/backdrops/stills via /api/media/img?u=<url>, which caches
// the bytes on disk (allowlisted hosts only). Auth-gated like the rest of the app.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { getOrFetchMediaImageResized } from '@/lib/titles/imageProxy'
import type { AppEnv } from '@/types'

const mediaRoute = new Hono<AppEnv>()

mediaRoute.get('/img', requireAuth, async (c) => {
  const u = c.req.query('u')
  if (!u) return c.json({ error: 'Query param u is required' }, 400)

  // Optional ?w= width hint: bucketed webp downscale for grids (lib/imageResize).
  const img = await getOrFetchMediaImageResized(u, c.req.query('w'))
  if (!img) return c.json({ error: 'Image unavailable' }, 404)

  return new Response(new Uint8Array(img.data), {
    headers: {
      'Content-Type': img.contentType,
      'Cache-Control': 'public, max-age=604800, immutable',
    },
  })
})

export { mediaRoute }
