// Videos hub API: source-agnostic endpoints over the provider registry.
// YouTube-specific plumbing stays on /api/youtube; these routes serve the
// hub surfaces (mixed home, universal clipper resolve, per-source browse).

import { Hono } from 'hono'
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db } from '@/db'
import { mediaAssets, videoFollows, videoItems, videoSaves, videoWatchState } from '@/db/schema'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import { getProvider, listProviders, matchUrlToProvider } from '@/lib/videos/registry'
import { allowAdultVideos } from '@/lib/videos/policy'
import { enqueueVideoMedia } from '@/lib/downloadJobs'
import { redditPost } from '@/lib/videos/providers/reddit'
import { getRedditClientId, REDDIT_CLIENT_ID_KEY } from '@/lib/videos/redditAuth'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { blobAbsPath, acquireRead, releaseRead } from '@/lib/content/store'
import { resolveClip } from '@/lib/clipper/resolve'
import type { VideoItem, VideoSource } from '@/lib/videos/types'
import type { AppEnv } from '@/types'

const GENERIC_SOURCES = ['reddit', 'tiktok', 'vimeo'] as const
type GenericSource = (typeof GENERIC_SOURCES)[number]
const isGenericSource = (s: string): s is GenericSource => (GENERIC_SOURCES as readonly string[]).includes(s)

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
  const source = c.req.param('source')
  const provider = getProvider(source)
  if (!provider) return c.json({ error: 'unknown source' }, 404)
  const item = await provider.getItem(c.req.param('id'))
  if (!item) return c.json({ error: 'not found' }, 404)
  const user = c.get('user')
  if (item.isAdult && !(await allowAdultVideos(user.id))) return c.json({ error: 'not available' }, 403)
  // Rewrite playback for the client: upstream URLs (signed, Referer-gated) never leave
  // the server — progressive sources play through our stream proxy below.
  const playback = await provider.getPlayback(item.id)
  const clientPlayback = playback.mode === 'proxy-progressive'
    ? { mode: 'stream' as const, streamUrl: `/api/videos/${source}/stream/${encodeURIComponent(item.id)}` }
    : playback
  return c.json({ item, playback: clientPlayback })
})

// ── Progressive stream proxy: Range-forwarding fetch of the provider's upstream ──

videosRoute.get('/:source/stream/:id', async (c) => {
  const provider = getProvider(c.req.param('source'))
  if (!provider) return c.json({ error: 'unknown source' }, 404)
  const playback = await provider.getPlayback(c.req.param('id')).catch(() => null)
  if (!playback || playback.mode !== 'proxy-progressive') return c.json({ error: 'not streamable' }, 404)

  const ac = new AbortController()
  c.req.raw.signal.addEventListener('abort', () => ac.abort(), { once: true })
  const range = c.req.header('range')
  try {
    const upstream = await fetch(playback.upstreamUrl, {
      signal: AbortSignal.any([ac.signal, AbortSignal.timeout(30_000)]),
      headers: {
        ...(range ? { Range: range } : {}),
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        ...(playback.headers ?? {}),
      },
    })
    if (!upstream.ok && upstream.status !== 206) return c.json({ error: `upstream ${upstream.status}` }, 502)
    const headers = new Headers()
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h)
      if (v) headers.set(h, v)
    }
    if (!headers.has('accept-ranges')) headers.set('accept-ranges', 'bytes')
    if (!headers.has('content-type')) headers.set('content-type', 'video/mp4')
    headers.set('cache-control', 'private, max-age=0')
    return new Response(upstream.body, { status: upstream.status, headers })
  } catch {
    if (ac.signal.aborted) return new Response(null, { status: 499 })
    return c.json({ error: 'stream failed' }, 502)
  }
})

// ── Following feed: recent uploads from followed creators (poller-fed cache) ─────

