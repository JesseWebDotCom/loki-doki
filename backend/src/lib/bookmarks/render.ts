// Server-side page renderer (Playwright/Chromium) — the default capture engine for the
// Reader, the way Pocket/Omnivore/ArchiveBox do it. Renders a URL in a real headless browser
// (JS executes), returns the fully-rendered HTML plus a screenshot. Runs headless in the
// download-job queue, so it works for every save path (UI, bookmarklet, companion, scheduled)
// without a user's browser. Falls back to client-side capture / static fetch upstream.
//
// Browser resolution (ensureChromium): prefer an already-installed Playwright Chromium, else
// a system Chrome/Edge channel (no download), else install Playwright's managed Chromium under
// data/bin/playwright. So dev machines reuse system Chrome; headless appliances self-install.
//
// SSRF: the URL (and every subresource the page requests) is user-influenced and the server
// sits next to Ollama/ComfyUI/the router admin. We assert the top URL is public and abort any
// subresource request to a private/loopback/link-local/metadata IP literal or localhost.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type LaunchOptions } from 'playwright'
import { dataDir } from '@/lib/download'
import { assertPublicUrl, isBlockedIp, SsrfError } from '@/lib/ssrfGuard'
import { logger } from '@/lib/logger'

// Keep Playwright's managed browsers under data/ (consistent with the appliance's other
// downloaded binaries). Must be set before launch.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(dataDir, 'bin', 'playwright')

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const NAV_TIMEOUT_MS = 30_000
const SETTLE_MS = 1_200
const VIEWPORT = { width: 1280, height: 800 }

export interface RenderResult {
  html: string
  screenshotPng: Uint8Array
  pdf: Uint8Array | null
}

// ── browser resolution ─────────────────────────────────────────────────────────

// Resolved launch options: {} = managed Chromium, {channel} = system browser, null = none.
let resolved: LaunchOptions | null | undefined
let resolving: Promise<LaunchOptions | null> | undefined

async function tryLaunch(opts: LaunchOptions): Promise<boolean> {
  try {
    const b = await chromium.launch({ ...opts, headless: true })
    await b.close()
    return true
  } catch {
    return false
  }
}

function installManagedChromium(): Promise<boolean> {
  return new Promise((resolve) => {
    logger.info('[reader/render] installing managed Chromium (first run, ~150MB)…')
    // `playwright install chromium` honors PLAYWRIGHT_BROWSERS_PATH from the env.
    const proc = spawn('bun', ['x', 'playwright', 'install', 'chromium'], {
      env: process.env, stdio: 'ignore', windowsHide: true,
    })
    // Bound the download: a stalled installer (network drop) would otherwise leave ensureChromium's
    // memoized promise pending forever, hanging every bookmark archive + Canvas PDF export.
    const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* gone */ }; resolve(false) }, 8 * 60_000)
    proc.on('exit', (code) => { clearTimeout(timer); resolve(code === 0) })
    proc.on('error', () => { clearTimeout(timer); resolve(false) })
  })
}

/** Clear the memoized browser resolution so the next ensureChromium() re-probes. Called after an
 *  admin repairs Chromium via chromiumInstall, so archives stop degrading to static without a
 *  full server restart. */
export function invalidateChromium(): void {
  resolved = undefined
  resolving = undefined
}

// Resolve (and if needed install) a working browser. Memoized; concurrent callers share.
export async function ensureChromium(): Promise<LaunchOptions | null> {
  if (resolved !== undefined) return resolved
  if (resolving) return resolving
  resolving = (async () => {
    // 1) Managed Chromium already installed?
    try {
      if (existsSync(chromium.executablePath())) { resolved = {}; return resolved }
    } catch { /* not installed → keep looking */ }
    // 2) System Chrome/Edge (no download) — great for dev + Windows appliances.
    for (const channel of ['chrome', 'msedge'] as const) {
      if (await tryLaunch({ channel })) { resolved = { channel }; return resolved }
    }
    // 3) Install Playwright's managed Chromium (headless appliances).
    if (await installManagedChromium() && await tryLaunch({})) { resolved = {}; return resolved }
    logger.warn('[reader/render] no usable browser — falling back to client/static capture')
    resolved = null
    return resolved
  })()
  return resolving
}

// Install-registry hooks live in ./chromiumInstall (a standalone module that imports
// only playwright, NOT logger/download) so the install registry can import them
// WITHOUT dragging render.ts's logger↔download cycle into early boot.

// ── render ──────────────────────────────────────────────────────────────────────

let busy: Promise<unknown> = Promise.resolve() // serialize renders (one browser at a time)

