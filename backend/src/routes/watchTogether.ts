// Watch Together (SyncPlay) — synced household co-watching. A session is created from a
// watch page, other people join over SSE (deep link or the live invite toast), and
// play/pause/seek from any member drives everyone. See lib/watchTogether.ts for the model.

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { ne } from 'drizzle-orm'
import type { AppEnv } from '@/types'
import { requireAuth } from '@/middleware/auth'
import { db } from '@/db'
import { users } from '@/db/schema'
import { pushToBrowserSession } from '@/lib/pod/browserSession'
import {
  createSession, getSession, joinSession, listSessions, setMedia, setState, endSession,
  type WtEvent, type WtMedia,
} from '@/lib/watchTogether'

const watchTogether = new Hono<AppEnv>()

function displayName(u: { nickname: string; firstName: string }): string {
  return (u.nickname || u.firstName || 'Someone').slice(0, 40)
}

function parseMedia(raw: unknown): WtMedia | null {
  const m = raw as Partial<WtMedia> | null
  if (!m || typeof m.source !== 'string' || typeof m.videoId !== 'string' || typeof m.title !== 'string') return null
  if (!m.source.trim() || !m.videoId.trim()) return null
  return {
    source: m.source.trim().slice(0, 20),
    videoId: m.videoId.trim().slice(0, 200),
    title: m.title.trim().slice(0, 300) || 'A video',
    thumbnailUrl: typeof m.thumbnailUrl === 'string' ? m.thumbnailUrl.slice(0, 2000) : null,
  }
}

// POST /api/watch-together/sessions — start a session for the video you're watching.
watchTogether.post('/sessions', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => ({})) as { media?: unknown }
  const media = parseMedia(body.media)
  if (!media) return c.json({ error: 'media required' }, 400)
  const session = createSession(user.id, displayName(user), media)
  return c.json({ session })
})

// GET /api/watch-together/sessions — active household sessions (the "join" pill).
watchTogether.get('/sessions', requireAuth, (c) => {
  return c.json({ sessions: listSessions() })
})

watchTogether.get('/sessions/:id', requireAuth, (c) => {
  const session = getSession(c.req.param('id'))
  if (!session) return c.json({ error: 'not found' }, 404)
  return c.json({ session })
})

// GET /api/watch-together/sessions/:id/stream — the member channel. Joining IS opening
// this stream; leaving is closing it. The hello event carries the state snapshot.
watchTogether.get('/sessions/:id/stream', requireAuth, (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    const send = (evt: WtEvent) => {
      void stream.writeSSE({ event: 'wt', data: JSON.stringify(evt) }).catch(() => {})
    }
    const joined = joinSession(id, { userId: user.id, name: displayName(user), send })
    if (!joined) {
      await stream.writeSSE({ event: 'wt', data: JSON.stringify({ type: 'ended' }) }).catch(() => {})
      return
    }
    send(joined.hello)
    try {
      while (!stream.closed) {
        await stream.sleep(30_000)
        if (stream.closed) break
        await stream.writeSSE({ event: 'ping', data: '' }).catch(() => {})
      }
    } finally {
      joined.leave()
    }
  })
})

// POST /api/watch-together/sessions/:id/state — a member's play/pause/seek.
watchTogether.post('/sessions/:id/state', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({})) as { memberId?: string; playing?: boolean; positionSec?: number }
  if (typeof body.memberId !== 'string' || typeof body.playing !== 'boolean' || !Number.isFinite(body.positionSec)) {
    return c.json({ error: 'memberId, playing, positionSec required' }, 400)
  }
  const ok = setState(c.req.param('id'), body.memberId, body.playing, body.positionSec as number)
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
})

// POST /api/watch-together/sessions/:id/media — the room moved to another video.
watchTogether.post('/sessions/:id/media', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({})) as { memberId?: string; media?: unknown }
  const media = parseMedia(body.media)
  if (typeof body.memberId !== 'string' || !media) return c.json({ error: 'memberId, media required' }, 400)
  const ok = setMedia(c.req.param('id'), body.memberId, media)
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
})

// POST /api/watch-together/sessions/:id/end — host tears the room down for everyone.
watchTogether.post('/sessions/:id/end', requireAuth, (c) => {
  return endSession(c.req.param('id')) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
})

// POST /api/watch-together/sessions/:id/invite — live "come watch with me" toast on every
// other household member's most recent open tab. Content ceilings still apply when the
// invitee's watch page loads (the item endpoint hard-gates), so an invite can never play
// something the profile isn't allowed to see.
watchTogether.post('/sessions/:id/invite', requireAuth, async (c) => {
  const user = c.get('user')
  const session = getSession(c.req.param('id'))
  if (!session) return c.json({ error: 'not found' }, 404)
  const path = `/videos/${session.media.source}/watch/${encodeURIComponent(session.media.videoId)}?wt=${session.id}`
  const others = await db.select({ id: users.id }).from(users).where(ne(users.id, user.id))
  let notified = 0
  for (const other of others) {
    if (pushToBrowserSession(other.id, {
      type: 'watch_invite', path,
      payload: { title: session.media.title, fromName: displayName(user) },
    })) notified++
  }
  return c.json({ notified })
})

export { watchTogether }
