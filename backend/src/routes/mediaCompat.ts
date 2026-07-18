// /api/compat — status/stream endpoints for on-demand transcoded renditions.
//
// Entries are only ever minted by the owning media routes (videos/studio/music/podcasts
// call ensureCompat with a path THEY resolved and authorized), so these endpoints never
// take a path — only an opaque cache id. Household-scoped like the rest of media
// serving: any authed user may stream any entry (matches the shared-blob model).

import { Hono } from 'hono'
import { existsSync } from 'node:fs'
import { requireAuth } from '@/middleware/auth'
import { serveFileRange } from '@/lib/http/rangeFile'
import { getEntry, retryEntry, touchServed, entryOutPath } from '@/lib/mediacompat/store'
import { streamLiveTranscode } from '@/lib/mediacompat/live'

const route = new Hono()
route.use('*', requireAuth)

const ID_RE = /^[0-9a-f]{32}-(video|audio)$/

route.get('/status/:id', async (c) => {
  const id = c.req.param('id')
  if (!ID_RE.test(id)) return c.json({ error: 'Bad id' }, 400)
  const row = await getEntry(id)
  if (!row) return c.json({ error: 'Unknown entry' }, 404)
  return c.json({
    id: row.id,
    status: row.status,
    progressPct: row.progressPct,
    error: row.error,
    sizeBytes: row.sizeBytes,
    variant: row.variant,
  })
})

route.post('/retry/:id', async (c) => {
  const id = c.req.param('id')
  if (!ID_RE.test(id)) return c.json({ error: 'Bad id' }, 400)
  const ok = await retryEntry(id)
  return ok ? c.json({ ok: true }) : c.json({ error: 'Not retryable' }, 409)
})

// Cached rendition — seekable, Range-aware; what iOS needs and what everyone gets once
// the encode finished. 425 while still encoding so clients know to keep polling.
route.get('/stream/:id', async (c) => {
  const id = c.req.param('id')
  if (!ID_RE.test(id)) return c.json({ error: 'Bad id' }, 400)
  const row = await getEntry(id)
  if (!row) return c.json({ error: 'Unknown entry' }, 404)
  if (row.status === 'failed') return c.json({ error: row.error ?? 'Transcode failed' }, 502)
  if (row.status !== 'ready' || !existsSync(entryOutPath(row))) {
    return c.json({ status: row.status, progressPct: row.progressPct }, 425)
  }
  touchServed(row.id)
  const type = row.variant === 'audio' ? 'audio/mp4' : 'video/mp4'
  return serveFileRange(c, entryOutPath(row), type)
})

// Live pipe — starts playing immediately (desktop), not seekable. Keeps working while
// the cached encode is pending/running; also serves as the instant path for huge files.
route.get('/live/:id', async (c) => {
  const id = c.req.param('id')
  if (!ID_RE.test(id)) return c.json({ error: 'Bad id' }, 400)
  const row = await getEntry(id)
  if (!row) return c.json({ error: 'Unknown entry' }, 404)
  if (!existsSync(row.srcPath)) return c.json({ error: 'Source file missing' }, 404)
  return streamLiveTranscode(c, row)
})

export default route
