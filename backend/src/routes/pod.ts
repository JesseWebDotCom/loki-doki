// Pod device management + pairing.
//   POST /api/pod/pair                 (no auth — the Pod calls with a code)
//   GET    /api/pod/devices            (admin) list devices
//   POST   /api/pod/devices            (admin) create a device → returns a pairing code
//   POST   /api/pod/devices/:id/pair-code (admin) re-issue a pairing code
//   DELETE /api/pod/devices/:id        (admin) remove a device

import { Hono } from 'hono'
import { streamSSE, stream } from 'hono/streaming'
import { requireAdmin, requireAuth } from '@/middleware/auth'
import { logger } from '@/lib/logger'
import { buildControllerAtlas, resolveLocalArt, renderPodcastCoverForShow } from '@/lib/pod/controllerAtlas'
import type { AppEnv } from '@/types'
import {
  createDevice, listDevices, deleteDevice, updateDevice, refreshPairingCode, redeemPairingCode, claimDevice,
} from '@/lib/pod/devices'
import { connectedDeviceIds, connectedActivity, speakToDevice, orientToDevice } from '@/lib/pod/registry'
import { ensureCompanionWakeword } from '@/lib/pod/companionWake'
import { listPending, getPending, removePending } from '@/lib/pod/pending'
import {
  getFirmwareStatus, detectSerialPorts, getPodWifi, setPodWifi, setServerHost,
  buildAndFlash, isFlashBusy, resetFlashState, detectDevice, validateFirmware,
} from '@/lib/pod/firmware'
import {
  listGroups, createGroup, updateGroup, deleteGroup, assignDeviceGroup,
} from '@/lib/pod/deviceSettings'
import { captureDeviceFrame, deviceByHwid, setDeviceOrientation } from '@/lib/pod/displayRenderer'
import { rendererForTemplateId, DEFAULT_TEMPLATE_ID } from '@/lib/pod/deviceStudio'
import { resolveDevicePhotoUrl } from '@/lib/pod/displayData'
import { getNowPlaying } from '@/lib/pod/nowPlaying'
import { deviceDisplayMode, setDeviceCamera, setDeviceAuto, fetchCameraFrame, getPodView, setPodView, isValidPodView, type DeviceDisplayMode } from '@/lib/pod/displayController'
import { getUserPresence, setUserStatus, clearUserStatus, setUserSleep, setUserAlert, clearUserAlert, STATUS_COLORS, STATUS_LABELS, type StatusState } from '@/lib/pod/presence'
import { latestLivingRoomFrame } from '@/lib/pod/cameraStream'
import { startFfmpegTest, startFfmpegSource, startUrlTest, stopTest, isTestActive } from '@/lib/pod/cameraTest'
import { livingRoomMjpegUrl } from '@/lib/pod/cameraStream'
import { setPacing, cameraStats, deviceStreamHealth } from '@/lib/pod/cameraUdp'
import { getDeviceMode, setDeviceMode, isDisplayMode, DISPLAY_MODES } from '@/lib/pod/displayMode'
import { gatewayStatus, restartPodGateway } from '@/lib/pod/gateway'

const pod = new Hono<AppEnv>()

// The AbortController of the in-flight firmware flash (one at a time), so a new flash
// request can take over a stale/abandoned one (see /firmware/flash).
let podFlashAbort: AbortController | null = null

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

// ── Pod-facing: server-rendered ambient display ──────────────────────────────
// The firmware's `online_image` GETs this a few times a second and blits it to the
// screen. Identified by hwid (the device knows its own MAC); unauthenticated by the
// same LAN-appliance trust model as claim-by-hwid — the device must already exist
// and be bound to a user. Returns a JPEG of that user's /display page.
pod.get('/display/:hwid', async (c) => {
  const dev = await deviceByHwid(c.req.param('hwid'))
  if (!dev) return c.json({ error: 'unknown device' }, 404)

  // Server decides the content: a manually-set camera, else the ambient web page.
  const mode = deviceDisplayMode(dev.id)
  let frame: Buffer | null = null
  if (mode.mode === 'camera' && mode.cameraUrl) {
    frame = await fetchCameraFrame(mode.cameraUrl)
  }
  // Native-LVGL devices draw their own dashboard — never server-render the page for them
  // (the experiment's whole point). Camera mode still wins (admin test override).
  if (!frame && rendererForTemplateId(dev.layoutTemplateId ?? DEFAULT_TEMPLATE_ID) === 'lvgl') {
    return c.body(null, 204)
  }
  if (!frame) frame = await captureDeviceFrame(dev.id, dev.userId) // fallback to clock/weather

  if (!frame) return c.json({ error: 'display rendering unavailable' }, 503)
  return new Response(new Uint8Array(frame), {
    status: 200,
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' },
  })
})

