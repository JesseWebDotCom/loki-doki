// Phone-layout verifier (agents.md > Mobile Design Contract > Verifying phone layouts).
// Screenshots routes at iPhone size with a simulated status bar (59px) and home
// indicator (34px) painted on top, because desktop Chromium reports
// env(safe-area-inset-*) as 0 and safe-area collisions are otherwise invisible.
// Also audits each route for the mechanical mobile rules (sub-16px inputs that
// trigger iOS focus-zoom, horizontal overflow).
//
// Usage:
//   SESSION_TOKEN=<session cookie value> node scripts/mobile-screenshot.mjs [outDir] [route ...]
//   (defaults: outDir=./mobile-shots, routes=/ /videos /music /news)
//
// Playwright is a backend dependency; this script borrows it rather than adding
// a frontend dep for a dev-only tool.
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { chromium } = await import(
  join(here, '../../backend/node_modules/playwright/index.mjs')
)

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const [outArg, ...routeArgs] = process.argv.slice(2)
const OUT = resolve(outArg ?? './mobile-shots')
const routes = routeArgs.length ? routeArgs : ['/', '/videos', '/music', '/news']
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 393, height: 852 }, // iPhone 15 Pro points
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
})

// The app is behind the profile picker; mint or reuse a session and pass it in.
const token = process.env.SESSION_TOKEN
if (token) {
  await ctx.addCookies([
    { name: 'session', value: token, url: BASE },
    { name: 'session', value: token, url: 'http://localhost:3000' },
  ])
}

const page = await ctx.newPage()

// Make env(safe-area-inset-*) report real iPhone values (status bar 59, home
// indicator 34) so pt-safe/pb-safe actually take effect in the screenshot.
// Desktop Chromium reports 0 otherwise, which hides both bugs AND fixes.
// Guarded: older Chromium builds don't have this CDP command.
let insetsEmulated = false
try {
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Emulation.setSafeAreaInsetsOverride', {
    insets: { top: 59, topMax: 59, left: 0, leftMax: 0, bottom: 34, bottomMax: 34, right: 0, rightMax: 0 },
  })
  insetsEmulated = true
} catch {
  console.error('warn: CDP safe-area override unavailable; env(safe-area-inset-*) will be 0')
}
console.error(`safe-area emulation: ${insetsEmulated ? 'on (59/34)' : 'OFF'}`)

const audit = {}

for (const route of routes) {
  const name = route === '/' ? 'home' : route.replace(/^\//, '').replace(/\//g, '-')
  await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(2000)
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('.__sim-safearea')) el.remove()
    const top = document.createElement('div')
    top.className = '__sim-safearea'
    top.style.cssText =
      'position:fixed;top:0;left:0;right:0;height:59px;z-index:2147483647;pointer-events:none;background:rgba(255,0,0,0.28);border-bottom:2px solid red;display:flex;align-items:center;justify-content:space-between;padding:0 24px;color:white;font:600 15px -apple-system,sans-serif'
    top.innerHTML = '<span>9:41</span><span>&#x1F4F6; &#x1F50B;</span>'
    const bot = document.createElement('div')
    bot.className = '__sim-safearea'
    bot.style.cssText =
      'position:fixed;bottom:0;left:0;right:0;height:34px;z-index:2147483647;pointer-events:none;background:rgba(255,0,0,0.28);border-top:2px solid red'
    document.body.append(top, bot)
  })
  await page.screenshot({ path: join(OUT, `${name}.png`) })

  audit[name] = await page.evaluate(() => ({
    zoomTriggerInputs: [...document.querySelectorAll('input,textarea,select')]
      .filter((e) => e.offsetParent && parseFloat(getComputedStyle(e).fontSize) < 16)
      .map((e) => `${e.tagName.toLowerCase()} ${getComputedStyle(e).fontSize} "${e.placeholder ?? ''}"`)
      .slice(0, 10),
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
  }))
}

console.log(JSON.stringify(audit, null, 2))
console.log(`screenshots -> ${OUT}`)
await browser.close()