videosRoute.get('/following-feed', async (c) => {
  const user = c.get('user')
  const source = c.req.query('source')
  const allowAdult = await allowAdultVideos(user.id)
  const follows = await db.select({ id: videoFollows.id }).from(videoFollows).where(and(
    eq(videoFollows.userId, user.id),
    ...(source && isGenericSource(source) ? [eq(videoFollows.source, source)] : []),
  ))
  if (follows.length === 0) return c.json({ items: [] })
  const rows = await db.select().from(videoItems)
    .where(inArray(videoItems.followId, follows.map((f) => f.id)))
    .orderBy(desc(videoItems.publishedAt), desc(videoItems.createdAt))
    .limit(120)
  const items = rows
    .filter((r) => allowAdult || !r.isAdult)
    .map((r) => ({
      source: r.source, id: r.externalId, url: r.url ?? '', title: r.title,
      creator: r.creatorId || r.creatorName ? { id: r.creatorId ?? '', name: r.creatorName ?? '' } : null,
      thumbnailUrl: r.thumbnailUrl, durationSec: r.durationSec,
      publishedAt: r.publishedAt ? r.publishedAt.getTime() : null,
      isAdult: r.isAdult, vertical: r.source === 'tiktok',
    }))
  return c.json({ items })
})

videosRoute.get('/:source/comments/:id', async (c) => {
  const provider = getProvider(c.req.param('source'))
  if (!provider?.getComments) return c.json({ error: 'unknown source' }, 404)
  return c.json({ comments: await provider.getComments(c.req.param('id')) })
})

// ── Follows (non-YouTube sources; yt_subscriptions stays authoritative for YouTube) ──

videosRoute.get('/follows', async (c) => {
  const user = c.get('user')
  const rows = await db.select().from(videoFollows)
    .where(eq(videoFollows.userId, user.id)).orderBy(desc(videoFollows.addedAt))
  return c.json({ follows: rows })
})

videosRoute.post('/follows', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ source?: string; externalId?: string }>().catch(() => ({}) as Record<string, never>)
  const source = body.source ?? ''
  const externalId = body.externalId?.trim()
  if (!isGenericSource(source) || !externalId) return c.json({ error: 'source and externalId required' }, 400)
  const provider = getProvider(source)
  if (!provider?.getCreator) return c.json({ error: 'source does not support follows' }, 400)

  const { creator } = await provider.getCreator(externalId)
  if (creator.isAdult && !(await allowAdultVideos(user.id))) {
    return c.json({ error: 'This community is not available on your content profile.' }, 403)
  }
  const now = new Date()
  const id = randomUUID()
  await db.insert(videoFollows).values({
    id, userId: user.id, source, kind: creator.kind === 'subreddit' ? 'subreddit' : creator.kind === 'channel' ? 'channel' : 'creator',
    externalId: creator.id, title: creator.name, handle: creator.handle ?? null,
    thumbnailUrl: creator.avatarUrl ?? null, description: creator.description ?? null,
    isAdult: !!creator.isAdult, lastFetchedAt: null, addedAt: now,
  }).onConflictDoNothing()
  return c.json({ ok: true, id })
})

videosRoute.patch('/follows/:id', async (c) => {
  const user = c.get('user')
  const body: { autoSave?: boolean; autoSaveKind?: 'audio' | 'video'; autoSaveKeep?: number | null } =
    await c.req.json().catch(() => ({}))
  const patch: Record<string, unknown> = {}
  if (typeof body.autoSave === 'boolean') patch.autoSave = body.autoSave
  if (body.autoSaveKind === 'audio' || body.autoSaveKind === 'video') patch.autoSaveKind = body.autoSaveKind
  if (body.autoSaveKeep === null || typeof body.autoSaveKeep === 'number') patch.autoSaveKeep = body.autoSaveKeep
  if (Object.keys(patch).length === 0) return c.json({ error: 'nothing to update' }, 400)
  await db.update(videoFollows).set(patch)
    .where(and(eq(videoFollows.id, c.req.param('id')), eq(videoFollows.userId, user.id)))
  return c.json({ ok: true })
})

videosRoute.delete('/follows/:id', async (c) => {
  const user = c.get('user')
  await db.delete(videoFollows)
    .where(and(eq(videoFollows.id, c.req.param('id')), eq(videoFollows.userId, user.id)))
  return c.json({ ok: true })
})

// ── Watch state (non-YouTube sources) ───────────────────────────────────────────

videosRoute.put('/watch-state', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ source?: string; videoId?: string; positionSec?: number; completed?: boolean }>().catch(() => ({}) as Record<string, never>)
  const source = body.source ?? ''
  if (!isGenericSource(source) || !body.videoId) return c.json({ error: 'source and videoId required' }, 400)
  const now = new Date()
  await db.insert(videoWatchState).values({
    id: randomUUID(), userId: user.id, source, videoId: body.videoId,
    positionSec: body.positionSec ?? 0, completed: !!body.completed, updatedAt: now,
  }).onConflictDoUpdate({
    target: [videoWatchState.userId, videoWatchState.source, videoWatchState.videoId],
    set: { positionSec: body.positionSec ?? 0, completed: !!body.completed, updatedAt: now },
  })
  return c.json({ ok: true })
})

