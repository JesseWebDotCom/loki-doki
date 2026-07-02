// Fleet-wide wakeword retrain WITH the eval-and-confirm gate — unlike
// retrain-all-wakewords.ts (which reassigns unconditionally), this only
// reassigns a companion's wake model when the freshly-trained candidate is a
// real improvement over what's currently live, measured on the same FA/recall
// harness as wakeword-fa-eval.ts (see wakewordEvalCore.ts, shared scoring code).
//
// Decision rule per companion (mirrors the manual Loki decision this session):
//   - candidate recall must clear an absolute floor (0.75) — never ship
//     something that misses 1-in-4 real wakes even if FA improved.
//   - then either a Pareto improvement (FA/hr no worse, recall no more than
//     5 points worse) or a "big win" override (FA/hr cut by half or more).
// Otherwise the candidate is trained and logged but left UNASSIGNED in the
// catalog — same "safe to delete later" clutter as retrain-one-wakeword.ts.
//
// Survives run.sh restarts by the same trick as retrain-all-wakewords.ts: this
// process holds no ports and doesn't match the "bun run dev" / "--hot src/index.ts"
// pkill patterns.
//
//   cd backend && nohup bun scripts/eval/retrain-fleet-with-eval.ts > <log> 2>&1 &
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { characters, wakeWordCatalog } from '@/db/schema'
import { trainWakeword } from '@/lib/voice/wakewordTrainer'
import { isWakewordTrainInstalled } from '@/lib/download'
import { kokoroUrl } from '@/lib/voice/config'
import { buildNegativeBank, buildPositiveBank, scoreModelAt } from './wakewordEvalCore'

const SR = 16_000
const RECALL_FLOOR = 0.75
const RECALL_TOLERANCE = 0.05
const BIG_WIN_FA_RATIO = 0.5
const HYSTERESIS = 2 // browser settings — the primary user-facing config

// Companions to skip (already retrained + verified manually this session).
const SKIP_CHARACTER_IDS = new Set(['5398be75-bf26-4891-a8cc-207bf0afe2cb']) // Loki

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
    if (i === 0) console.log('[fleet] waiting for the Kokoro voice server…')
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error('voice server never became healthy')
}

interface Result {
  name: string
  phrase: string
  championId: string | null
  championFa: number | null
  championRecall: number | null
  candidateId: string
  candidateFa: number
  candidateRecall: number
  shipped: boolean
  note?: string
}

function decide(championFa: number | null, championRecall: number | null, candidateFa: number, candidateRecall: number): boolean {
  if (candidateRecall < RECALL_FLOOR) return false
  if (championFa == null || championRecall == null) return true // no working champion to compare against
  const pareto = candidateFa <= championFa && candidateRecall >= championRecall - RECALL_TOLERANCE
  const bigWin = candidateFa <= championFa * BIG_WIN_FA_RATIO
  return pareto || bigWin
}

