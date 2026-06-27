// Pod device management + pairing.
//   POST /api/pod/pair                 (no auth — the Pod calls with a code)
//   GET    /api/pod/devices            (admin) list devices
//   POST   /api/pod/devices            (admin) create a device → returns a pairing code
//   POST   /api/pod/devices/:id/pair-code (admin) re-issue a pairing code
//   DELETE /api/pod/devices/:id        (admin) remove a device

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { requireAdmin } from '@/middleware/auth'
import type { AppEnv } from '@/types'
import {
  createDevice, listDevices, deleteDevice, refreshPairingCode, redeemPairingCode, claimDevice,
} from '@/lib/pod/devices'
import { connectedDeviceIds, connectedActivity } from '@/lib/pod/registry'
import { listPending, getPending, removePending } from '@/lib/pod/pending'
import {
  getFirmwareStatus, detectSerialPorts, getPodWifi, setPodWifi, setServerHost,
  buildAndFlash, isFlashBusy,
} from '@/lib/pod/firmware'

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
  const online = connectedDeviceIds()
  const activity = connectedActivity()
  // Never leak token hashes to the client. `online` reflects a live gateway socket
  // right now; `activity` is the live conversation state (idle/listening/thinking/talking).
  return c.json(rows.map(({ tokenHash: _t, ...rest }) => ({
    ...rest,
    paired: _t != null,
    online: online.has(rest.id),
    activity: activity.get(rest.id) ?? 'idle',
  })))
})

pod.post('/devices', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    userId?: string; name?: string; kind?: string; characterId?: string | null; wakeWord?: string | null; model?: string | null
  }
  if (!body.userId || !body.name) return c.json({ error: 'userId and name are required' }, 400)
  const { device, pairingCode } = await createDevice({
    userId: body.userId,
    name: body.name,
    kind: body.kind,
    characterId: body.characterId ?? null,
    wakeWord: body.wakeWord ?? null,
    model: body.model ?? null,
  })
  const { tokenHash: _t, ...safe } = device
  return c.json({ device: { ...safe, paired: false }, pairingCode })
})

// ── One-tap claim for screenless devices ────────────────────────────────────
// Unclaimed Pods that have announced themselves on the gateway (no token yet).
pod.get('/discovered', requireAdmin, async (c) => {
  return c.json(listPending())
})

// Bind a discovered hardware id to a user, mint a token, and push it down the
// device's still-open socket. No pairing code to read off a screenless device.
pod.post('/devices/claim', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    hwid?: string; userId?: string; name?: string; kind?: string
    characterId?: string | null; wakeWord?: string | null; model?: string | null
  }
  if (!body.hwid || !body.userId || !body.name) {
    return c.json({ error: 'hwid, userId and name are required' }, 400)
  }
  const waiting = getPending(body.hwid)
  if (!waiting) return c.json({ error: 'device is no longer connected — power it on and retry' }, 404)

  const { device, token } = await claimDevice({
    hwid: body.hwid,
    userId: body.userId,
    name: body.name,
    kind: body.kind,
    characterId: body.characterId ?? null,
    wakeWord: body.wakeWord ?? null,
    model: body.model ?? waiting.model ?? null, // capture the make/model the device announced
  })
  // Deliver the token to the live socket + bind the session in place.
  await waiting.claim(device.id, token)
  removePending(body.hwid)

  const { tokenHash: _t, ...safe } = device
  return c.json({ device: { ...safe, paired: true, online: true } })
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

// ── Firmware: build + flash a device plugged into the server's USB ───────────
// (ESPHome install itself is dispatched via /api/admin/install/repair { componentId: 'esphome' }.)
pod.get('/firmware/status', requireAdmin, async (c) => c.json(await getFirmwareStatus()))

pod.get('/firmware/ports', requireAdmin, (c) => c.json({ ports: detectSerialPorts() }))

pod.get('/firmware/wifi', requireAdmin, async (c) => {
  const { ssid } = await getPodWifi()
  return c.json({ ssid, configured: !!ssid }) // never return the stored password
})

pod.put('/firmware/wifi', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { ssid?: string; password?: string; host?: string }
  if (!body.ssid) return c.json({ error: 'ssid is required' }, 400)
  await setPodWifi(body.ssid, body.password ?? '')
  if (body.host?.trim()) await setServerHost(body.host.trim())
  return c.json({ ok: true })
})

// Compile + flash over USB, streaming the ESPHome CLI output line-by-line as SSE.
pod.post('/firmware/flash', requireAdmin, async (c) => {
  if (isFlashBusy()) return c.json({ error: 'a flash is already in progress' }, 409)
  const body = (await c.req.json().catch(() => ({}))) as { port?: string; name?: string }
  return streamSSE(c, async (stream) => {
    const ctrl = new AbortController()
    stream.onAbort(() => ctrl.abort())
    const log = (line: string) => { void stream.writeSSE({ event: 'log', data: JSON.stringify({ line }) }) }
    try {
      await buildAndFlash({ port: body.port, name: body.name, onLine: log, signal: ctrl.signal })
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ ok: true }) })
    } catch (err) {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) })
    }
  })
})

export { pod }
