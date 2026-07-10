// Copy alphaTab's SMuFL music font into public/alphatab/font so the guitar-tab renderer
// (AlphaTabView.tsx) can load it at runtime via core.fontDirectory. These files come from the
// @coderline/alphatab npm package and are regenerable, so they're gitignored rather than
// committed. The soundfont is NOT copied — AlphaTabView disables alphaTab's own synth
// (PlayerMode.EnabledExternalMedia drives the cursor off the app's own StemEngine instead), so
// no audio samples are ever needed. Runs automatically before dev/build.
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '../node_modules/@coderline/alphatab/dist/font')
const dest = join(here, '../public/alphatab/font')

if (!existsSync(src)) {
  console.log('[copy-alphatab] @coderline/alphatab not installed, skipping')
} else {
  mkdirSync(dest, { recursive: true })
  cpSync(src, dest, { recursive: true })
  console.log('[copy-alphatab] staged SMuFL font → public/alphatab/font')
}