// Continuous frame STREAM over one connection — the hw_jpeg firmware reads
// [uint32 LE length][jpeg bytes] repeatedly and hardware-decodes each. Avoids the
// per-frame HTTP connection overhead that capped the poll path at a few fps.
pod.get('/display/:hwid/stream', async (c) => {
  const dev = await deviceByHwid(c.req.param('hwid'))
  if (!dev) return c.json({ error: 'unknown device' }, 404)
  // Native-LVGL devices render their own dashboard — no server pixels (unless an admin
  // manual-camera override is active). Close the stream so the device falls back to native.
  if (deviceDisplayMode(dev.id).mode !== 'camera' &&
      rendererForTemplateId(dev.layoutTemplateId ?? DEFAULT_TEMPLATE_ID) === 'lvgl') {
    return c.body(null, 204)
  }
  c.header('Content-Type', 'application/octet-stream')
  c.header('Cache-Control', 'no-store')
  return stream(c, async (s) => {
    let alive = true
    s.onAbort(() => { alive = false })
    const header = new Uint8Array(4)
    const view = new DataView(header.buffer)
    while (alive) {
      const mode = deviceDisplayMode(dev.id)
      let frame: Buffer | null = null
      if (mode.mode === 'camera' && mode.cameraUrl) frame = await fetchCameraFrame(mode.cameraUrl)
      if (!frame) frame = await captureDeviceFrame(dev.id, dev.userId)
      if (frame) {
        view.setUint32(0, frame.length, true)
        await s.write(header)
        await s.write(new Uint8Array(frame))
      }
      await s.sleep(55)  // ~caps the rate; real limit is render + device decode/transfer
    }
  })
})

// ── Pod-facing: per-user IMAGE for the native LVGL dashboard ──────────────────
// The device's `online_image` GETs this (URL: /api/pod/image/<mac>.jpg) and hardware-
// decodes it into an LVGL image widget — the path for family photos. Unauthenticated by
// the same LAN-appliance trust as /display (the device must exist + have a photo set).
//
// MULTI-IMAGE (stream-deck thumbnails): the controller has many button images, not one.
// The same channel will serve a THUMBNAIL ATLAS — a single tiled JPEG of every button
// icon — so the device does ONE fetch + ONE hardware-decode and each LVGL button points
// at its tile (sub-region) of the decoded buffer. That keeps N images cheap. Pass 1
// implements the single-photo case; `?kind=thumbs` is reserved for the atlas.
pod.get('/image/:hwid', async (c) => {
  // The hwid carries an image extension in the device's URL (…/<mac>.jpg); strip it.
  const raw = c.req.param('hwid').replace(/\.(jpe?g|png|webp)$/i, '')
  const url = await resolveDevicePhotoUrl(raw)
  if (!url) return c.body(null, 404)
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!r.ok) return c.body(null, 404)
    const ct = r.headers.get('content-type') ?? 'image/jpeg'
    const buf = Buffer.from(await r.arrayBuffer())
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: { 'Content-Type': ct, 'Cache-Control': 'no-store' },
    })
  } catch {
    return c.body(null, 404)
  }
})

