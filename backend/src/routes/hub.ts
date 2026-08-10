// Client-facing hub discovery: "is this you?" and "what are all your addresses?".
//
// GET /api/hub/ping        unauthenticated, deliberately tiny. This is what a client
//                          fires at every cached address in parallel when it starts up,
//                          so it must be cheap and must not require a session (the
//                          client has no cookie for an address it has never used).
//                          It answers with the hub id and nothing else useful to a
//                          stranger: no address list, no version detail, no user data.
//
// GET /api/hub/endpoints   authenticated. The full address book, which a client caches
//                          to disk for its next cold start. Behind auth on purpose:
//                          the list names internal IPs and the tailnet host, and there
//                          is no reason for the open internet to read it off the public
//                          hostname.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { getHubInstanceId, getHubName } from '@/lib/hubIdentity'
import { listHubEndpoints } from '@/lib/hubEndpoints'
import { issueSession } from '@/lib/session'
import { issueDeviceToken, redeemDeviceToken, type DevicePlatform } from '@/lib/deviceToken'
import type { AppEnv } from '@/types'

const hub = new Hono<AppEnv>()

hub.get('/ping', async (c) => c.json({
  ok: true,
  instanceId: await getHubInstanceId(),
  name: await getHubName(),
}))

hub.get('/endpoints', requireAuth, async (c) => c.json({
  instanceId: await getHubInstanceId(),
  name: await getHubName(),
  // Which address this very request arrived on, so a client can tell where it
  // currently sits in its own priority list without guessing.
  servedFrom: new URL(c.req.url).origin,
  endpoints: await listHubEndpoints(),
}))

// ── Device tokens ─────────────────────────────────────────────────────────────
// Pair once (with a real session), then survive address changes forever after.

const PLATFORMS = new Set<DevicePlatform>(['desktop', 'tv', 'phone'])

/** Trade the current session for a device token. Called by native clients right after
 *  sign-in, including the Quick Connect path (the TV has a session by then). */
hub.post('/device/pair', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ label?: string; platform?: string }>().catch(() => ({}))
  const platform = PLATFORMS.has(body.platform as DevicePlatform)
    ? (body.platform as DevicePlatform)
    : 'phone'
  const { token, expiresAt } = await issueDeviceToken(user.id, body.label ?? 'A device', platform)
  return c.json({ token, expiresAt: expiresAt.toISOString(), instanceId: await getHubInstanceId() })
})

/** Trade a device token for a session cookie on THIS origin. No requireAuth: having
 *  the token is the credential, and the whole point is that the caller has no cookie
 *  for this address yet. */
hub.post('/device/session', async (c) => {
  const body = await c.req.json<{ token?: string; instanceId?: string }>().catch(() => ({}))
  if (!body.token) return c.json({ error: 'Missing token' }, 400)

  // A client that still thinks it is talking to a different hub must not be handed a
  // session here. Better a clean failure than a silent identity swap.
  const instanceId = await getHubInstanceId()
  if (body.instanceId && body.instanceId !== instanceId) {
    return c.json({ error: 'Different hub', instanceId }, 409)
  }

  const redeemed = await redeemDeviceToken(body.token, new URL(c.req.url).origin)
  if (!redeemed) return c.json({ error: 'Unauthorized' }, 401)

  await issueSession(c, redeemed.userId)
  return c.json({ ok: true, instanceId })
})

export default hub
