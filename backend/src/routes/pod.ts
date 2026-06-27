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
  createDevice, listDevices, deleteDevice, updateDevice, refreshPairingCode, redeemPairingCode, claimDevice,
} from '@/lib/pod/devices'
import { connectedDeviceIds, connectedActivity, speakToDevice } from '@/lib/pod/registry'
import { ensureCompanionWakeword } from '@/lib/pod/companionWake'
import { listPending, getPending, removePending } from '@/lib/pod/pending'
import {
  getFirmwareStatus, detectSerialPorts, getPodWifi, setPodWifi, setServerHost,
  buildAndFlash, isFlashBusy, detectDevice,
} from '@/lib/pod/firmware'
import {
  listGroups, createGroup, updateGroup, deleteGroup, assignDeviceGroup,
} from '@/lib/pod/deviceSettings'

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

pod.patch('/devices/:id', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string; userId?: string; characterId?: string | null; wakeWord?: string | null
  }
  const updated = await updateDevice(c.req.param('id'), {
    name: body.name?.trim() || undefined,
    userId: body.userId || undefined,
    characterId: body.characterId === undefined ? undefined : (body.characterId || null),
    wakeWord: body.wakeWord === undefined ? undefined : (body.wakeWord || null),
  })
  if (!updated) return c.json({ error: 'device not found' }, 404)
  // Assigning a companion? Kick off auto-training its wake word in the background so
  // the device answers to e.g. "Hey Loki" instead of the default — ready by next connect.
  if (updated.characterId && !updated.wakeWord) void ensureCompanionWakeword(updated.characterId)
  const { tokenHash: _t, ...safe } = updated
  return c.json({ device: { ...safe, paired: _t != null } })
})

pod.delete('/devices/:id', requireAdmin, async (c) => {
  await deleteDevice(c.req.param('id'))
  return c.json({ ok: true })
})

// Make a connected device speak a test phrase now (no wake word / LLM) — verifies
// the speaker/playback path and gives the admin a "Test" button per card.
pod.post('/devices/:id/test', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { text?: string }
  const text = body.text?.trim() || 'Hi! This is a test from your Loki Doki device. I am connected and working.'
  const ok = speakToDevice(c.req.param('id'), text)
  return ok ? c.json({ ok: true }) : c.json({ error: 'device is not connected' }, 409)
})

// ── Firmware: build + flash a device plugged into the server's USB ───────────
// (ESPHome install itself is dispatched via /api/admin/install/repair { componentId: 'esphome' }.)
pod.get('/firmware/status', requireAdmin, async (c) => c.json(await getFirmwareStatus()))

pod.get('/firmware/ports', requireAdmin, (c) => c.json({ ports: detectSerialPorts() }))

// Identify the plugged-in board (reads its ESP chip family) → the catalog model to
// flash, so the wizard auto-selects the right firmware. `model` is null if we can't
// map the chip (the UI then asks the installer to choose).
pod.get('/firmware/detect', requireAdmin, async (c) => {
  const detected = await detectDevice()
  return c.json(detected ?? { port: '', chip: 'unknown', model: null })
})

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
  const body = (await c.req.json().catch(() => ({}))) as { port?: string; name?: string; model?: string }
  return streamSSE(c, async (stream) => {
    const ctrl = new AbortController()
    stream.onAbort(() => ctrl.abort())
    const log = (line: string) => { void stream.writeSSE({ event: 'log', data: JSON.stringify({ line }) }) }
    try {
      await buildAndFlash({ port: body.port, name: body.name, model: body.model, onLine: log, signal: ctrl.signal })
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ ok: true }) })
    } catch (err) {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) })
    }
  })
})

// ── Device setting groups ───────────────────────────────────────────────────
// Central settings: a built-in Default group + admin groups that override it. A
// device belongs to one group; saving a group re-deploys to its online devices.

pod.get('/groups', requireAdmin, async (c) => c.json(await listGroups()))

pod.post('/groups', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string }
  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400)
  return c.json(await createGroup(body.name))
})

pod.put('/groups/:id', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; settings?: Record<string, unknown> }
  const g = await updateGroup(c.req.param('id'), body)  // re-deploys to affected devices
  return g ? c.json(g) : c.json({ error: 'unknown group' }, 404)
})

pod.delete('/groups/:id', requireAdmin, async (c) => {
  const ok = await deleteGroup(c.req.param('id'))
  return ok ? c.json({ ok: true }) : c.json({ error: 'cannot delete this group' }, 400)
})

// Assign a device to a group (null/'default' → built-in Default). Re-deploys it.
pod.put('/devices/:id/group', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { groupId?: string | null }
  await assignDeviceGroup(c.req.param('id'), body.groupId ?? null)
  return c.json({ ok: true })
})

export { pod }
