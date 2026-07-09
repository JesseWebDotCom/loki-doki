// Design-contract linter: greps frontend/src for Visual Language violations
// (see agents.md > Visual Language). Mechanics:
//   - RULES: line rules (regex per line) + file rules (whole-file tag scans).
//   - ALLOW: per-rule path-prefix allowlists for sanctioned exceptions
//     (semantic color keepers, canvas code, full-screen surfaces).
//   - Inline waivers: a match is skipped when the same or preceding line
//     contains `design-ok(rule-name): reason`. Waivers are grep-auditable.
//   - Baseline: design-contract-baseline.json (rule -> file -> count). A rule
//     fails only on counts ABOVE baseline, so the migration sweep can flip
//     files to zero cluster-by-cluster. Regenerate with --update-baseline.
//     Delete the baseline file once the sweep is complete.
// Exits 1 on any above-baseline violation or stale allowlist/baseline entry.
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '../src')
const baselinePath = join(here, 'design-contract-baseline.json')
const updateBaseline = process.argv.includes('--update-baseline')

// Class-prefix group for palette rules (text-red-500, hover:bg-amber-400/20, …)
const CLS = '(?:text|bg|border|ring|from|via|to|fill|stroke|shadow|outline|decoration|divide|accent|caret|placeholder)-'
const PALETTE_BANNED = 'violet|purple|fuchsia|indigo'
const PALETTE_SEMANTIC = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|pink|rose|slate|gray|zinc|neutral|stone'

// Line rules: { name, pattern, ext?, scope?, allow? }
//   ext: restrict to extensions; scope: path prefix restriction; allow: path prefixes exempt.
const RULES = [
  { name: 'em-dash', pattern: /—/ },
  { name: 'window-confirm-alert', pattern: /window\.(confirm|alert)\(/ },
  // Decorative purple-family palette classes: always replace with brand tokens.
  { name: 'banned-palette', pattern: new RegExp(`\\b(?:[a-z-]+:)*${CLS}(?:${PALETTE_BANNED})-\\d{2,3}(?:/\\d{1,3})?\\b`) },
  // Other raw palette accents: semantic uses must move to --success/--warning/etc.
  // or carry a waiver; scene/domain palettes are allowlisted.
  {
    name: 'raw-palette-semantic',
    pattern: new RegExp(`\\b(?:[a-z-]+:)*${CLS}(?:${PALETTE_SEMANTIC})-\\d{2,3}(?:/\\d{1,3})?\\b`),
    allow: [
      'components/homeassistant/DeviceCard.tsx',
      'components/weather/',
      'lib/weather.ts',
      // Full-bleed immersive music player: white-on-album-art surface, same category as PlexPlayer.
      'components/music/NowPlayingOverlay.tsx',
    ],
  },
  {
    name: 'hex-in-tsx',
    pattern: /(?<![\w&])#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/,
    ext: ['.tsx'],
    allow: [
      'components/shared/SpaceBackdrop.tsx',
      'components/weather/',
      'components/display/',
      'components/companion/',
      'pages/ImagingPage.tsx',
      'pages/maps/',
      // SeekBar/EqVisualizer take literal color fallbacks (canvas can't read CSS vars).
      'components/music/NowPlayingOverlay.tsx',
      'components/music/ImmersivePlayer.tsx',
    ],
  },
  {
    name: 'raw-h1-in-pages',
    pattern: /<h1[\s>]/,
    allow: [
      'components/shared/PageHeader.tsx',
      'components/shared/ArticleReader.tsx',
      'components/shell/BootScreen.tsx',
    ],
  },
  // Semantic radius tiers only: rounded-control/card/sheet/full (+ side/corner
  // variants stay possible via ui/ components). Legacy scale lives in ui/ only.
  {
    name: 'radius-off-scale',
    pattern: /\brounded-(?:sm|md|lg|xl|2xl|3xl)\b/,
    allow: ['components/ui/'],
  },
  {
    name: 'raw-overlay',
    pattern: /\bfixed inset-0\b/,
    allow: [
      'components/ui/dialog.tsx',
      'components/ui/sheet.tsx',
      'components/shell/BootScreen.tsx',
      'components/shared/PrivacyOverlay.tsx',
      'components/shared/PinPad.tsx',
      'components/display/',
      'components/media/PlexPlayer.tsx',
      'components/music/ImmersivePlayer.tsx',
      'pages/DisplayPage.tsx',
    ],
  },
  { name: 'adhoc-spinner', pattern: /\banimate-spin\b/, allow: ['components/ui/spinner.tsx'] },
  {
    name: 'adhoc-pulse',
    pattern: /\banimate-pulse\b/,
    allow: ['components/ui/skeleton.tsx', 'components/shared/StatusDot.tsx'],
  },
  {
    name: 'adhoc-container',
    pattern: /className="[^"]*\bmx-auto\b[^"]*\bmax-w-(?:xs|sm|md|lg|xl|\dxl|\[)/,
    scope: 'pages/',
  },
  // Glass belongs on chrome; in-page glass tiles need a waiver ("over imagery").
  { name: 'glass-on-plain-bg', pattern: /\bbg-white\/(?:5|10|\[0\.0\d+\])\b/, allow: ['components/music/NowPlayingOverlay.tsx', 'components/music/ImmersivePlayer.tsx'] },
  { name: 'font-black', pattern: /\bfont-black\b/, allow: ['components/shared/BrandMark.tsx'] },
  {
    name: 'brand-gradient-outside-hero',
    pattern: /--brand-gradient/,
    allow: [
      'index.css',
      'components/shared/BrandMark.tsx',
      'components/shell/BootScreen.tsx',
      'components/shell/LeftSidebar.tsx',
      'pages/SetupWizard.tsx',
      'pages/WelcomeWizard.tsx',
      'pages/LoginPage.tsx',
      'pages/HomePage.tsx',
    ],
  },
  {
    name: 'backdrop-blur-outside-chrome',
    pattern: /\bbackdrop-blur/,
    allow: [
      'index.css',
      'components/shell/',
      'components/shared/AppBreadcrumb.tsx',
      'components/shared/StickyAppBar.tsx',
      'components/shared/PrivacyOverlay.tsx',
      'components/youtube/YoutubeMiniBar.tsx',
      'components/podcast/PodcastPlayerBar.tsx',
      'components/music/ImmersivePlayer.tsx',
    ],
  },
]

// Hand-styled native <button> tags (multiline aware): must be ui/Button.
const BUTTON_RULE = {
  name: 'hand-styled-button',
  allow: ['components/ui/', 'components/shared/RippleButton.tsx', 'components/music/NowPlayingOverlay.tsx', 'components/music/ImmersivePlayer.tsx'],
}

const EXTS = new Set(['.ts', '.tsx', '.css'])

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, out)
    else if (EXTS.has(entry.slice(entry.lastIndexOf('.')))) out.push(full)
  }
  return out
}