// Controller thumbnail ATLAS: every button's artwork composited into one grid image so the
// native stream-deck device fetches it ONCE and shows each cell its tile (offset + clip).
pod.get('/controller-atlas/:hwid', async (c) => {
  const raw = c.req.param('hwid').replace(/\.(jpe?g|png|webp)$/i, '')
  const dev = await deviceByHwid(raw)
  if (!dev) return c.body(null, 404)
  try {
    const atlas = await buildControllerAtlas(dev.id, dev.userId, new URL(c.req.url).origin)
    c.header('Content-Type', 'image/jpeg')
    c.header('Cache-Control', 'no-store')
    return c.body(atlas)
  } catch (e) {
    logger.warn(`[pod] controller atlas failed: ${(e as Error).message}`)
    return c.body(null, 500)
  }
})

// The current now-playing COVER art for a device's user, proxied for the device's native
// media-player bar (the device can't reach the remote art host directly). 404 when nothing
// is playing → the device keeps its placeholder. LAN-trust like /image (keyed by hwid).
pod.get('/cover/:hwid', async (c) => {
  const raw = c.req.param('hwid').replace(/\.(jpe?g|png|webp)$/i, '')
  const dev = await deviceByHwid(raw)
  if (!dev) return c.body(null, 404)
  let url = getNowPlaying(dev.userId)?.cover?.trim()
  if (!url) return c.body(null, 404)
  // Podcast cover → the show's uploaded art OR its generated ShowCover fallback (so a
  // now-playing podcast always shows art on the player bar, matching the app).
  const pm = url.match(/\/api\/podcasts\/shows\/([^/?]+)\/cover/)
  if (pm) {
    const b = await renderPodcastCoverForShow(pm[1])
    return b
      ? new Response(new Uint8Array(b), { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } })
      : c.body(null, 404)
  }
  // Station icons are auth-gated local files — read them off disk directly.
  const local = await resolveLocalArt(url)
  if (local) {
    return new Response(new Uint8Array(local), {
      status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' },
    })
  }
  // Cover URLs usually point at our AUTH-GATED image proxies (/api/youtube/img?u=…,
  // /api/img?url=…). A server-side fetch has no auth cookie → 401, so unwrap the real
  // target from the ?u=/?url= query and fetch it directly. Otherwise make it absolute.
  try {
    const inner = new URL(url, 'http://x').searchParams.get('u') || new URL(url, 'http://x').searchParams.get('url')
    if (inner && /^https?:\/\//i.test(inner)) url = inner
  } catch { /* not a parseable url */ }
  if (url.startsWith('/')) url = new URL(c.req.url).origin + url
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) })
    if (!r.ok) return c.body(null, 404)
    const buf = Buffer.from(await r.arrayBuffer())
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: { 'Content-Type': r.headers.get('content-type') ?? 'image/jpeg', 'Cache-Control': 'no-store' },
    })
  } catch {
    return c.body(null, 404)
  }
})

// ── Pod-facing: living-room camera perf test ─────────────────────────────────
// Returns the freshest living-room frame straight from the persistent Frigate MJPEG
// cache (no per-request upstream fetch), so the device's hw_jpeg loop can hammer this
// flat-out and the on-screen FPS counter reflects the device's real ceiling. LAN-trust
// like /display (no MAC needed — it's a single shared test feed).
pod.get('/camera-test', async (c) => {
  const frame = await latestLivingRoomFrame()
  if (!frame) return c.json({ error: 'camera unavailable' }, 503)
  return new Response(new Uint8Array(frame), {
    status: 200,
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' },
  })
})

// Continuous PUSH stream of living-room frames over ONE connection: [uint32 LE
// length][jpeg bytes] repeated. The device opens this once and reads frame after
// frame — no per-request round-trip (which over the C6/SDIO bridge was the ~2 fps
// wall). Backpressure paces it to whatever the device can decode.
pod.get('/camera-test/stream', async (c) => {
  c.header('Content-Type', 'application/octet-stream')
  c.header('Cache-Control', 'no-store')
  return stream(c, async (s) => {
    let alive = true
    s.onAbort(() => { alive = false })
    const header = new Uint8Array(4)
    const view = new DataView(header.buffer)
    while (alive) {
      const frame = await latestLivingRoomFrame()
      if (frame) {
        view.setUint32(0, frame.length, true)
        await s.write(header)
        await s.write(new Uint8Array(frame))
      }
      await s.sleep(20) // ~50fps ceiling; TCP backpressure throttles to device speed
    }
  })
})

