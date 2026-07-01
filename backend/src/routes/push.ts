// Push subscription management — the client registers/removes its browser subscription
// here. Sending is server-initiated (see lib/push.ts) from wherever an alert originates
// (Frigate events today; briefing/timers can call the same helper later).

import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { pushSubscriptions } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { getVapidPublicKey } from '@/lib/push'
import type { AppEnv } from '@/types'

const push = new Hono<AppEnv>()

push.get('/vapid-public-key', async (c) => {
  return c.json({ publicKey: await getVapidPublicKey() })
})

push.post('/subscribe', requireAuth, async (c) => {
  const user = c.get('user')
  const body = (await c.req.json().catch(() => ({}))) as {
    endpoint?: string
    keys?: { p256dh?: string; auth?: string }
  }
  if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
    return c.json({ error: 'endpoint and keys.{p256dh,auth} are required' }, 400)
  }

  // Re-subscribing (e.g. a rotated push subscription) replaces the row for that endpoint.
  await db
    .insert(pushSubscriptions)
    .values({
      id: crypto.randomUUID(),
      userId: user.id,
      endpoint: body.endpoint,
      p256dhKey: body.keys.p256dh,
      authKey: body.keys.auth,
      createdAt: new Date(),
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId: user.id, p256dhKey: body.keys.p256dh, authKey: body.keys.auth },
    })

  return c.json({ ok: true })
})

push.post('/unsubscribe', requireAuth, async (c) => {
  const user = c.get('user')
  const body = (await c.req.json().catch(() => ({}))) as { endpoint?: string }
  if (!body.endpoint) return c.json({ error: 'endpoint is required' }, 400)
  await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.endpoint, body.endpoint), eq(pushSubscriptions.userId, user.id)))
  return c.json({ ok: true })
})

export { push }
