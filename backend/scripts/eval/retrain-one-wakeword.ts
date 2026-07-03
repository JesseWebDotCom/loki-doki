// Retrain a single wake phrase with the current (fixed) pipeline and register it
// in the catalog WITHOUT reassigning any companion — so the FA eval can compare
// old vs new before switching. Assign manually (or via Admin → Wakewords) after
// verification.
//
// Usage: bun run scripts/eval/retrain-one-wakeword.ts "hey loki"
// Must be the first import: @/lib/download and @/lib/logger form a circular
// pair (download.ts imports logger.ts; logger.ts imports `dataDir` back from
// download.ts and reads it synchronously at its own module top level via
// makeLogger()). Standalone entry points like this one don't go through the
// main app's bootstrap (which happens to import logger first), so whichever
// of the two a script's own import graph reaches FIRST determines whether
// `dataDir` is still in its temporal dead zone when logger.ts runs. Importing
// this first forces the safe order regardless of what else changes upstream.
import '@/lib/logger'
import { db } from '@/db'
import { wakeWordCatalog } from '@/db/schema'
import { trainWakeword } from '@/lib/voice/wakewordTrainer'
import { isWakewordTrainInstalled } from '@/lib/download'

const phrase = (process.argv[2] ?? '').trim()
if (!phrase) { console.error('usage: retrain-one-wakeword.ts "<phrase>"'); process.exit(1) }
if (!isWakewordTrainInstalled()) { console.error('wake word training not installed'); process.exit(1) }

const slug = phrase.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
const id = `trained_${slug}_${Date.now().toString(36)}`

console.log(`training "${phrase}" → ${id}`)
const { threshold, accuracy } = await trainWakeword(
  phrase, id,
  (p) => console.log(`  [${p.step}] ${p.msg ?? ''} ${p.pct != null ? p.pct + '%' : ''}`),
  undefined, null,
)
const now = new Date()
await db.insert(wakeWordCatalog).values({
  id, label: phrase, kind: 'trained', assetPath: `${id}.onnx`,
  defaultThreshold: threshold ?? 0.6, accuracy: accuracy ?? null,
  characterId: null, enabled: true, createdAt: now, updatedAt: now,
})
console.log(`done: ${id} threshold=${threshold} accuracy=${accuracy}`)
console.log(`verify with: bun run eval:wakeword ${id}`)
process.exit(0)
