// Retrain a single wake phrase with the current (fixed) pipeline and register it
// in the catalog WITHOUT reassigning any companion — so the FA eval can compare
// old vs new before switching. Assign manually (or via Admin → Wakewords) after
// verification.
//
// Usage: bun run scripts/eval/retrain-one-wakeword.ts "hey loki"
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
