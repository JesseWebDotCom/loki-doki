// Composites the README hero image from pipeline screenshots — desktop home with the
// kid's phone view overlapping — so the hero is a real product shot that refreshes with
// every docs run instead of a hand-maintained static graphic.
//
// Inputs (must exist; produced by docs-screenshot.mjs):
//   docs/src/assets/screenshots/home-desktop.png
//   docs/src/assets/screenshots/home-kid-mobile.png
// Output:
//   docs/src/assets/screenshots/hero.png  (3200x1680 @2x)
//
// Usage: node scripts/docs-hero.mjs   (or via `bun run shots:hero`)
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { chromium } = await import(join(here, '../../backend/node_modules/playwright/index.mjs'))

const SHOTS = join(here, '../../docs/src/assets/screenshots')
const desktop = join(SHOTS, 'home-desktop.png')
const phone = join(SHOTS, 'home-kid-mobile.png')
const out = join(SHOTS, 'hero.png')

for (const f of [desktop, phone]) {
  if (!existsSync(f)) {
    console.error(`ERROR: missing ${f} — run \`bun run shots:docs home\` first`)
    process.exit(1)
  }
}

const html = `<!doctype html>
<html><head><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1600px; height: 840px; overflow: hidden; position: relative;
    background:
      radial-gradient(900px 520px at 82% -10%, rgba(139, 92, 246, 0.28), transparent 65%),
      radial-gradient(700px 480px at 8% 108%, rgba(37, 99, 235, 0.22), transparent 60%),
      linear-gradient(160deg, #0d0a1a 0%, #0a0714 55%, #0c0918 100%);
  }
  .grid {
    position: absolute; inset: 0;
    background-image:
      linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px);
    background-size: 48px 48px;
    mask-image: radial-gradient(1000px 600px at 60% 30%, black, transparent 80%);
  }
  .desktop {
    position: absolute; top: 64px; left: 330px; width: 1210px;
    border-radius: 16px; border: 1px solid rgba(255,255,255,0.10);
    box-shadow: 0 40px 120px rgba(0,0,0,0.65), 0 0 80px rgba(139,92,246,0.12);
  }
  .phone {
    position: absolute; left: 96px; bottom: -74px; width: 252px;
    border-radius: 34px; border: 1px solid rgba(255,255,255,0.14);
    box-shadow: 0 32px 90px rgba(0,0,0,0.7), 0 0 60px rgba(37,99,235,0.16);
  }
</style></head>
<body>
  <div class="grid"></div>
  <img class="desktop" src="${pathToFileURL(desktop)}">
  <img class="phone" src="${pathToFileURL(phone)}">
</body></html>`

// setContent() pages are about:blank-origin and Chromium refuses their file:// image
// subresources — serve the montage from a real file:// page instead.
const tmp = mkdtempSync(join(tmpdir(), 'docs-hero-'))
const htmlPath = join(tmp, 'hero.html')
writeFileSync(htmlPath, html)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 840 }, deviceScaleFactor: 2 })
await page.goto(pathToFileURL(htmlPath).href)
await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0))
await page.waitForTimeout(200)
await page.screenshot({ path: out })
await browser.close()
rmSync(tmp, { recursive: true, force: true })
console.log(`hero → ${out}`)