async function main(): Promise<void> {
  if (!isWakewordTrainInstalled()) {
    console.error('[fleet] Wake Word Training is not installed — nothing to do')
    process.exit(1)
  }

  console.log('[fleet] Building shared negative bank (cached after first run, reused for every companion)…')
  const negBanks = await buildNegativeBank()
  const negTotalSec = negBanks.reduce((n, b) => n + b.audio.length, 0) / SR
  console.log(`[fleet] Negative bank: ${negBanks.map(b => `${b.label}=${Math.round(b.audio.length / SR)}s`).join(' ')} (total ${Math.round(negTotalSec)}s)\n`)

  const rows = await db.select().from(characters)
  const targets = rows.filter((c) => (c.wakeWordPhrase ?? '').trim() && !SKIP_CHARACTER_IDS.has(c.id))
  console.log(`[fleet] ${targets.length} companions queued (${SKIP_CHARACTER_IDS.size} skipped as already done)\n`)

  const results: Result[] = []

  for (let n = 0; n < targets.length; n++) {
    const c = targets[n]!
    const phrase = (c.wakeWordPhrase ?? '').trim()
    const tag = `(${n + 1}/${targets.length}) ${c.name}`

    try {
      await waitForVoice()

      // ── Score the current champion first (own calibrated threshold) ──
      let championId: string | null = null
      let championFa: number | null = null
      let championRecall: number | null = null
      if (c.wakeWordModelId) {
        championId = c.wakeWordModelId
        const [row] = await db.select().from(wakeWordCatalog).where(eq(wakeWordCatalog.id, championId)).limit(1)
        const champThreshold = row?.defaultThreshold ?? 0.5
        try {
          const posBank = await buildPositiveBank(phrase)
          const r = await scoreModelAt(championId, champThreshold, HYSTERESIS, negBanks, negTotalSec, posBank)
          championFa = r.faPerHr
          championRecall = r.recall
          console.log(`[fleet] ${tag} — champion ${championId}: ${r.faPerHr.toFixed(1)} FA/hr, ${(r.recall * 100).toFixed(0)}% recall`)
        } catch (e) {
          console.warn(`[fleet] ${tag} — champion ${championId} failed to score (${(e as Error).message}); treating as no baseline`)
        }
      }

      // ── Train a candidate (unassigned) ──
      console.log(`[fleet] ${tag} — training "${phrase}"…`)
      const slug = phrase.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
      const candidateId = `trained_${slug}_${Date.now().toString(36)}`
      const { threshold, accuracy } = await trainWakeword(phrase, candidateId, () => {}, undefined, null)
      const candThreshold = threshold ?? 0.6
      const now = new Date()
      await db.insert(wakeWordCatalog).values({
        id: candidateId, label: phrase, kind: 'trained', assetPath: `${candidateId}.onnx`,
        defaultThreshold: candThreshold, accuracy: accuracy ?? null,
        characterId: null, enabled: true, createdAt: now, updatedAt: now,
      })

      // ── Score the candidate at the SAME config ──
      const posBank = await buildPositiveBank(phrase)
      const candResult = await scoreModelAt(candidateId, candThreshold, HYSTERESIS, negBanks, negTotalSec, posBank)
      console.log(`[fleet] ${tag} — candidate ${candidateId}: ${candResult.faPerHr.toFixed(1)} FA/hr, ${(candResult.recall * 100).toFixed(0)}% recall`)

      const ship = decide(championFa, championRecall, candResult.faPerHr, candResult.recall)
      if (ship) {
        await db.update(characters).set({ wakeWordModelId: candidateId, updatedAt: now }).where(eq(characters.id, c.id))
        console.log(`[fleet] ${tag} — ✅ SHIPPED (${championFa != null ? `${championFa.toFixed(1)}→` : ''}${candResult.faPerHr.toFixed(1)} FA/hr, ${championRecall != null ? `${(championRecall * 100).toFixed(0)}%→` : ''}${(candResult.recall * 100).toFixed(0)}% recall)`)
      } else {
        console.log(`[fleet] ${tag} — ⏸ KEPT CHAMPION (candidate did not clear the bar; left unassigned in the catalog)`)
      }

      results.push({
        name: c.name, phrase, championId, championFa, championRecall,
        candidateId, candidateFa: candResult.faPerHr, candidateRecall: candResult.recall, shipped: ship,
      })
    } catch (e) {
      console.warn(`[fleet] ${tag} — ✗ FAILED: ${(e as Error).message}`)
      results.push({
        name: c.name, phrase, championId: c.wakeWordModelId ?? null, championFa: null, championRecall: null,
        candidateId: '(failed)', candidateFa: NaN, candidateRecall: NaN, shipped: false, note: (e as Error).message,
      })
    }
  }

  const shipped = results.filter((r) => r.shipped).length
  const kept = results.filter((r) => !r.shipped && !r.note).length
  const failed = results.filter((r) => r.note).length
  console.log(`\n[fleet] DONE — ${shipped} shipped, ${kept} kept champion, ${failed} failed (of ${targets.length})\n`)
  console.log('[fleet] Summary:')
  for (const r of results) {
    const status = r.note ? `FAILED (${r.note})` : r.shipped ? 'SHIPPED' : 'KEPT'
    const champStr = r.championFa != null ? `${r.championFa.toFixed(1)}FA/${(r.championRecall! * 100).toFixed(0)}%` : 'n/a'
    const candStr = Number.isNaN(r.candidateFa) ? 'n/a' : `${r.candidateFa.toFixed(1)}FA/${(r.candidateRecall * 100).toFixed(0)}%`
    console.log(`  ${status.padEnd(8)} ${r.name.padEnd(12)} champion=${champStr.padEnd(14)} candidate=${candStr.padEnd(14)} ${r.shipped ? r.candidateId : ''}`)
  }
  process.exit(0)
}

void main()
