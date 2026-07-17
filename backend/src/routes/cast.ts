// Cast output routing API. Authenticated routes let the app list Cast devices and
// push the current track to one; the media proxy is public-but-tokenized so the
// Cast device (which carries no session) can fetch the audio over the LAN.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'
import { getServerHost } from '@/lib/pod/firmware'
import {
  castStatus, castToDevice, controlCast, disconnectCast, listDevices,
  mintMediaToken, resolveMediaToken, setCastVolume,
} from '@/lib/cast'

const port = parseInt(process.env.PORT ?? '3000')

// ── Public token media proxy (no session; Cast device fetches this) ────────────
export const castMedia = new Hono()

castMedia.get('/:token', async (c) => {
  const entry = resolveMediaToken(c.req.param('token'))
  if (!entry) return c.text('Not found', 404)
  // Re-fetch the real stream over localhost using the casting user's cookie, so
  // every existing auth-gated stream route works unchanged. Forward Range so the
  // Cast device can seek.
  const range = c.req.header('range')
  const upstream = await fetch(`http://127.0.0.1:${port}${entry.path}`, {
    headers: {
      cookie: entry.cookie,
      ...(range ? { range } : {}),
    },
  }).catch(() => null)
  if (!upstream || !upstream.body) return c.text('Upstream unavailable', 502)

  const headers = new Headers()
  headers.set('content-type', upstream.headers.get('content-type') ?? entry.contentType)
  headers.set('accept-ranges', 'bytes')
  for (const h of ['content-length', 'content-range']) {
    const v = upstream.headers.get(h)
    if (v) headers.set(h, v)
  }
  return new Response(upstream.body, { status: upstream.status, headers })
})

// ── Authenticated control routes ───────────────────────────────────────────────
export const cast = new Hono<AppEnv>()
cast.use('*', requireAuth)

cast.get('/devices', async (c) => {
  const force = c.req.query('refresh') === '1'
  return c.json({ devices: await listDevices(force) })
})

cast.get('/status', (c) => {
  const state = castStatus(c.get('user').id)
  return c.json(state ?? { device: null, status: null })
})

cast.post('/cast', async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => null) as {
    deviceId?: string
    streamPath?: string // same-origin path, e.g. /api/music/collection/local/stream/xyz
    contentType?: string
    title?: string
    subtitle?: string
    artworkUrl?: string // same-origin path
  } | null
  if (!body?.deviceId || !body.streamPath) return c.json({ ok: false, error: 'deviceId and streamPath are required.' }, 400)
  if (!body.streamPath.startsWith('/api/')) return c.json({ ok: false, error: 'Invalid stream path.' }, 400)

  const cookie = c.req.header('cookie') ?? ''
  const contentType = body.contentType || 'audio/mpeg'
  const host = await getServerHost()
  const base = `http://${host}:${port}`
  const mediaToken = mintMediaToken(body.streamPath, cookie, contentType)
  const url = `${base}/api/cast-media/${mediaToken}`
  // Artwork can be served straight from the same-origin path (public-ish image
  // routes) made absolute; if it needs auth it simply won't render on the device.
  const artworkUrl = body.artworkUrl?.startsWith('/') ? `${base}${body.artworkUrl}` : body.artworkUrl

  try {
    const status = await castToDevice(user.id, body.deviceId, {
      url, contentType, title: body.title, subtitle: body.subtitle, artworkUrl,
    })
    return c.json({ ok: true, status })
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : 'Could not cast to that device.' }, 502)
  }
})

cast.post('/control', async (c) => {
  const body = await c.req.json().catch(() => null) as { action?: string; volume?: number } | null
  const userId = c.get('user').id
  if (body?.action && ['play', 'pause', 'stop'].includes(body.action)) {
    const status = controlCast(userId, body.action as 'play' | 'pause' | 'stop')
    if (body.action === 'stop') disconnectCast(userId)
    return c.json({ ok: true, status })
  }
  if (typeof body?.volume === 'number') {
    return c.json({ ok: true, status: setCastVolume(userId, body.volume) })
  }
  return c.json({ ok: false, error: 'Nothing to do.' }, 400)
})

cast.post('/disconnect', (c) => {
  disconnectCast(c.get('user').id)
  return c.json({ ok: true })
})
