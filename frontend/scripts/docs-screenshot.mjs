// Documentation screenshot engine — captures app routes as the seeded demo household
// so screenshots NEVER contain the owner's personal data. See docs-shot-manifest.mjs
// for what gets captured and agents.md / the update-docs skill for the workflow.
//
// Privacy model (all three layers are mandatory, do not weaken them):
//   1. Sessions come ONLY from .demo-sessions.json (written by backend `bun run
//      seed:demo`). There is deliberately no SESSION_TOKEN env override — the owner's
//      real session can never be injected.
//   2. Every session is verified against /api/auth/me: the nickname must start with
//      'demo-' or the whole run aborts before any capture.
//   3. Every page is scanned against .demo-denylist.txt (repo root, gitignored: the
//      owner's real names/city/etc). A hit skips that PNG and fails the run.
//
// Usage:
//   bun run shots:docs                 # everything in the manifest
//   bun run shots:docs home music      # only entries whose name matches a filter
//   node scripts/docs-screenshot.mjs --allow-empty-denylist   # CI/fresh-DB escape hatch
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import manifest from './docs-shot-manifest.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// Playwright is a backend dependency; borrow it rather than adding a frontend dep.
const { chromium } = await import(join(here, '../../backend/node_modules/playwright/index.mjs'))

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const API = process.env.API_URL ?? 'http://localhost:3000'
const OUT = join(here, '../../docs/src/assets/screenshots')
const SESSIONS_PATH = join(here, '.demo-sessions.json')
const DENYLIST_PATH = join(here, '../../.demo-denylist.txt')

const args = process.argv.slice(2)
const allowEmptyDenylist = args.includes('--allow-empty-denylist')
const nameFilters = args.filter((a) => !a.startsWith('--'))

// ── Denylist (fail-closed) ────────────────────────────────────────────────────
let denylist = []
if (existsSync(DENYLIST_PATH)) {
  denylist = readFileSync(DENYLIST_PATH, 'utf8')
    .split('\n')
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith('#'))
}
if (denylist.length === 0 && !allowEmptyDenylist) {
  console.error('ERROR: .demo-denylist.txt is missing or empty at the repo root.')
  console.error('Create it with one term per line — the owner\'s real first/last names,')
  console.error('city, state, email, and every real (non-demo) profile nickname — so any')
  console.error('accidental leak fails the run instead of landing in the docs.')
  console.error('(--allow-empty-denylist exists only for CI against a fresh demo-only DB.)')
  process.exit(1)
}

// ── Demo sessions (the ONLY auth source) ─────────────────────────────────────
if (!existsSync(SESSIONS_PATH)) {
  console.error('ERROR: .demo-sessions.json not found. Run `cd backend && bun run seed:demo` first.')
  process.exit(1)
}
const { personas } = JSON.parse(readFileSync(SESSIONS_PATH, 'utf8'))

const entries = manifest.filter(
  (e) => nameFilters.length === 0 || nameFilters.some((f) => e.name.includes(f)),
)
if (entries.length === 0) {
  console.error(`no manifest entries match: ${nameFilters.join(', ')}`)
  process.exit(1)
}

// Verify every needed session belongs to a demo user BEFORE opening a browser.
for (const key of new Set(entries.map((e) => e.persona))) {
  const p = personas[key]
  if (!p) {
    console.error(`ERROR: persona '${key}' missing from .demo-sessions.json — reseed with bun run seed:demo`)
    process.exit(1)
  }
  const res = await fetch(`${API}/api/auth/me`, { headers: { cookie: `session=${p.token}` } })
  if (!res.ok) {
    console.error(`ERROR: session for '${key}' rejected (${res.status}) — stale tokens? Rerun bun run seed:demo`)
    process.exit(1)
  }
  const me = await res.json()
  // Demo users carry fixed dde30000-… UUIDs (see backend/scripts/seed-demo-data.ts).
  // Guarding on the id (not the display name) means a real account can never slip
  // through, even if someone names a profile "Sam".
  if (me.id !== p.userId || !String(me.id).startsWith('dde30000-')) {
    console.error(`ERROR: session for '${key}' resolves to non-demo user id '${me.id}'. Aborting — never`)
    console.error('screenshot a real account. Rerun `cd backend && bun run seed:demo` to mint demo sessions.')
    process.exit(1)
  }
}

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch()

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  mobile: {
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  },
}