// ── Saves: offline downloads for non-YouTube sources ────────────────────────────

videosRoute.get('/saves', async (c) => {
  const user = c.get('user')
  const source = c.req.query('source')
  const where = source && isGenericSource(source)
    ? and(eq(videoSaves.userId, user.id), eq(videoSaves.source, source))
    : eq(videoSaves.userId, user.id)
  const rows = await db.select().from(videoSaves).where(where).orderBy(desc(videoSaves.createdAt))
  const allowAdult = await allowAdultVideos(user.id)
  return c.json({ saves: allowAdult ? rows : rows.filter((r) => !r.isAdult) })
})

videosRoute.post('/:source/save', async (c) => {
  const user = c.get('user')
  const source = c.req.param('source')
  if (!isGenericSource(source)) return c.json({ error: 'unknown source' }, 404)
  const provider = getProvider(source)
  if (!provider) return c.json({ error: 'unknown source' }, 404)
  const body = await c.req.json<{ videoId?: string; kind?: 'audio' | 'video'; maxHeight?: number | null }>().catch(() => ({}) as Record<string, never>)
  if (!body.videoId) return c.json({ error: 'videoId required' }, 400)
  const kind: 'audio' | 'video' = body.kind === 'audio' ? 'audio' : 'video'
  if (!provider.capabilities.downloadKinds.includes(kind)) return c.json({ error: `${kind} not supported for ${source}` }, 400)

  const item = await provider.getItem(body.videoId)
  if (!item) return c.json({ error: 'not found' }, 404)
  if (item.isAdult && !(await allowAdultVideos(user.id))) return c.json({ error: 'not available' }, 403)

  const now = new Date()
  const id = randomUUID()
  await db.insert(videoSaves).values({
    id, userId: user.id, source, videoId: item.id, title: item.title, kind,
    status: 'pending', assetId: null, sizeBytes: null, maxHeight: body.maxHeight ?? null,
    thumbnailUrl: item.thumbnailUrl ?? null, creatorName: item.creator?.name ?? null,
    durationSec: item.durationSec ?? null, sourceUrl: item.url, auto: false,
    isAdult: !!item.isAdult, error: null, createdAt: now, updatedAt: now,
  }).onConflictDoUpdate({
    target: [videoSaves.userId, videoSaves.source, videoSaves.videoId, videoSaves.kind],
    set: { status: 'pending', error: null, updatedAt: now },
  })

  // Someone else in the household may already hold this rendition — attach instantly.
  const format = kind === 'audio' ? 'mp3' : 'mp4'
  const [ready] = await db.select().from(mediaAssets).where(and(
    eq(mediaAssets.sourceType, source), eq(mediaAssets.sourceId, item.id),
    eq(mediaAssets.kind, kind), eq(mediaAssets.format, format), eq(mediaAssets.status, 'ready'),
  )).limit(1)
  if (ready?.blobHash) {
    await db.update(videoSaves)
      .set({ status: 'ready', assetId: ready.id, sizeBytes: ready.sizeBytes, updatedAt: new Date() })
      .where(and(eq(videoSaves.userId, user.id), eq(videoSaves.source, source), eq(videoSaves.videoId, item.id), eq(videoSaves.kind, kind)))
  } else {
    await enqueueVideoMedia({ source, videoId: item.id, kind, maxHeight: body.maxHeight ?? null }, `${provider.label}: ${item.title}`)
  }
  return c.json({ ok: true, id })
})

videosRoute.delete('/saves/:id', async (c) => {
  const user = c.get('user')
  await db.delete(videoSaves)
    .where(and(eq(videoSaves.id, c.req.param('id')), eq(videoSaves.userId, user.id)))
  return c.json({ ok: true })  // orphaned assets are reclaimed by the store's GC sweep
})

// ── Serve a saved rendition (Range-capable, mirrors clipper's /file) ─────────────

