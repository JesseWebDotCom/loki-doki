// Per-user portability settings for Podcasts: the private RSS-out token (feed URLs for
// generated shows + radio recordings) and the gPodder app password AntennaPod syncs
// with. Session-authed; the token/password themselves are only handed to their owner.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { getOrCreateRssToken, regenerateRssToken, revokeRssToken, resolveRssToken } from '@/lib/podcast/rssOut'
import {
  generateGpodderPassword, gpodderPasswordSet, listDevices, revokeGpodderPassword,
} from '@/lib/podcast/gpodderStore'
import type { AppEnv } from '@/types'

export const podcastPortability = new Hono<AppEnv>()
podcastPortability.use('*', requireAuth)

// ── RSS out ─────────────────────────────────────────────────────────────────────────

// The token IS the credential, so it is only ever returned to its own user over an
// authenticated request. Creates one on first read so "Copy RSS feed" always works.
podcastPortability.get('/rss-token', async (c) => {
  const token = await getOrCreateRssToken(c.get('user').id)
  return c.json({ token })
})

podcastPortability.post('/rss-token/regenerate', async (c) => {
  const token = await regenerateRssToken(c.get('user').id)
  return c.json({ token })
})

podcastPortability.delete('/rss-token', async (c) => {
  await revokeRssToken(c.get('user').id)
  return c.json({ ok: true })
})

// Whether a feed URL is live right now (settings shows revoked vs active honestly).
podcastPortability.get('/rss-token/status', async (c) => {
  const user = c.get('user')
  const token = await getOrCreateRssToken(user.id)
  return c.json({ active: (await resolveRssToken(token)) === user.id })
})

// ── gPodder sync ────────────────────────────────────────────────────────────────────

podcastPortability.get('/gpodder', async (c) => {
  const user = c.get('user')
  const [configured, devices] = await Promise.all([
    gpodderPasswordSet(user.id),
    listDevices(user.id),
  ])
  return c.json({
    configured,
    username: user.nickname,
    devices: devices.map(d => ({ deviceId: d.deviceId, caption: d.caption, type: d.type, lastSeenAt: d.lastSeenAt })),
  })
})

// Generates a NEW app password and returns the plaintext exactly once (only the hash
// is stored). Never the profile PIN.
podcastPortability.post('/gpodder/password', async (c) => {
  const user = c.get('user')
  const password = await generateGpodderPassword(user.id)
  return c.json({ username: user.nickname, password })
})

podcastPortability.delete('/gpodder/password', async (c) => {
  await revokeGpodderPassword(c.get('user').id)
  return c.json({ ok: true })
})
