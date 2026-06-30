// Server-rendered ambient display for screen Pods (Tab5 & friends).
//
// The Tab5 has no web browser, so it can't load the React /display page itself.
// Instead the SERVER runs that page in headless Chromium (the same engine the
// Reader uses) and hands the device a plain JPEG of the current frame. The
// firmware's `online_image` polls /api/pod/display/:hwid a few times a second and
// blits it to the panel — so the real animated clock/weather page shows on the
// device, refreshed live, with zero browser on the ESP32.
//
// One long-lived headless page per device (logged in as the device's bound user
// via a minted session cookie) stays parked on /display; each poll just screenshots
// it, so frames are cheap and the page keeps animating between captures. Idle
// devices are torn down after a couple minutes.
//
// Orientation modes
// ─────────────────
//   0°  — landscape, normal     (1280×720 JPEG, no rotation)
//   180°— landscape, flipped    (1280×720 JPEG, no rotation — LVGL handles flip on device)
//   90° — portrait, normal      (720×1280 viewport → Canvas-rotate CW → 1280×720 JPEG)
//   270°— portrait, flipped     (720×1280 viewport → Canvas-rotate CCW → 1280×720 JPEG)
//
// Landscape modes (0°/180°) are served as plain un-rotated 1280×720 JPEGs. The
// firmware applies lv_display_set_rotation() for 180° which moves native controls
// (mic/audio buttons, status pill) and remaps touch coordinates correctly.
// Portrait modes render in a 720×1280 viewport then Canvas-rotate to 1280×720 so
// the hw_jpeg hardware decoder always receives a fixed-size 1280×720 frame.

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { devices, sessions } from '@/db/schema'
import { ensureChromium } from '@/lib/bookmarks/render'
import { generateSessionToken, hashSessionToken, sessionExpiresAt } from '@/lib/session'
import { deviceView } from '@/lib/pod/displayController'
import { logger } from '@/lib/logger'

// Where the /display SPA is actually served: the backend serves the built frontend
// in production (serveStatic ../frontend/dist), but in dev that's disabled and Vite
// serves it on :5173 — rendering against :3000 there just yields the backend's 404
// page. DISPLAY_RENDER_ORIGIN overrides both.
// Use 'localhost' (not 127.0.0.1): the Vite dev server binds IPv6-only (::1), so an
// IPv4 literal can't reach it. 'localhost' resolves to whichever the server bound.
const VITE_PORT = process.env.VITE_PORT ?? '5173'
const ORIGIN =
  process.env.DISPLAY_RENDER_ORIGIN ??
  (process.env.NODE_ENV === 'development'
    ? `http://localhost:${VITE_PORT}`
    : `http://localhost:${process.env.PORT ?? '3000'}`)
// Hardware canvas/buffer size. Must match the firmware (1280×720). Tunable via env.
const FRAME_W = parseInt(process.env.DISPLAY_FRAME_W ?? '1280')
const FRAME_H = parseInt(process.env.DISPLAY_FRAME_H ?? '720')
const JPEG_QUALITY = parseInt(process.env.DISPLAY_JPEG_QUALITY ?? '45')
const IDLE_EVICT_MS = 120_000
const NAV_TIMEOUT_MS = 30_000

function normHwid(s: string): string {
  return s.replace(/[^a-f0-9]/gi, '').toLowerCase()
}

export async function deviceByHwid(hwid: string): Promise<{ id: string; userId: string; layoutTemplateId: string | null } | null> {
  const want = normHwid(hwid)
  if (!want) return null
  const rows = await db.select({ id: devices.id, userId: devices.userId, hwid: devices.hwid, layoutTemplateId: devices.layoutTemplateId }).from(devices)
  const match = rows.find((r) => r.hwid && normHwid(r.hwid) === want)
  return match ? { id: match.id, userId: match.userId, layoutTemplateId: match.layoutTemplateId } : null
}

// ── headless browser (shared, lazy) ───────────────────────────────────────────

let browserPromise: Promise<Browser | null> | null = null

