import { Hono } from 'hono'
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { eq, and, desc } from 'drizzle-orm'
import { db } from '@/db'
import { clips, mediaAssets } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { resolveClip } from '@/lib/clipper/resolve'
import { resolveDirectPlayUrl, NO_DIRECT_PLAY } from '@/lib/clipper/stream'
import { enqueueClipDownload } from '@/lib/downloadJobs'
import { blobAbsPath, acquireRead, releaseRead } from '@/lib/content/store'
import { assertPublicUrl } from '@/lib/ssrfGuard'
import type { AppEnv } from '@/types'

const clipperRoute = new Hono<AppEnv>()
clipperRoute.use('*', requireAuth)

/** Reject anything that isn't a plain http(s) URL before it can reach yt-dlp as an argument
 *  (a value starting with `-`/`--` is otherwise parsed as an option → --config-location →
 *  arbitrary options incl. --exec → RCE). Mirrors the guard on /resolve and /stream. */
function isHttpUrl(input: string): boolean {
  try {
    const u = new URL(input)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

// ── Resolve: preview metadata for a pasted URL, no DB write ─────────────────────

clipperRoute.post('/resolve', async (c) => {
  const { url } = await c.req.json<{ url?: string }>().catch(() => ({ url: undefined }))
  if (!url?.trim()) return c.json({ error: 'url required' }, 400)

  try {
    const meta = await resolveClip(url)
    return c.json({ ok: true, ...meta })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Could not resolve that link' }, 422)
  }
})

// ── Save: enqueue an offline download ────────────────────────────────────────────

clipperRoute.post('/save', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{
    url?: string; kind?: 'audio' | 'video'
    title?: string; thumbnailUrl?: string; durationSeconds?: number; extractor?: string
  }>().catch(() => ({}) as Record<string, never>)
  const url = body.url?.trim()
  if (!url) return c.json({ error: 'url required' }, 400)
  // Validate BEFORE the DB insert so a rejected URL leaves no orphaned `clips` row.
  if (!isHttpUrl(url)) return c.json({ error: 'That doesn\'t look like a valid URL.' }, 400)
  // Refuse internal targets: yt-dlp's generic extractor would otherwise fetch localhost /
  // cloud-metadata / LAN services on our behalf, and the result is readable via /file/:id.
  try {
    await assertPublicUrl(url)
  } catch {
    return c.json({ error: 'That URL isn\'t allowed.' }, 400)
  }
  const kind: 'audio' | 'video' = body.kind === 'audio' ? 'audio' : 'video'

  const id = crypto.randomUUID()
  const now = new Date()
  await db.insert(clips).values({
    id,
    userId: user.id,
    sourceUrl: url,
    extractor: body.extractor ?? null,
    title: body.title ?? '',
    thumbnailUrl: body.thumbnailUrl ?? null,
    durationSeconds: body.durationSeconds ?? null,
    kind,
    status: 'pending',
    assetId: null,
    sizeBytes: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  })

  await enqueueClipDownload(id, url, kind, body.title || url)
  return c.json({ ok: true, id })
})

// ── List: the user's saved clips, most recent first ─────────────────────────────

clipperRoute.get('/list', async (c) => {
  const user = c.get('user')
  const rows = await db.select().from(clips)
    .where(eq(clips.userId, user.id))
    .orderBy(desc(clips.createdAt))
  return c.json({ clips: rows })
})

// ── Direct-play stream proxy ──────────────────────────────────────────────────────
// Query ?url=<source url>. Resolves a progressive direct-play URL via yt-dlp and proxies
// bytes with Range passthrough, mirroring routes/youtube.ts's GET /stream/:videoId. Returns
// a { error: 'no-direct-play' } sentinel (409) when only HLS/fragmented formats exist, so
// the frontend can fall back to "Save" instead of attempting to play an m3u8 manifest.

clipperRoute.get('/stream', async (c) => {
  const url = c.req.query('url')?.trim()
  if (!url) return c.json({ error: 'url required' }, 400)

  let upstreamUrl: string | typeof NO_DIRECT_PLAY
  try {
    upstreamUrl = await resolveDirectPlayUrl(url)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Could not resolve a playable stream' }, 502)
  }
  if (upstreamUrl === NO_DIRECT_PLAY) {
    return c.json({ error: 'no-direct-play', message: 'Direct play isn\'t available for this link — save it instead.' }, 409)
  }

  // Abort the upstream fetch when the client disconnects (seek/close) so we don't keep
  // draining a connection into a dead socket.
  const ac = new AbortController()
  c.req.raw.signal.addEventListener('abort', () => ac.abort(), { once: true })

  const range = c.req.header('range')
  const fetchUpstream = () => fetch(upstreamUrl as string, {
    signal: AbortSignal.any([ac.signal, AbortSignal.timeout(30_000)]),
    headers: {
      ...(range ? { Range: range } : {}),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  })

  try {
    const upstream = await fetchUpstream()
    if (!upstream.ok && upstream.status !== 206) {
      return c.json({ error: `Upstream ${upstream.status}` }, 502)
    }

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
    return c.json({ error: 'Stream failed' }, 502)
  }
})

// ── Serve a saved (downloaded) clip ──────────────────────────────────────────────

clipperRoute.get('/file/:clipId', async (c) => {
  const user = c.get('user')
  const clipId = c.req.param('clipId')

  const [clip] = await db.select().from(clips)
    .where(and(eq(clips.id, clipId), eq(clips.userId, user.id)))
    .limit(1)
  if (!clip || clip.status !== 'ready' || !clip.assetId) return c.json({ error: 'Not found' }, 404)

  const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, clip.assetId)).limit(1)
  if (!asset || asset.status !== 'ready' || !asset.blobHash) return c.json({ error: 'Not found' }, 404)

  const absPath = await blobAbsPath(asset.blobHash)
  if (!existsSync(absPath)) return c.json({ error: 'File missing' }, 404)
  const contentType = asset.format === 'mp3' ? 'audio/mpeg' : asset.kind === 'audio' ? 'audio/mp4' : 'video/mp4'
  const hash = asset.blobHash
  const fileStat = await stat(absPath)

  // Range support for media players. Only honor a well-formed `bytes=start-end`; clamp to
  // the file size and reject impossible ranges — falling through to a full 200 without one.
  const rangeHeader = c.req.header('range')
  const rangeMatch = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null
  if (rangeMatch) {
    const size = fileStat.size
    let start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0
    let end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : size - 1
    if (Number.isNaN(start) || start < 0) start = 0
    if (Number.isNaN(end) || end >= size) end = size - 1
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    }
    const chunkSize = end - start + 1

    // Hold an in-flight read on this blob so GC can't unlink it mid-stream.
    acquireRead(hash)
    const { createReadStream } = await import('node:fs')
    const stream = createReadStream(absPath, { start, end })
    const release = () => releaseRead(hash)
    stream.once('close', release)
    stream.once('error', release)
    return new Response(stream as any, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(chunkSize),
        'Content-Type': contentType,
      },
    })
  }

  const buf = await readFile(absPath)
  return new Response(buf, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(fileStat.size),
      'Accept-Ranges': 'bytes',
    },
  })
})

export { clipperRoute }
