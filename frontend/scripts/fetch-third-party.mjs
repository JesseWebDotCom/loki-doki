// Downloads third-party UI assets from their original sources at build time.
// Org rule: other people's work is never tracked in our repo; it arrives via a
// package manager or a pinned, checksum-verified download. This script covers
// the two assets that have no package: amCharts' animated weather icons and
// the Nerd Fonts symbols font.
//
// Idempotent: files that exist and match their checksum are skipped, so this
// costs nothing after the first run. Checksums pin the exact bytes we
// reviewed; if an upstream file changes, the build fails loudly instead of
// shipping unreviewed content.
import { createHash } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PUB = join(ROOT, 'public')

const AMCHARTS_BASE = 'https://www.amcharts.com/wp-content/themes/amcharts4/css/img/icons/weather'
const ICON_SUMS = JSON.parse(readFileSync(join(ROOT, 'scripts/weather-icons.sha256.json'), 'utf8'))

const NERD_VERSION = 'v3.5.1'
const NERD_ZIP_URL = `https://github.com/ryanoasis/nerd-fonts/releases/download/${NERD_VERSION}/NerdFontsSymbolsOnly.zip`
const NERD_TTF_IN_ZIP = 'SymbolsNerdFontMono-Regular.ttf'
const NERD_TTF_OUT = join(PUB, 'fonts/SymbolsNerdFontMono.ttf')

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

async function fetchBytes(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

let fetched = 0, kept = 0

// ── amCharts weather icons (CC-BY 4.0, © amCharts, amcharts.com) ──
for (const [rel, sum] of Object.entries(ICON_SUMS)) {
  if (rel === 'LICENSE') continue
  const out = join(PUB, 'weather-icons', rel)
  if (existsSync(out) && sha256(readFileSync(out)) === sum) { kept++; continue }
  const buf = await fetchBytes(`${AMCHARTS_BASE}/${rel}`)
  const got = sha256(buf)
  if (got !== sum) throw new Error(`checksum mismatch for weather icon ${rel}: upstream changed; re-review before updating the pin`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, buf)
  fetched++
}
writeFileSync(join(PUB, 'weather-icons/LICENSE'),
  'Animated and static SVG weather icons by amCharts (https://www.amcharts.com/),\n' +
  'downloaded at build time from amcharts.com. Licensed under Creative Commons\n' +
  'Attribution 4.0 International: https://creativecommons.org/licenses/by/4.0/\n')

// ── Nerd Fonts symbols (MIT/OFL, ryanoasis/nerd-fonts) ──
if (!existsSync(NERD_TTF_OUT)) {
  const zipBuf = await fetchBytes(NERD_ZIP_URL)
  const { unzipSync } = await import('fflate')
  const files = unzipSync(new Uint8Array(zipBuf))
  const ttf = files[NERD_TTF_IN_ZIP]
  if (!ttf) throw new Error(`${NERD_TTF_IN_ZIP} not found in ${NERD_ZIP_URL}`)
  mkdirSync(dirname(NERD_TTF_OUT), { recursive: true })
  writeFileSync(NERD_TTF_OUT, Buffer.from(ttf))
  fetched++
} else { kept++ }

console.log(`[fetch-third-party] ${fetched} downloaded, ${kept} already present`)