async function getBrowser(): Promise<Browser | null> {
  if (!browserPromise) {
    browserPromise = (async () => {
      const opts = await ensureChromium()
      if (!opts) {
        logger.warn('[pod-display] no Chromium available — server-rendered display disabled')
        return null
      }
      const b = await chromium.launch({ ...opts, headless: true })
      b.on('disconnected', () => { browserPromise = null })
      return b
    })().catch((e) => {
      logger.warn(`[pod-display] Chromium launch failed: ${e}`)
      browserPromise = null
      return null
    })
  }
  return browserPromise
}

// ── orientation helpers ───────────────────────────────────────────────────────

function isPortrait(orientation: number): boolean {
  return orientation === 90 || orientation === 270
}

// ── per-device parked page ─────────────────────────────────────────────────────

interface DeviceDisplay {
  ctx: BrowserContext
  page: Page
  token: string
  lastUsed: number
  view: 'display' | 'controller'
  orientation: number   // 0 | 90 | 180 | 270
}

// In-memory orientation store — updated by setDeviceOrientation() when admin saves.
const orientations = new Map<string, number>()

export function setDeviceOrientation(deviceId: string, degrees: number): void {
  orientations.set(deviceId, degrees)
}

function deviceOrientation(deviceId: string): number {
  return orientations.get(deviceId) ?? 0
}

// The parked-tab URL for a device's current view. No ?orient= param — the firmware
// handles all rotation via lv_display_set_rotation(); the server always renders a
// plain un-rotated JPEG. Portrait modes still use a 720×1280 viewport so the React
// layout fills the portrait canvas before LVGL rotates the display.
function viewUrl(deviceId: string): string {
  const v = deviceView(deviceId)
  const base = `${ORIGIN}/display?device=1&deviceId=${encodeURIComponent(deviceId)}`
  return v === 'controller' ? `${base}&view=controller` : base
}

const live = new Map<string, DeviceDisplay>()

async function mintSession(userId: string): Promise<string> {
  const token = generateSessionToken()
  await db.insert(sessions).values({
    id: crypto.randomUUID(),
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt: sessionExpiresAt(),
    createdAt: new Date(),
  })
  return token
}

async function createDisplay(userId: string, deviceId: string): Promise<DeviceDisplay | null> {
  const browser = await getBrowser()
  if (!browser) return null
  // Seed the in-memory orientation map from DB so the first render after a server
  // restart uses the saved value instead of defaulting to 0.
  if (!orientations.has(deviceId)) {
    try {
      const [d] = await db.select({ orientation: devices.orientation }).from(devices).where(eq(devices.id, deviceId)).limit(1)
      orientations.set(deviceId, d?.orientation ?? 0)
    } catch { /* ignore; defaults to 0 */ }
  }
  const token = await mintSession(userId)
  const orient = deviceOrientation(deviceId)
  // Portrait modes render at 720×1280 so the React layout fills a portrait screen
  // natively. The screenshot is then rotated to the 1280×720 hardware buffer size.
  const [viewW, viewH] = isPortrait(orient) ? [FRAME_H, FRAME_W] : [FRAME_W, FRAME_H]
  const ctx = await browser.newContext({
    viewport: { width: viewW, height: viewH },
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
  })
  await ctx.addCookies([
    { name: 'session', value: token, url: ORIGIN, httpOnly: true, sameSite: 'Lax' },
  ])
  const page = await ctx.newPage()
  await page.goto(viewUrl(deviceId), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => {})
  return { ctx, page, token, lastUsed: Date.now(), view: deviceView(deviceId), orientation: orient }
}

async function evict(deviceId: string): Promise<void> {
  const d = live.get(deviceId)
  if (!d) return
  live.delete(deviceId)
  try { await d.ctx.close() } catch { /* ignore */ }
  try { await db.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(d.token))) } catch { /* ignore */ }
}

// Avoid two concurrent first-frame requests both spinning up a page for the device.
const building = new Map<string, Promise<DeviceDisplay | null>>()

// Serialize captures per device. Playwright's page.screenshot() MUST NOT be called
// concurrently on the same page — the stream loop plus the firmware's reconnects can
// otherwise overlap two captures and deadlock the page.
const captureChain = new Map<string, Promise<Buffer | null>>()

