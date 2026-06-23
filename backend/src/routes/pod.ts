// Pod device management + pairing.
//   POST /api/pod/pair                 (no auth — the Pod calls with a code)
//   GET    /api/pod/devices            (admin) list devices
//   POST   /api/pod/devices            (admin) create a device → returns a pairing code
//   POST   /api/pod/devices/:id/pair-code (admin) re-issue a pairing code
//   DELETE /api/pod/devices/:id        (admin) remove a device

import { Hono } from 'hono'
import { requireAdmin } from '@/middleware/auth'
import type { AppEnv } from '@/types'
import {
  createDevice, listDevices, deleteDevice, refreshPairingCode, redeemPairingCode,
} from '@/lib/pod/devices'

const pod = new Hono<AppEnv>()

// ── Pod-facing: redeem a pairing code for a long-lived device token ──────────
// Unauthenticated by design — the code IS the credential. Rate-limiting/IP
// throttling can be layered later; codes are short, single-use, and expire.
pod.post('/pair', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { code?: string; capabilities?: unknown }
  if (!body.code || typeof body.code !== 'string') {
    return c.json({ error: 'code is required' }, 400)
  }
  const result = await redeemPairingCode(body.code, body.capabilities)
  if (!result) return c.json({ error: 'invalid or expired pairing code' }, 404)
  // The token is returned exactly once; the server only keeps its hash.
  return c.json(result)
})

// ── Admin: device CRUD ───────────────────────────────────────────────────────
pod.get('/devices', requireAdmin, async (c) => {
  const rows = await listDevices()
  // Never leak token hashes to the client.
  return c.json(rows.map(({ tokenHash: _t, ...rest }) => ({ ...rest, paired: _t != null })))
})

pod.post('/devices', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    userId?: string; name?: string; kind?: string; characterId?: string | null; wakeWord?: string | null
  }
  if (!body.userId || !body.name) return c.json({ error: 'userId and name are required' }, 400)
  const { device, pairingCode } = await createDevice({
    userId: body.userId,
    name: body.name,
    kind: body.kind,
    characterId: body.characterId ?? null,
    wakeWord: body.wakeWord ?? null,
  })
  const { tokenHash: _t, ...safe } = device
  return c.json({ device: { ...safe, paired: false }, pairingCode })
})

pod.post('/devices/:id/pair-code', requireAdmin, async (c) => {
  const code = await refreshPairingCode(c.req.param('id'))
  if (!code) return c.json({ error: 'device not found' }, 404)
  return c.json({ pairingCode: code })
})

pod.delete('/devices/:id', requireAdmin, async (c) => {
  await deleteDevice(c.req.param('id'))
  return c.json({ ok: true })
})

export { pod }