// One context per persona+variant, created lazily and reused across entries.
// Entries with a custom viewport or pre-seeded localStorage get a private context.
const contexts = new Map()
async function getPage(personaKey, variant, entry = {}) {
  const custom = entry.viewport || entry.localStorage
  const key = custom ? `${personaKey}:${variant}:${entry.name}` : `${personaKey}:${variant}`
  if (contexts.has(key)) return contexts.get(key)
  const opts = { ...VIEWPORTS[variant] }
  // Per-entry viewport only applies to the desktop variant — mobile stays phone-sized.
  if (entry.viewport && variant === 'desktop') opts.viewport = entry.viewport
  const ctx = await browser.newContext(opts)
  if (entry.localStorage) {
    await ctx.addInitScript((kv) => {
      for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v)
    }, entry.localStorage)
  }
  await ctx.addCookies([
    { name: 'session', value: personas[personaKey].token, url: BASE },
    { name: 'session', value: personas[personaKey].token, url: API },
  ])
  const page = await ctx.newPage()
  if (variant === 'mobile') {
    // Real iPhone safe-area insets so pt-safe/pb-safe layouts render as shipped
    // (no debug overlay here — these shots go straight into the docs).
    try {
      const cdp = await ctx.newCDPSession(page)
      await cdp.send('Emulation.setSafeAreaInsetsOverride', {
        insets: { top: 59, topMax: 59, left: 0, leftMax: 0, bottom: 34, bottomMax: 34, right: 0, rightMax: 0 },
      })
    } catch {
      console.error('warn: CDP safe-area override unavailable; mobile shots render with 0 insets')
    }
  }
  contexts.set(key, page)
  return page
}

async function runActions(page, actions = []) {
  for (const a of actions) {
    if (a.type === 'click') await page.click(a.selector, { timeout: a.timeout ?? 10000 })
    else if (a.type === 'waitFor') await page.waitForSelector(a.selector, { timeout: a.timeout ?? 10000 })
    else if (a.type === 'fill') await page.fill(a.selector, a.value)
    else if (a.type === 'press') await page.press(a.selector, a.key)
    else if (a.type === 'wait') await page.waitForTimeout(a.ms)
  }
}

// Visible text + accessibility/alt/title attributes (+ document title for full-page
// shots), lowercased. When an entry has a `selector`, both the capture AND this scan
// are scoped to that element — that's what makes admin pages shootable at all (the
// rest of the page legitimately shows real household state).
async function visibleText(page, selector) {
  return page.evaluate((sel) => {
    const root = sel ? document.querySelector(sel) : document.body
    if (!root) return ''
    const parts = [sel ? '' : document.title, root.innerText ?? '']
    for (const el of root.querySelectorAll('[alt],[title],[aria-label],[placeholder]')) {
      for (const attr of ['alt', 'title', 'aria-label', 'placeholder']) {
        const v = el.getAttribute(attr)
        if (v) parts.push(v)
      }
    }
    return parts.join('\n').toLowerCase()
  }, selector ?? null)
}

const hits = []
let taken = 0

for (const entry of entries) {
  for (const variant of entry.variants ?? ['desktop']) {
    const page = await getPage(entry.persona, variant, entry)
    // 'load' + settle instead of networkidle: the app holds SSE connections open,
    // so networkidle never fires and every route would eat the full timeout.
    await page.goto(BASE + entry.route, { waitUntil: 'load', timeout: 30000 }).catch(() => {})
    await page.waitForTimeout(entry.settleMs ?? 2500)
    try {
      await runActions(page, entry.actions)
    } catch (err) {
      console.error(`ACTION FAILED ${entry.name} (${variant}): ${err.message.split('\n')[0]}`)
      hits.push({ name: entry.name, variant, term: '<action failed>' })
      continue
    }

    const text = await visibleText(page, entry.selector)
    if (text.includes('something went wrong')) {
      console.error(`ERROR BOUNDARY ${entry.name} (${variant}): page crashed — not a usable screenshot`)
      hits.push({ name: entry.name, variant, term: '<error boundary>' })
      continue
    }
    const matched = denylist.filter((term) => text.includes(term))
    if (matched.length > 0) {
      for (const term of matched) {
        console.error(`DENYLIST HIT route=${entry.route} persona=${entry.persona} variant=${variant} term=${term}`)
      }
      hits.push({ name: entry.name, variant, term: matched.join(', ') })
      continue // never write a PNG containing a denylisted term
    }

    const file = join(OUT, `${entry.name}-${variant}.png`)
    const shotOpts = { path: file }
    if (entry.transparent) shotOpts.omitBackground = true
    if (entry.clip) shotOpts.clip = entry.clip
    if (entry.selector) {
      const el = await page.waitForSelector(entry.selector, { timeout: 10000 }).catch(() => null)
      if (!el) {
        console.error(`SELECTOR MISSING ${entry.name} (${variant}): ${entry.selector}`)
        hits.push({ name: entry.name, variant, term: '<selector missing>' })
        continue
      }
      await el.screenshot(shotOpts)
    } else {
      await page.screenshot(shotOpts)
    }
    taken++
    console.log(`✓ ${entry.name}-${variant}.png  (${entry.route} as ${entry.persona})`)
  }
}

await browser.close()

console.log(`\n${taken} screenshot(s) → ${OUT}`)
if (hits.length > 0) {
  console.error(`\nFAILED: ${hits.length} capture(s) skipped (denylist hits / failed actions above).`)
  console.error('Fix the leak or the manifest and rerun. Do NOT weaken the denylist to pass.')
  process.exit(1)
}