videosRoute.get('/:source/file/:videoId/:kind', async (c) => {
  const user = c.get('user')
  const source = c.req.param('source')
  const kind = c.req.param('kind')
  if (!isGenericSource(source) || (kind !== 'audio' && kind !== 'video')) return c.json({ error: 'not found' }, 404)

  const [save] = await db.select().from(videoSaves).where(and(
    eq(videoSaves.userId, user.id), eq(videoSaves.source, source),
    eq(videoSaves.videoId, c.req.param('videoId')), eq(videoSaves.kind, kind),
  )).limit(1)
  if (!save || save.status !== 'ready' || !save.assetId) return c.json({ error: 'not found' }, 404)

  const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, save.assetId)).limit(1)
  if (!asset?.blobHash || asset.status !== 'ready') return c.json({ error: 'not found' }, 404)
  const absPath = await blobAbsPath(asset.blobHash)
  if (!existsSync(absPath)) return c.json({ error: 'file missing' }, 404)

  const contentType = asset.format === 'mp3' ? 'audio/mpeg' : 'video/mp4'
  const hash = asset.blobHash
  const fileStat = await stat(absPath)
  const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec((c.req.header('range') ?? '').trim())
  if (rangeMatch) {
    const size = fileStat.size
    let start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0
    let end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : size - 1
    if (Number.isNaN(start) || start < 0) start = 0
    if (Number.isNaN(end) || end >= size) end = size - 1
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    acquireRead(hash)
    const { createReadStream } = await import('node:fs')
    const stream = createReadStream(absPath, { start, end })
    const release = () => releaseRead(hash)
    stream.once('close', release)
    stream.once('error', release)
    return new Response(stream as unknown as BodyInit, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${fileStat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Content-Type': contentType,
      },
    })
  }
  const buf = await readFile(absPath)
  return new Response(buf, {
    headers: { 'Content-Type': contentType, 'Content-Length': String(fileStat.size), 'Accept-Ranges': 'bytes' },
  })
})

// ── Reddit HLS proxy (v.redd.it only) ───────────────────────────────────────────
// hls.js loads /api/videos/reddit/hls/:postId/manifest.m3u8; child playlist/segment
// URIs inside the manifest are relative, so the browser resolves them under the same
// proxy prefix and we forward each subpath to the post's v.redd.it base.

videosRoute.get('/reddit/hls/:postId/:path{.+}', async (c) => {
  const post = await redditPost(c.req.param('postId')).catch(() => null)
  const hls = post?.meta?.hlsUrl as string | undefined
  if (!hls) return c.json({ error: 'not found' }, 404)
  const user = c.get('user')
  if (post?.isAdult && !(await allowAdultVideos(user.id))) return c.json({ error: 'not available' }, 403)

  const base = new URL(hls)
  if (base.hostname !== 'v.redd.it') return c.json({ error: 'unsupported host' }, 502)

  const sub = c.req.param('path')
  // manifest.m3u8 is our alias for the post's actual manifest (keeps its auth query);
  // any other subpath is resolved relative to the manifest's directory.
  const upstream = sub === 'manifest.m3u8'
    ? base
    : new URL(sub + (c.req.url.includes('?') ? `?${c.req.url.split('?')[1]}` : ''), base)
  if (upstream.hostname !== 'v.redd.it') return c.json({ error: 'unsupported host' }, 502)

  const ac = new AbortController()
  c.req.raw.signal.addEventListener('abort', () => ac.abort(), { once: true })
  try {
    const res = await fetch(upstream, { signal: AbortSignal.any([ac.signal, AbortSignal.timeout(30_000)]) })
    if (!res.ok) return c.json({ error: `upstream ${res.status}` }, 502)
    const headers = new Headers()
    for (const h of ['content-type', 'content-length']) {
      const v = res.headers.get(h)
      if (v) headers.set(h, v)
    }
    headers.set('cache-control', 'private, max-age=30')
    return new Response(res.body, { status: 200, headers })
  } catch {
    if (ac.signal.aborted) return new Response(null, { status: 499 })
    return c.json({ error: 'stream failed' }, 502)
  }
})

// ── Source config (admin): Reddit app client id ────────────────────────────────

videosRoute.get('/config/reddit', requireAdmin, async (c) => {
  const clientId = await getRedditClientId()
  return c.json({ configured: !!clientId, clientId: clientId ?? '' })
})

videosRoute.put('/config/reddit', requireAdmin, async (c) => {
  const body: { clientId?: string } = await c.req.json().catch(() => ({}))
  await setAppSetting(REDDIT_CLIENT_ID_KEY, (body.clientId ?? '').trim())
  return c.json({ ok: true })
})

export { videosRoute }
