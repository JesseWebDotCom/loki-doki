// Wakeword false-accept / recall regression harness.
//
// Builds a reproducible audio bank (Kokoro speech = "TV dialog" proxy, near-miss
// phrases, colored noise, silence, real MS-SNSD room recordings, plus positive
// utterances), streams it through the REAL detection pipeline (lib/pod/wake.ts —
// the ort-web port both the browser loop and the Wyoming/Tab5 path share),
// records the smoothed score stream once per model, then evaluates fires
// offline for any threshold × hysteresis combination:
//   - FA/hr at the calibrated threshold, browser params (hyst 2) vs pod (hyst 4)
//   - recall on positives at the same settings
//   - a threshold sweep with a recommendation meeting the FA target
//
// Scoring core lives in wakewordEvalCore.ts, shared with retrain-fleet-with-eval.ts.
//
// Usage:
//   bun run scripts/eval/wakeword-fa-eval.ts [modelId ...]   (default: hey_loki latest + hey_jarvis)
// Must be the first import: @/lib/download and @/lib/logger form a circular pair
// (download.ts imports logger.ts; logger.ts imports `dataDir` back from
// download.ts and calls makeLogger() — which reads `dataDir` — synchronously at
// its own module top level). Whichever of the two starts loading FIRST in the
// whole graph determines the outcome: if download.ts loads first, logger.ts's
// nested re-entry hits `dataDir` while it's still in its temporal dead zone
// ("Cannot access 'dataDir' before initialization"); if logger.ts loads first,
// its own nested import of download.ts finishes cleanly before logger.ts needs
// the value. This entry point doesn't go through the main app's bootstrap (which
// happens to import logger first), so force the safe order explicitly here.
import '@/lib/logger'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BANK_DIR, SR, buildNegativeBank, buildPositiveBank, scoreStream, countFires, POSITIVE_COUNT } from './wakewordEvalCore'
import { db } from '@/db'
import { wakeWordCatalog } from '@/db/schema'
import { eq } from 'drizzle-orm'

const TARGET_FAPH = 1.0

const modelIds = process.argv.slice(2).filter(a => !a.startsWith('--'))
if (modelIds.length === 0) modelIds.push('trained_hey_loki_mqwl8glv', 'hey_jarvis')

const POSITIVE_PHRASE: Record<string, string> = {} // modelId → phrase, resolved below

console.log('Building negative bank (cached after first run)…')
const negBanks = await buildNegativeBank()
const negTotalSec = negBanks.reduce((n, b) => n + b.audio.length, 0) / SR
console.log(`Negative bank: ${negBanks.map(b => `${b.label}=${Math.round(b.audio.length / SR)}s`).join(' ')} (total ${Math.round(negTotalSec)}s)\n`)

for (const modelId of modelIds) {
  const [row] = await db.select().from(wakeWordCatalog).where(eq(wakeWordCatalog.id, modelId)).limit(1)
  const calibrated = row?.defaultThreshold ?? 0.5
  const phrase = POSITIVE_PHRASE[modelId]
    ?? (row?.label?.toLowerCase().replace(/[^a-z ]/g, '').trim()
      // Only strip a trailing random-id token from OUR trained ids (trained_<slug>_<ts>).
      // Pretrained openWakeWord ids (e.g. "hey_jarvis") must NOT lose their last word:
      // the old blanket `_[a-z0-9]+$` strip turned "hey_jarvis" into "hey", giving a
      // bogus 0% recall (the harness scored the phrase "hey").
      || (modelId.startsWith('trained_')
        ? modelId.replace(/^trained_/, '').replace(/_[a-z0-9]+$/, '').replace(/_/g, ' ')
        : modelId.replace(/_/g, ' ')))

  console.log(`\n═══ ${modelId} (phrase "${phrase}", calibrated threshold ${calibrated}) ═══`)

  const negScores: Record<string, number[]> = {}
  for (const bank of negBanks) {
    const t0 = performance.now()
    negScores[bank.label] = await scoreStream(modelId, bank.audio)
    console.log(`  scored ${bank.label}: ${negScores[bank.label]!.length} frames in ${Math.round((performance.now() - t0) / 1000)}s, peak=${Math.max(...negScores[bank.label]!, 0).toFixed(3)}`)
  }
  const posBank = await buildPositiveBank(phrase)
  const posScores = await scoreStream(modelId, posBank.audio)
  console.log(`  scored positives: ${posScores.length} frames, peak=${Math.max(...posScores).toFixed(3)}`)

  const table = (threshold: number, hysteresis: number) => {
    const perBank = negBanks.map(b => countFires(negScores[b.label]!, threshold, hysteresis))
    const totalFa = perBank.reduce((a, b) => a + b, 0)
    const faPerHr = totalFa / (negTotalSec / 3600)
    const recalled = countFires(posScores, threshold, hysteresis)
    return { perBank, faPerHr, recall: recalled / POSITIVE_COUNT }
  }

  // Persist raw score streams so thresholds/hysteresis can be re-analyzed offline.
  writeFileSync(join(BANK_DIR, `scores_${modelId}.json`), JSON.stringify({ negScores, posScores, posCount: POSITIVE_COUNT, negTotalSec, calibrated }))

  console.log(`\n  ${'config'.padEnd(34)} FA/hr   recall  fires(${negBanks.map(b => b.label).join('/')})`)
  for (const [label, th, hy] of [
    [`browser (hyst 2, th ${calibrated})`, calibrated, 2],
    [`mid     (hyst 3, th ${calibrated})`, calibrated, 3],
    [`pod     (hyst 4, th ${calibrated})`, calibrated, 4],
  ] as [string, number, number][]) {
    const r = table(th, hy)
    console.log(`  ${label.padEnd(34)} ${r.faPerHr.toFixed(1).padStart(5)}   ${(r.recall * 100).toFixed(0).padStart(4)}%   ${r.perBank.join('/')}`)
  }

  console.log(`\n  threshold sweep (hysteresis 2 = browser / 3 = mid / 4 = pod):`)
  console.log(`  thr    FA/hr(h2)  rec(h2)   FA/hr(h3)  rec(h3)   FA/hr(h4)  rec(h4)`)
  let recommended: { th: number; hy: number } | null = null
  for (let th = 0.40; th <= 0.72; th += 0.02) {
    const t = Math.round(th * 100) / 100
    const h2 = table(t, 2), h3 = table(t, 3), h4 = table(t, 4)
    console.log(`  ${t.toFixed(2)}   ${h2.faPerHr.toFixed(1).padStart(7)}   ${(h2.recall * 100).toFixed(0).padStart(5)}%   ${h3.faPerHr.toFixed(1).padStart(7)}   ${(h3.recall * 100).toFixed(0).padStart(5)}%   ${h4.faPerHr.toFixed(1).padStart(7)}   ${(h4.recall * 100).toFixed(0).padStart(5)}%`)
    for (const [hy, r] of [[3, h3], [4, h4]] as [number, ReturnType<typeof table>][]) {
      if (!recommended && r.faPerHr <= TARGET_FAPH && r.recall >= 0.75) recommended = { th: t, hy }
    }
  }
  if (recommended) console.log(`\n  → recommended: threshold ${recommended.th} @ hysteresis ${recommended.hy} (≤${TARGET_FAPH} FA/hr on this bank, recall ≥75%)`)
  else console.log(`\n  → no threshold in sweep met ≤${TARGET_FAPH} FA/hr with recall ≥75% — model needs retraining`)
}
process.exit(0)