// Server-side camera rate stats (source-fps it's receiving, sent-fps it's pushing).
pod.get('/camera-test/stats', (c) => c.json(cameraStats()))

// Per-device camera stream health for Admin → Devices: the full source→sent→received→
// decoded chain + loss% per Pod. loss% is the health signal; <35 ok, <60 warn, else bad.
pod.get('/devices/stream-health', requireAdmin, async (c) => {
  const health = deviceStreamHealth()
  const devs = await listDevices()
  const norm = (s: string) => s.replace(/[^a-f0-9]/gi, '').toLowerCase()
  const rows = health.map((h) => {
    const dev = devs.find((d) => d.hwid && norm(d.hwid) === norm(h.mac))
    const status = h.lossPct < 35 ? 'ok' : h.lossPct < 60 ? 'warn' : 'bad'
    return { ...h, deviceId: dev?.id ?? null, name: dev?.name ?? null, status }
  })
  return c.json({ devices: rows })
})

// ── Admin: per-device SCREEN MODE (Testing tab) ───────────────────────────────
// Switches a screen Pod's whole UI over its live Wyoming socket:
//   normal      → ambient clock dashboard (shipping default)
//   camera-test → full-screen camera (public test feed + generated fallback)
//   touch-test  → blue screen, pink dot where you press
// GET returns the device's current mode + whether it's online. POST sets it (and
// pushes live; an offline device picks it up on reconnect).
pod.get('/devices/:id/mode', requireAdmin, (c) => {
  return c.json({ mode: getDeviceMode(c.req.param('id')) })
})

pod.post('/devices/:id/mode', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { mode?: string }
  if (!isDisplayMode(body.mode)) {
    return c.json({ error: `mode must be one of ${DISPLAY_MODES.join(', ')}` }, 400)
  }
  const online = setDeviceMode(c.req.param('id'), body.mode)
  return c.json({ ok: true, mode: body.mode, online })
})

// Live-tune UDP fragment pacing (no restart): POST { batch, pace }.
pod.post('/camera-test/pacing', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { batch?: number; pace?: number }
  return c.json(setPacing(b.batch, b.pace))
})

// ── Pod camera TEST source switch (perf testing only) ─────────────────────────
// POST { mode: 'ffmpeg', fps?, w?, h?, q? }  → generated moving pattern at N fps
// POST { mode: 'urls', urls: [..] }          → rotate through public MJPEG URLs
// POST { mode: 'frigate' }                   → back to the living-room camera
// LAN-trust like the other /camera-test endpoints so it can be driven without a session.
pod.post('/camera-test/source', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as
    { mode?: string; fps?: number; w?: number; h?: number; q?: number; urls?: string[] }
  if (b.mode === 'ffmpeg') startFfmpegTest(b.fps ?? 30, b.w ?? 640, b.h ?? 360, b.q ?? 6)
  else if (b.mode === 'urls' && Array.isArray(b.urls) && b.urls.length) startUrlTest(b.urls)
  else {
    // 'frigate' | 'frigate-hd' | default → the real camera scaled to native panel size on
    // the server, so the device decodes fullscreen with no upscale (decoded≈received).
    const url = await livingRoomMjpegUrl()
    if (url) startFfmpegSource(url, b.w ?? 1280, b.h ?? 720, b.fps ?? 25, b.q ?? 12)
    else stopTest()
  }
  return c.json({ ok: true, mode: b.mode ?? 'frigate-hd' })
})

// ── Admin: drive a device's screen (manual camera test) ───────────────────────
// POST { mode: 'auto' } → back to the clock/weather page.
// POST { mode: 'camera', url } → show that camera's live frames full-screen.
pod.post('/devices/:id/display', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => ({}))) as { mode?: string; url?: string; holdMs?: number }
  if (body.mode === 'camera') {
    if (!body.url?.trim()) return c.json({ error: 'url is required for camera mode' }, 400)
    setDeviceCamera(id, body.url.trim(), body.holdMs)
  } else {
    setDeviceAuto(id)
  }
  return c.json({ ok: true, mode: deviceDisplayMode(id) })
})

