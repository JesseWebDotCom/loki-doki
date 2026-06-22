// Stage the full OpenMoji color SVG set into public/openmoji so podcast covers can
// pick from ~4000 icons offline, plus a slim search index (hex → name/tags) for
// smart, content-matched icon selection. These come from the `openmoji` npm
// package and are regenerable, so they're gitignored rather than committed.
// Runs automatically before dev/build.
import { mkdirSync, copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const svgSrc = join(here, '../node_modules/openmoji/color/svg')
const dataSrc = join(here, '../node_modules/openmoji/data/openmoji.json')
const dest = join(here, '../public/openmoji')

if (!existsSync(svgSrc)) {
  console.warn('[copy-openmoji] openmoji package not found — run `bun add openmoji`. Skipping.')
  process.exit(0)
}

mkdirSync(dest, { recursive: true })

// Copy every color SVG.
let copied = 0
for (const f of readdirSync(svgSrc)) {
  if (!f.endsWith('.svg')) continue
  copyFileSync(join(svgSrc, f), join(dest, f))
  copied++
}

// Build a slim search index: drop skin-tone variants, flags, and component glyphs
// (poor cover material), keep base pictographs with their name + tags.
let indexed = 0
try {
  const all = JSON.parse(readFileSync(dataSrc, 'utf8'))
  const SKIP_GROUPS = new Set(['flags', 'component'])
  const index = []
  for (const e of all) {
    if (e.skintone) continue
    if (SKIP_GROUPS.has(e.group)) continue
    const tags = `${e.tags ?? ''},${e.openmoji_tags ?? ''}`.toLowerCase().replace(/\s+/g, ' ').trim()
    index.push({ h: e.hexcode, a: String(e.annotation ?? '').toLowerCase(), t: tags, g: e.group })
    indexed++
  }
  writeFileSync(join(dest, 'index.json'), JSON.stringify(index))
} catch (err) {
  console.warn('[copy-openmoji] could not build index:', err?.message)
}

console.log(`[copy-openmoji] staged ${copied} SVGs + ${indexed} indexed icons → public/openmoji`)
