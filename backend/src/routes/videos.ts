// Videos hub API: source-agnostic endpoints over the provider registry.
// YouTube-specific plumbing stays on /api/youtube; these routes serve the
// hub surfaces (mixed home, universal clipper resolve, per-source browse).

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { getProvider, listProviders, matchUrlToProvider } from '@/lib/videos/registry'
import { allowAdultVideos } from '@/lib/videos/policy'
import { resolveClip } from '@/lib/clipper/resolve'
import type { VideoItem } from '@/lib/videos/types'
import type { AppEnv } from '@/types'

const videosRoute = new Hono<AppEnv>()
videosRoute.use('*', requireAuth)

// ── Sources: capabilities + config status (drives the rail + settings nudges) ──

videosRoute.get('/sources', async (c) => {
  const sources = await Promise.all(listProviders().map(async (p) => ({
    source: p.source,
    label: p.label,
    capabilities: p.capabilities,
    status: p.status ? await p.status() : { configured: true },
  })))
  return c.json({ sources })
})

// ── Mixed home: interleave provider browse feeds, policy-filtered ──────────────

videosRoute.get('/home', async (c) => {
  const user = c.get('user')
  const allowAdult = await allowAdultVideos(user.id)
  const wanted = (c.req.query('sources') ?? '').split(',').filter(Boolean)

  const active = listProviders().filter((p) =>
    p.browse && p.capabilities.browse && (wanted.length === 0 || wanted.includes(p.source)))

  const feeds = await Promise.all(active.map(async (p) => {
    try {
      const page = await p.browse!({ userId: user.id, allowAdult })
      return page.items.filter((it) => allowAdult || !it.isAdult)
    } catch {
      return [] as VideoItem[]  // one broken source never blanks the hub home
    }
  }))

  // Round-robin interleave so every enabled source is visible above the fold.
  const items: VideoItem[] = []
  for (let i = 0; feeds.some((f) => i < f.length); i++) {
    for (const feed of feeds) if (feed[i]) items.push(feed[i]!)
  }
  return c.json({ items })
})

// ── Universal clipper resolve: provider match first, yt-dlp fallback ───────────

videosRoute.post('/resolve', async (c) => {
  const { url } = await c.req.json<{ url?: string }>().catch(() => ({ url: undefined }))
  const trimmed = url?.trim()
  if (!trimmed) return c.json({ error: 'url required' }, 400)

  const hit = matchUrlToProvider(trimmed)
  if (hit) {
    const { provider, match } = hit
    if (match.kind === 'video') {
      try {
        const item = await provider.getItem(match.id)
        if (item) return c.json({ ok: true, kind: 'provider', match: 'video', source: provider.source, item })
      } catch { /* fall through to the generic path */ }
    } else if (match.kind === 'creator' && provider.getCreator) {
      try {
        const { creator } = await provider.getCreator(match.id)
        return c.json({ ok: true, kind: 'provider', match: 'creator', source: provider.source, creator })
      } catch { /* fall through */ }
    }
  }

  // No provider claimed it (or the provider failed): yt-dlp metadata dump, same as
  // the classic Clipper. This is also the paste-a-link path for Instagram/X today.
  try {
    const meta = await resolveClip(trimmed)
    return c.json({ ok: true, kind: 'clip', ...meta })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Could not resolve that link' }, 422)
  }
})

// ── Per-source endpoints (validated against the registry) ──────────────────────

videosRoute.get('/:source/browse', async (c) => {
  const provider = getProvider(c.req.param('source'))
  if (!provider?.browse) return c.json({ error: 'unknown source' }, 404)
  const user = c.get('user')
  const allowAdult = await allowAdultVideos(user.id)
  const page = await provider.browse({
    userId: user.id,
    feed: c.req.query('feed') ?? undefined,
    cursor: c.req.query('cursor') ?? null,
    allowAdult,
  })
  page.items = page.items.filter((it) => allowAdult || !it.isAdult)
  return c.json(page)
})

videosRoute.get('/:source/search', async (c) => {
  const provider = getProvider(c.req.param('source'))
  if (!provider?.search) return c.json({ error: 'unknown source' }, 404)
  const q = c.req.query('q')?.trim()
  if (!q) return c.json({ error: 'q required' }, 400)
  const user = c.get('user')
  const allowAdult = await allowAdultVideos(user.id)
  const page = await provider.search(q, { cursor: c.req.query('cursor') ?? null, allowAdult })
  page.items = page.items.filter((it) => allowAdult || !it.isAdult)
  return c.json(page)
})

videosRoute.get('/:source/creator/:id', async (c) => {
  const provider = getProvider(c.req.param('source'))
  if (!provider?.getCreator) return c.json({ error: 'unknown source' }, 404)
  const res = await provider.getCreator(c.req.param('id'), c.req.query('cursor') ?? null)
  const user = c.get('user')
  const allowAdult = await allowAdultVideos(user.id)
  if (!allowAdult && res.creator.isAdult) return c.json({ error: 'not available' }, 403)
  res.videos.items = res.videos.items.filter((it) => allowAdult || !it.isAdult)
  return c.json(res)
})

videosRoute.get('/:source/item/:id', async (c) => {
  const provider = getProvider(c.req.param('source'))
  if (!provider) return c.json({ error: 'unknown source' }, 404)
  const item = await provider.getItem(c.req.param('id'))
  if (!item) return c.json({ error: 'not found' }, 404)
  const user = c.get('user')
  if (item.isAdult && !(await allowAdultVideos(user.id))) return c.json({ error: 'not available' }, 403)
  return c.json({ item, playback: await provider.getPlayback(item.id) })
})

videosRoute.get('/:source/comments/:id', async (c) => {
  const provider = getProvider(c.req.param('source'))
  if (!provider?.getComments) return c.json({ error: 'unknown source' }, 404)
  return c.json({ comments: await provider.getComments(c.req.param('id')) })
})

export { videosRoute }