const allowed = (rule, rel) => (rule.allow ?? []).some((p) => rel.startsWith(p) || rel.includes('/' + p))
// A waiver comment often sits a few lines above the line it covers (a JSX comment
// block, then a multi-line opening tag's attributes) - scan a small backward window
// rather than only the immediately preceding line.
const WAIVER_LOOKBACK = 6
const waived = (name, lines, i) => {
  const tag = `design-ok(${name})`
  for (let k = i; k >= Math.max(0, i - WAIVER_LOOKBACK); k--) {
    if (lines[k]?.includes(tag)) return true
  }
  return false
}

const files = walk(srcDir)
const counts = {} // rule -> rel -> count
const details = {} // rule -> [msg]
const bump = (name, rel, msg) => {
  ;(counts[name] ??= {})[rel] = ((counts[name] ??= {})[rel] ?? 0) + 1
  ;(details[name] ??= []).push(msg)
}

for (const file of files) {
  const rel = relative(srcDir, file)
  const content = readFileSync(file, 'utf8')
  const lines = content.split('\n')

  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.ext && !rule.ext.some((e) => file.endsWith(e))) continue
      if (rule.scope && !rel.startsWith(rule.scope)) continue
      if (allowed(rule, rel)) continue
      if (!rule.pattern.test(line)) continue
      if (waived(rule.name, lines, i)) continue
      bump(rule.name, rel, `src/${rel}:${i + 1}  [${rule.name}]  ${line.trim().slice(0, 100)}`)
    }
  })

  // hand-styled-button: scan whole <button …> open tags (can span lines).
  if (file.endsWith('.tsx') && !allowed(BUTTON_RULE, rel)) {
    for (const m of content.matchAll(/<button\b[^>]*>/gs) ?? []) {
      const tag = m[0]
      const cls = tag.match(/className=\{?["'`]([^"'`]*)/)?.[1] ?? ''
      if (!/\b(?:bg-|border|rounded|shadow|px-\d|h-\d)/.test(cls)) continue
      const lineNo = content.slice(0, m.index).split('\n').length
      if (waived(BUTTON_RULE.name, lines, lineNo - 1)) continue
      bump(BUTTON_RULE.name, rel, `src/${rel}:${lineNo}  [hand-styled-button]  ${tag.replace(/\s+/g, ' ').slice(0, 100)}`)
    }
  }
}

if (updateBaseline) {
  writeFileSync(baselinePath, JSON.stringify(counts, null, 1) + '\n')
  const total = Object.values(counts).reduce((a, r) => a + Object.values(r).reduce((x, y) => x + y, 0), 0)
  console.log(`Baseline updated: ${total} existing violation(s) recorded in ${relative(process.cwd(), baselinePath)}`)
  process.exit(0)
}

const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {}
let failures = 0

for (const [name, byFile] of Object.entries(counts)) {
  for (const [rel, n] of Object.entries(byFile)) {
    const allowedCount = baseline[name]?.[rel] ?? 0
    if (n > allowedCount) {
      failures += n - allowedCount
      const msgs = details[name].filter((m) => m.startsWith(`src/${rel}:`))
      for (const msg of msgs.slice(0, Math.max(1, n - allowedCount))) console.log(msg)
      if (allowedCount > 0) console.log(`  ^ ${rel}: ${n} found, baseline allows ${allowedCount}`)
    }
  }
}

// Stale baseline entries: file now clean (or better) - shrink the baseline.
let stale = 0
for (const [name, byFile] of Object.entries(baseline)) {
  for (const [rel, n] of Object.entries(byFile)) {
    const now = counts[name]?.[rel] ?? 0
    if (now < n) stale++
  }
}

if (failures > 0) {
  console.log(`\n${failures} design-contract violation(s) above baseline. See agents.md > Visual Language.`)
  console.log('Sanctioned exceptions: add a `design-ok(rule-name): reason` comment or a rule allowlist entry.')
  process.exit(1)
}
if (stale > 0) {
  console.log(`No new violations. ${stale} baseline entr(y/ies) are now better than recorded - run with --update-baseline to shrink the baseline.`)
} else {
  console.log('No design-contract violations found.')
}