// ── Presence & status ────────────────────────────────────────────────────────────
// GET  /api/pod/presence?deviceId=   — returns { status, sleep, nowPlaying, plexActivity }
// POST /api/pod/status               — set status (state, label?, color?, durationMin?)
// DELETE /api/pod/status             — clear status
// POST /api/pod/sleep                — enter/exit sleep mode

pod.get('/presence', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  // If a deviceId is provided, resolve the owner (for the headless display page which
  // is not authenticated as the device's user).
  const deviceId = c.req.query('deviceId')
  let userId = user.id
  if (deviceId) {
    const { db: dbInst } = await import('@/db')
    const { devices } = await import('@/db/schema')
    const { eq } = await import('drizzle-orm')
    const [dev] = await dbInst.select({ userId: devices.userId }).from(devices).where(eq(devices.id, deviceId)).limit(1)
    if (dev) userId = dev.userId
  }
  const presence = await getUserPresence(userId)
  return c.json(presence)
})

pod.post('/status', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  const body = (await c.req.json().catch(() => ({}))) as {
    state?: string; label?: string; color?: string; durationMin?: number
  }
  const validStates: StatusState[] = ['available', 'busy', 'dnd', 'on_call', 'in_meeting', 'focusing', 'brb', 'away', 'custom']
  if (!body.state || !validStates.includes(body.state as StatusState)) {
    return c.json({ error: 'invalid state' }, 400)
  }
  const status = await setUserStatus(user.id, {
    state: body.state as StatusState,
    label: body.label,
    color: body.color,
    durationMin: body.durationMin,
    source: 'manual',
  })
  // Fire status_set chime on all connected hardware Pods for this user.
  const { podsForUser } = await import('@/lib/pod/registry')
  for (const pod of podsForUser(user.id)) { try { pod.playSound('status_set') } catch { /* offline */ } }
  return c.json({ ok: true, status })
})

pod.delete('/status', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  await clearUserStatus(user.id)
  const { podsForUser } = await import('@/lib/pod/registry')
  for (const pod of podsForUser(user.id)) { try { pod.playSound('status_clear') } catch { /* offline */ } }
  return c.json({ ok: true })
})

pod.post('/sleep', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  const body = (await c.req.json().catch(() => ({}))) as {
    active?: boolean; dimBrightness?: number; ambientSound?: string; ambientVolume?: number
  }
  const active = body.active !== false  // default true
  const sleep = await setUserSleep(user.id, {
    active,
    dimBrightness: body.dimBrightness,
    ambientSound: (body.ambientSound as 'rain' | 'white_noise' | 'ocean' | 'fan' | null) ?? null,
    ambientVolume: body.ambientVolume,
    source: 'manual',
  })
  const { podsForUser } = await import('@/lib/pod/registry')
  const chime = active ? 'sleep_enter' : 'wake_chime'
  for (const pod of podsForUser(user.id)) { try { pod.playSound(chime) } catch { /* offline */ } }
  return c.json({ ok: true, sleep })
})

// ── User alert (ephemeral overlay on screen-Pod displays) ────────────────────────
// POST /api/pod/alert  { emoji, message, color?, ttlSec? }
// DELETE /api/pod/alert
pod.post('/alert', async (c) => {
  const user = c.get('user')
  if (!user?.id) return c.json({ error: 'not authenticated' }, 401)
  const body = (await c.req.json().catch(() => ({}))) as {
    emoji?: string; message?: string; color?: string; ttlSec?: number
  }
  if (!body.message) return c.json({ error: 'message required' }, 400)
  const alert = setUserAlert(user.id, {
    emoji: body.emoji ?? '🔔',
    message: body.message,
    color: body.color ?? '#1d4ed8',
    source: 'api',
    ttlSec: body.ttlSec,
  })
  return c.json({ ok: true, alert })
})

pod.delete('/alert', async (c) => {
  const user = c.get('user')
  if (!user?.id) return c.json({ error: 'not authenticated' }, 401)
  clearUserAlert(user.id)
  return c.json({ ok: true })
})

