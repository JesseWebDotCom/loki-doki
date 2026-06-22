// Copy the onnxruntime-web WASM runtime into public/ort so the wake-word engine
// can load it offline (served at /ort/*). These files come from the
// onnxruntime-web npm package and are regenerable, so they're gitignored rather
// than committed (~38 MB). Runs automatically before dev/build.
import { mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '../node_modules/onnxruntime-web/dist')
const dest = join(here, '../public/ort')

const FILES = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
]

mkdirSync(dest, { recursive: true })
let copied = 0
for (const f of FILES) {
  const from = join(src, f)
  if (existsSync(from)) {
    copyFileSync(from, join(dest, f))
    copied++
  }
}
console.log(`[copy-ort] staged ${copied}/${FILES.length} onnxruntime-web files → public/ort`)