/** Current JPEG frame of a device's /display page, or null if rendering is unavailable. */
export function captureDeviceFrame(deviceId: string, userId: string): Promise<Buffer | null> {
  const next = (captureChain.get(deviceId) ?? Promise.resolve<Buffer | null>(null))
    .catch(() => null)
    .then(() => captureFrameInner(deviceId, userId))
  captureChain.set(deviceId, next)
  return next
}


/** Rotate a JPEG via the browser's Canvas API.
 *  Input is a portrait 720×1280 JPEG; output is landscape 1280×720 so the device's
 *  hw_jpeg hardware decoder always receives a fixed-size 1280×720 frame. */
async function rotateJpeg(page: Page, buf: Buffer, degrees: 90 | 270): Promise<Buffer> {
  const b64 = buf.toString('base64')
  const result = await page.evaluate(
    ({ src, deg, srcW, srcH }: { src: string; deg: number; srcW: number; srcH: number }) =>
      new Promise<string>((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
          const outW = srcH, outH = srcW
          const canvas = document.createElement('canvas')
          canvas.width = outW; canvas.height = outH
          const ctx = canvas.getContext('2d')!
          ctx.translate(outW / 2, outH / 2)
          ctx.rotate((deg * Math.PI) / 180)
          ctx.drawImage(img, -srcW / 2, -srcH / 2)
          resolve(canvas.toDataURL('image/jpeg', 0.45).split(',')[1])
        }
        img.onerror = () => reject(new Error('canvas rotate failed'))
        img.src = 'data:image/jpeg;base64,' + src
      }),
    { src: b64, deg: degrees, srcW: FRAME_H, srcH: FRAME_W },
  )
  return Buffer.from(result, 'base64')
}

async function captureFrameInner(deviceId: string, userId: string): Promise<Buffer | null> {
  let d = live.get(deviceId)
  const wantOrientation = deviceOrientation(deviceId)

  // If the orientation group changed (landscape ↔ portrait), the parked page was
  // created with the wrong viewport dimensions — evict so it rebuilds correctly.
  if (d && isPortrait(d.orientation) !== isPortrait(wantOrientation)) {
    await evict(deviceId)
    d = undefined
  }

  if (!d) {
    let p = building.get(deviceId)
    if (!p) {
      p = createDisplay(userId, deviceId).finally(() => building.delete(deviceId))
      building.set(deviceId, p)
    }
    d = (await p) ?? undefined
    if (!d) return null
    live.set(deviceId, d)
  }
  d.lastUsed = Date.now()
  try {
    // Re-navigate when view or orientation changes (or if the SPA drifted off /display).
    const wantView = deviceView(deviceId)
    if (!d.page.url().includes('/display') || d.view !== wantView || d.orientation !== wantOrientation) {
      await d.page.goto(viewUrl(deviceId), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => {})
      d.view = wantView
      d.orientation = wantOrientation
    }
    let jpegBuf = Buffer.from(
      await d.page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY, timeout: 10_000 })
    )
    // Portrait viewport produces 720×1280. Rotate to 1280×720 so the device's hw_jpeg
    // hardware decoder always receives a fixed-size 1280×720 frame. Landscape modes
    // (0° and 180°) are served un-rotated; LVGL on the firmware handles all landscape
    // rotation via lv_display_set_rotation(), which also repositions native controls.
    if (wantOrientation === 90 || wantOrientation === 270) {
      jpegBuf = await rotateJpeg(d.page, jpegBuf, wantOrientation)
    }
    return jpegBuf
  } catch (e) {
    logger.warn(`[pod-display] capture failed for ${deviceId}, rebuilding: ${e}`)
    await evict(deviceId)
    return null
  }
}

// Reap idle pages so a device that's been powered off doesn't hold a headless tab open.
setInterval(() => {
  const now = Date.now()
  for (const [id, d] of live) {
    if (now - d.lastUsed > IDLE_EVICT_MS) void evict(id)
  }
}, 30_000).unref?.()