// ── Per-device pod view (display / activity / status / sleeping) ─────────────────
// POST /api/pod/devices/:id/pod-view  { view: 'activity' | 'status' | 'sleeping' | 'display' }
pod.post('/devices/:id/pod-view', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => ({}))) as { view?: string }
  if (!body.view || !isValidPodView(body.view)) {
    return c.json({ error: 'invalid view; must be display | activity | status | sleeping' }, 400)
  }
  await setPodView(id, body.view as DeviceDisplayMode)
  return c.json({ ok: true, view: body.view })
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
    podView: getPodView(rest.id),
  })))
})

// The current user's OWN devices (Settings → Devices — screen-deck self-service). Same
// safe shape as the admin list (no tokenHash), scoped to devices.userId === user.id.
pod.get('/my/devices', requireAuth, async (c) => {
  const user = c.get('user')
  const rows = await listDevices()
  const online = connectedDeviceIds()
  const activity = connectedActivity()
  return c.json(rows.filter((d) => d.userId === user.id).map(({ tokenHash: _t, ...rest }) => ({
    ...rest,
    paired: _t != null,
    online: online.has(rest.id),
    activity: activity.get(rest.id) ?? 'idle',
    podView: getPodView(rest.id),
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
    name?: string; userId?: string; characterId?: string | null; wakeWord?: string | null; orientation?: number
  }
  const id = c.req.param('id')
  const updated = await updateDevice(id, {
    name: body.name?.trim() || undefined,
    userId: body.userId || undefined,
    characterId: body.characterId === undefined ? undefined : (body.characterId || null),
    wakeWord: body.wakeWord === undefined ? undefined : (body.wakeWord || null),
    orientation: body.orientation !== undefined ? (Number(body.orientation) || 0) : undefined,
  })
  if (!updated) return c.json({ error: 'device not found' }, 404)
  if (body.orientation !== undefined) {
    setDeviceOrientation(id, updated.orientation)  // rotates the server-rendered JPEG
    orientToDevice(id, updated.orientation)         // tells LVGL to rotate touch + native buttons
  }
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

// ── Wyoming gateway health + control ──────────────────────────────────────────
// The gateway is the TCP listener (:10700) every Pod connects to. If it's down,
// devices silently can't connect (and mode pushes/voice all fail), so surface its
// status and a one-click restart in Admin → Devices.
pod.get('/gateway/status', requireAdmin, (c) => c.json(gatewayStatus()))
pod.post('/gateway/restart', requireAdmin, (c) => c.json(restartPodGateway()))

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
  // If a flash is still "in progress" it's almost always a stale lock — a wizard that
  // was closed mid-flash, leaving the SSE/process abandoned. There's one operator and
  // one device, so the operator explicitly starting a new flash takes over: abort the
  // old one and reset, rather than 409-ing every retry forever.
  if (isFlashBusy()) {
    podFlashAbort?.abort()
    resetFlashState()
    await new Promise((r) => setTimeout(r, 400))
  }
  const body = (await c.req.json().catch(() => ({}))) as { port?: string; name?: string; model?: string }
  return streamSSE(c, async (stream) => {
    const ctrl = new AbortController()
    podFlashAbort = ctrl
    stream.onAbort(() => ctrl.abort())
    const log = (line: string) => { void stream.writeSSE({ event: 'log', data: JSON.stringify({ line }) }) }
    try {
      await buildAndFlash({ port: body.port, name: body.name, model: body.model, onLine: log, signal: ctrl.signal })
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ ok: true }) })
    } catch (err) {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) })
    } finally {
      if (podFlashAbort === ctrl) podFlashAbort = null
    }
  })
})

// Validate a device's firmware config (esphome config) — no compile, no flash. Streams
// the CLI output as SSE so the admin can pre-flight a YAML/component edit from the app.
pod.post('/firmware/validate', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { model?: string }
  return streamSSE(c, async (stream) => {
    const ctrl = new AbortController()
    stream.onAbort(() => ctrl.abort())
    const log = (line: string) => { void stream.writeSSE({ event: 'log', data: JSON.stringify({ line }) }) }
    try {
      await validateFirmware(body.model, log, ctrl.signal)
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
