// Per-user scrobbling settings (ListenBrainz) + history backfill. The actual listen
// submission runs in lib/music/scrobble.ts's background flusher; these routes only
// manage the token/toggle and enqueue work.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import {
  backfillHistory, getScrobbleSettings, queueStatus, retryFailed,
  setScrobbleSettings, validateListenBrainzToken,
} from '@/lib/music/scrobble'
import type { AppEnv } from '@/types'

export const musicScrobble = new Hono<AppEnv>()
musicScrobble.use('*', requireAuth)

// Token is a secret: report configured-ness + a tail hint, never the value.
musicScrobble.get('/settings', async (c) => {
  const user = c.get('user')
  const s = await getScrobbleSettings(user.id)
  const q = await queueStatus(user.id)
  return c.json({
    enabled: s.enabled,
    tokenSet: Boolean(s.token),
    tokenHint: s.token ? `…${s.token.slice(-4)}` : null,
    queue: q,
  })
})

musicScrobble.put('/settings', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ token?: string | null; enabled?: boolean }>().catch(() => ({} as Record<string, never>))

  if (body.token !== undefined && body.token !== null && body.token.trim()) {
    // Validate before saving so a typo'd token fails loudly here, not silently in the queue.
    try {
      const lbUser = await validateListenBrainzToken(body.token.trim())
      await setScrobbleSettings(user.id, { token: body.token.trim() })
      if (body.enabled !== undefined) await setScrobbleSettings(user.id, { enabled: body.enabled })
      return c.json({ ok: true, listenBrainzUser: lbUser })
    } catch (err) {
      return c.json({ error: String(err instanceof Error ? err.message : err) }, 400)
    }
  }

  await setScrobbleSettings(user.id, {
    ...(body.token === null || body.token === '' ? { token: null } : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
  })
  return c.json({ ok: true })
})

// Queue every existing history row (batched + rate-limited by the flusher).
musicScrobble.post('/backfill', async (c) => {
  const user = c.get('user')
  try {
    const queued = await backfillHistory(user.id)
    return c.json({ queued })
  } catch (err) {
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 400)
  }
})

musicScrobble.post('/retry-failed', async (c) => {
  await retryFailed(c.get('user').id)
  return c.json({ ok: true })
})
