// Standalone "retrain every companion's wake word" — designed to SURVIVE run.sh.
//
// run.sh frees a fixed set of ports and `pkill`s "bun run dev" / "bun run --hot
// src/index.ts". This script holds NO ports and matches NONE of those patterns
// (it runs as a plain `bun scripts/retrain-all-wakewords.ts`), so an app restart
// doesn't kill it. It also waits for the Kokoro voice server — which run.sh
// restarts — to be healthy before each model, and skips models that were just
// trained, so a re-run only does the ones that still need it.
//
//   cd backend && nohup bun scripts/retrain-all-wakewords.ts > <log> 2>&1 &

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { characters, wakeWordCatalog } from '@/db/schema'
import { trainWakeword } from '@/lib/voice/wakewordTrainer'
import { isWakewordTrainInstalled } from '@/lib/download'
import { kokoroUrl } from '@/lib/voice/config'

// By default this is idempotent: skip any companion that ALREADY has a model with
// measured accuracy, so a re-run only trains the ones still missing one (a mop-up).
// Set FORCE_ALL=1 to retrain every companion regardless (a true full redo).
const FORCE_ALL = process.env.FORCE_ALL === '1'

async function voiceHealthy(): Promise<boolean> {
  try {
    const base = await kokoroUrl()
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) })
    if (!r.ok) return false
    const d = (await r.json()) as { kokoro?: boolean }
    return !!d.kokoro
  } catch {
    return false
  }
}

async function waitForVoice(): Promise<void> {
  for (let i = 0; i < 900; i++) { // up to ~30 min (covers a run.sh restart window)
    if (await voiceHealthy()) return
    if (i === 0) console.log('[retrain-all] waiting for the Kokoro voice server…')
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error('voice server never became healthy')
}

async function main(): Promise<void> {
  if (!isWakewordTrainInstalled()) {
    console.error('[retrain-all] Wake Word Training is not installed — nothing to do')
    process.exit(1)
  }
  const rows = await db.select().from(characters)
  const targets = rows.filter((c) => (c.wakeWordPhrase ?? '').trim())
  console.log(`[retrain-all] ${targets.length} companions with a wake phrase${FORCE_ALL ? ' (FORCE_ALL)' : ''}`)
  let trained = 0
  let skipped = 0
  let failed = 0

  for (let n = 0; n < targets.length; n++) {
    const c = targets[n]!
    const phrase = (c.wakeWordPhrase ?? '').trim()
    const tag = `(${n + 1}/${targets.length}) ${c.name}`

    // Skip if it already has a trained model with measured accuracy (unless FORCE_ALL).
    if (!FORCE_ALL && c.wakeWordModelId) {
      const [m] = await db.select().from(wakeWordCatalog).where(eq(wakeWordCatalog.id, c.wakeWordModelId)).limit(1)
      if (m && m.accuracy != null) {
        console.log(`[retrain-all] ${tag} — skip, already trained (${Math.round(m.accuracy * 100)}%)`)
        skipped++
        continue
      }
    }

    await waitForVoice()
    const slug = phrase.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    const id = `trained_${slug}_${Date.now().toString(36)}`
    try {
      console.log(`[retrain-all] ${tag} — training "${phrase}"…`)
      const { threshold, accuracy } = await trainWakeword(phrase, id, () => {}, undefined, null)
      const now = new Date()
      await db
        .insert(wakeWordCatalog)
        .values({
          id, label: phrase, kind: 'trained', assetPath: `${id}.onnx`,
          defaultThreshold: threshold ?? 0.6, accuracy: accuracy ?? null,
          characterId: c.id, enabled: true, createdAt: now, updatedAt: now,
        })
        .onConflictDoUpdate({ target: wakeWordCatalog.id, set: { assetPath: `${id}.onnx`, accuracy: accuracy ?? null, updatedAt: now } })
      await db.update(characters).set({ wakeWordModelId: id, updatedAt: now }).where(eq(characters.id, c.id))
      console.log(`[retrain-all] ✅ ${tag} → ${accuracy != null ? Math.round(accuracy * 100) + '%' : '?'} (fires at ${threshold ?? '?'})`)
      trained++
    } catch (e) {
      console.warn(`[retrain-all] ✗ ${tag}: ${(e as Error).message}`)
      failed++
    }
  }

  console.log(`[retrain-all] DONE — trained ${trained}, skipped ${skipped}, failed ${failed}`)
  process.exit(0)
}

void main()
