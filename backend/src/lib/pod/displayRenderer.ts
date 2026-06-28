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

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { devices, sessions } from '@/db/schema'
import { ensureChromium } from '@/lib/bookmarks/render'
import { generateSessionToken, hashSessionToken, sessionExpiresAt } from '@/lib/session'
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
// Render resolution. With the device's HARDWARE JPEG decoder (hw_jpeg component) a
// full 1280×720 frame decodes in ~ms, so render native for sharpness — and it MUST
// match the firmware canvas/buffer size (1280×720). Tunable via env if needed.
const FRAME_W = parseInt(process.env.DISPLAY_FRAME_W ?? '1280')
const FRAME_H = parseInt(process.env.DISPLAY_FRAME_H ?? '720')
const JPEG_QUALITY = parseInt(process.env.DISPLAY_JPEG_QUALITY ?? '45')
const IDLE_EVICT_MS = 120_000
const NAV_TIMEOUT_MS = 30_000

// MAC / hwid come in assorted shapes ("a4:cf:12:ab:34:cd", "A4CF12AB34CD", …) from
// the firmware and from claim-time discovery. Compare on the bare hex.
function normHwid(s: string): string {
  return s.replace(/[^a-f0-9]/gi, '').toLowerCase()
}

export async function deviceByHwid(hwid: string): Promise<{ id: string; userId: string } | null> {
  const want = normHwid(hwid)
  if (!want) return null
  const rows = await db.select({ id: devices.id, userId: devices.userId, hwid: devices.hwid }).from(devices)
  const match = rows.find((r) => r.hwid && normHwid(r.hwid) === want)
  return match ? { id: match.id, userId: match.userId } : null
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
      // If the browser dies, drop the memo so the next call relaunches.
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

// ── per-device parked page ─────────────────────────────────────────────────────

interface DeviceDisplay {
  ctx: BrowserContext
  page: Page
  token: string
  lastUsed: number
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

async function createDisplay(userId: string): Promise<DeviceDisplay | null> {
  const browser = await getBrowser()
  if (!browser) return null
  const token = await mintSession(userId)
  const ctx = await browser.newContext({
    viewport: { width: FRAME_W, height: FRAME_H },
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
  })
  // Use url (not domain) so Playwright derives domain/path correctly for an IP host.
  await ctx.addCookies([
    { name: 'session', value: token, url: ORIGIN, httpOnly: true, sameSite: 'Lax' },
  ])
  const page = await ctx.newPage()
  // 'domcontentloaded' (not 'networkidle'): Vite's HMR socket keeps the network busy
  // so networkidle never fires in dev. The page is parked and re-screenshotted live,
  // so the React app + weather settle over the next polls regardless.
  // device=1 → the page hides its own (non-interactive) control buttons; the device
  // draws native LVGL buttons instead (a server-rendered image can't take touch).
  await page.goto(`${ORIGIN}/display?device=1`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => {})
  return { ctx, page, token, lastUsed: Date.now() }
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
// otherwise overlap two captures and deadlock the page (hangs every frame). Each call
// chains after the previous one for that device.
const captureChain = new Map<string, Promise<Buffer | null>>()

/** Current JPEG frame of a device's /display page, or null if rendering is unavailable. */
export function captureDeviceFrame(deviceId: string, userId: string): Promise<Buffer | null> {
  const next = (captureChain.get(deviceId) ?? Promise.resolve<Buffer | null>(null))
    .catch(() => null)
    .then(() => captureFrameInner(deviceId, userId))
  captureChain.set(deviceId, next)
  return next
}

async function captureFrameInner(deviceId: string, userId: string): Promise<Buffer | null> {
  let d = live.get(deviceId)
  if (!d) {
    let p = building.get(deviceId)
    if (!p) {
      p = createDisplay(userId).finally(() => building.delete(deviceId))
      building.set(deviceId, p)
    }
    d = (await p) ?? undefined
    if (!d) return null
    live.set(deviceId, d)
  }
  d.lastUsed = Date.now()
  try {
    // Self-heal: if the SPA navigated the parked tab off /display (session expiry, a
    // transient redirect to "/" or /login), pull it back so the device never gets
    // stuck showing the full site instead of the ambient display.
    if (!d.page.url().includes('/display')) {
      await d.page.goto(`${ORIGIN}/display?device=1`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => {})
    }
    const buf = await d.page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY, timeout: 10_000 })
    return Buffer.from(buf)
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