export interface RenderOptions {
  /** Screenshot + printed PDF are only needed for Reader's archival copy — Shop's price
   *  scraping only ever reads `.html`, so skipping them cuts real per-render latency (and
   *  the risk below) for a caller that never wanted the media in the first place. */
  captureMedia?: boolean
  /** Hard backstop closing the browser no matter what's in flight (a hung screenshot/pdf
   *  capture, or a site whose own load-state timeouts don't fire for some reason) — without
   *  this, one wedged render could block every other renderPage() caller behind it in `busy`
   *  forever, since serialization only advances once a render actually settles. */
  timeoutMs?: number
}

export async function renderPage(url: string, opts: RenderOptions = {}): Promise<RenderResult | null> {
  const launchOpts = await ensureChromium()
  if (!launchOpts) return null
  try {
    await assertPublicUrl(url)
  } catch (err) {
    if (err instanceof SsrfError) { logger.warn(`[reader/render] blocked internal URL: ${url}`); return null }
    throw err
  }

  // Serialize so we never run multiple browsers at once (memory + CPU on a LAN box).
  const run = busy.then(() => doRender(url, launchOpts, opts)).catch(() => null)
  busy = run.catch(() => {})
  return run
}

/** Print a self-contained HTML string to a PDF (Canvas export). Shares the same
 *  browser-serialization queue as renderPage so we never run two Chromiums at once.
 *  Subresource requests to private/loopback hosts are blocked (SSRF guard); the
 *  artifacts this serves are meant to be self-contained anyway. Returns null if no
 *  browser is available (caller surfaces a friendly error). */
export async function renderHtmlToPdf(html: string): Promise<Uint8Array | null> {
  const launchOpts = await ensureChromium()
  if (!launchOpts) return null
  const run = busy.then(() => doRenderHtmlToPdf(html, launchOpts)).catch(() => null)
  busy = run.catch(() => {})
  return run
}

async function doRenderHtmlToPdf(html: string, launchOpts: LaunchOptions): Promise<Uint8Array | null> {
  const browser = await chromium.launch({ ...launchOpts, headless: true })
  const killer = setTimeout(() => { browser.close().catch(() => {}) }, 30_000)
  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT, javaScriptEnabled: true })
    await ctx.route('**', (route) => {
      const url = route.request().url()
      if (url.startsWith('data:') || url.startsWith('about:')) return route.continue()
      const host = (() => { try { return new URL(url).hostname } catch { return '' } })()
      const bad = host === 'localhost' || host.endsWith('.local') ||
        ((/^[\d.]+$/.test(host) || host.includes(':')) && isBlockedIp(host.replace(/^\[|\]$/g, '')))
      if (bad) return route.abort()
      return route.continue()
    })
    const page = await ctx.newPage()
    await page.setContent(html, { waitUntil: 'networkidle', timeout: 15_000 }).catch(() => {})
    return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' } })
      .then((b) => new Uint8Array(b))
      .catch(() => null)
  } catch {
    return null
  } finally {
    clearTimeout(killer)
    await browser.close().catch(() => {})
  }
}

async function doRender(url: string, launchOpts: LaunchOptions, opts: RenderOptions): Promise<RenderResult | null> {
  const captureMedia = opts.captureMedia ?? true
  const browser = await chromium.launch({ ...launchOpts, headless: true })
  const killer = setTimeout(() => { browser.close().catch(() => {}) }, opts.timeoutMs ?? 45_000)
  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT, userAgent: UA, javaScriptEnabled: true })
    // SSRF: abort any subresource pointed at a private/loopback/link-local/metadata host.
    await ctx.route('**', (route) => {
      const host = (() => { try { return new URL(route.request().url()).hostname } catch { return '' } })()
      const bad = host === 'localhost' || host.endsWith('.local') ||
        (/^[\d.]+$/.test(host) || host.includes(':')) && isBlockedIp(host.replace(/^\[|\]$/g, ''))
      if (bad) return route.abort()
      return route.continue()
    })
    const page = await ctx.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {})
    await page.waitForTimeout(SETTLE_MS)
    const html = await page.content()

    if (!captureMedia) return { html, screenshotPng: new Uint8Array(0), pdf: null }

    const screenshotPng = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, ...VIEWPORT } })
    // Printed PDF (ArchiveBox-style durable copy). Chromium-only + best-effort: a page that
    // refuses to print must not fail the whole archive, so swallow errors and return null.
    const pdf = await page.pdf({ format: 'A4', printBackground: true })
      .then((b) => new Uint8Array(b))
      .catch(() => null)
    return { html, screenshotPng, pdf }
  } catch {
    return null
  } finally {
    clearTimeout(killer)
    await browser.close().catch(() => {})
  }
}
