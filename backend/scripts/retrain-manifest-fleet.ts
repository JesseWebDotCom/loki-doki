// Retrain the committed default-companion wake-word manifest under the fixed
// pipeline (real-negative bank + event-replay calibration + hard gate, see
// WAKEWORD-ACCURACY-DESIGN-2026-07-16.md). Unlike retrain-fleet-with-eval.ts
// (which reads live characters/wakeWordCatalog DB rows), this trains directly
// from DEFAULT_COMPANIONS' phrases and writes trained-manifest.json — the
// pre-baked baseline fresh installs seed from (see companionWake.ts's
// seedWakewordsFromManifest). Run this to refresh that baseline itself.
//
// Order: an explicit PRIORITY list first (the 9 companions renamed to fix
// wake-word false triggers), then every other DEFAULT_COMPANIONS phrase not
// already in the manifest at a passing gate. Already-passing entries are
// skipped so an interrupted run resumes for free.
//
// A phrase's retrain is applied ONLY if it passes the certification gate
// (<=1 FA/hr, >=85% recall on real audio) — same rule trainWakeword/
// companionWake use live. A failing retrain is logged and the manifest is
// left untouched for that phrase (never regress a working baseline).
//
// Usage: bun scripts/retrain-manifest-fleet.ts
// Long-running (each phrase is ~10-15 min); run detached:
//   cd backend && nohup bun scripts/retrain-manifest-fleet.ts > <log> 2>&1 &
import '@/lib/logger'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_COMPANIONS } from '@/lib/defaultCompanions'
import { trainWakeword } from '@/lib/voice/wakewordTrainer'
import { wakewordDir } from '@/lib/download'

interface ManifestEntry { id: string; phrase: string; file: string; threshold: number | null; accuracy: number | null }

const MANIFEST_PATH = join(wakewordDir(), 'trained-manifest.json')
const normPhrase = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

// The 9 companions renamed to fix wake-word false triggers (design doc P1.6) —
// train these first. "Hey Loki Doki" is deliberately absent: already retrained
// and shipped as trained_hey_loki_doki_v2 in an earlier pass.
const PRIORITY_PHRASES = [
  'Hey Doki Doki', 'Hey Bruno', 'Hey Serena', 'Hey Pippa', 'Hey Lucia',
  'Hey Vincent', 'Hey Alfred', 'Hey Oliver', 'Hey Nadia',
]

function loadManifest(): ManifestEntry[] {
  if (!existsSync(MANIFEST_PATH)) return []
  try { return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as ManifestEntry[] }
  catch { return [] }
}

function saveManifest(m: ManifestEntry[]): void {
  writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 4) + '\n')
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

async function retrainOne(phrase: string, manifest: ManifestEntry[]): Promise<void> {
  const norm = normPhrase(phrase)
  const existing = manifest.filter((e) => normPhrase(e.phrase) === norm)
  if (existing.length && existing.some((e) => existsSync(join(wakewordDir(), e.file)))) {
    log(`SKIP "${phrase}" — manifest already has a model on disk (${existing[0]!.id})`)
    return
  }

  const id = `trained_${slugify(phrase)}_${Date.now().toString(36)}`
  let lastStep = ''
  log(`START "${phrase}" → ${id}`)
  let result: Awaited<ReturnType<typeof trainWakeword>>
  try {
    result = await trainWakeword(
      phrase, id,
      (p) => { if (p.step !== lastStep) { lastStep = p.step; log(`  [${phrase}] ${p.step}: ${p.msg}`) } },
      undefined, null,
    )
  } catch (e) {
    log(`FAIL "${phrase}" — training threw: ${(e as Error).message}`)
    return
  }

  if (result.gatePass !== true) {
    log(`GATE-FAIL "${phrase}" — ${result.gateReason ?? 'no gate reason'}; manifest left unchanged`)
    // Clean up the failed attempt's onnx so it doesn't clutter the data dir.
    const failedPath = join(wakewordDir(), `${id}.onnx`)
    if (existsSync(failedPath)) { try { unlinkSync(failedPath) } catch { /* best-effort */ } }
    return
  }

  // Passed: replace any prior entries for this phrase (dedupe), removing their
  // stale .onnx files, then add the new entry and persist immediately so an
  // interrupted run loses at most the one phrase in flight.
  for (const old of existing) {
    const oldPath = join(wakewordDir(), old.file)
    if (existsSync(oldPath)) { try { unlinkSync(oldPath) } catch { /* best-effort */ } }
  }
  const kept = manifest.filter((e) => normPhrase(e.phrase) !== norm)
  kept.push({ id, phrase, file: `${id}.onnx`, threshold: result.threshold ?? 0.6, accuracy: result.accuracy ?? null })
  manifest.length = 0
  manifest.push(...kept)
  saveManifest(manifest)
  log(`PASS "${phrase}" → ${id} (threshold ${(result.threshold ?? 0.6).toFixed(2)}, accuracy ${((result.accuracy ?? 0) * 100).toFixed(1)}%) — manifest saved`)
}

async function main(): Promise<void> {
  const allPhrases = DEFAULT_COMPANIONS.map((c) => c.wakeWordPhrase)
  const priority = PRIORITY_PHRASES.filter((p) => allPhrases.some((a) => normPhrase(a) === normPhrase(p)))
  const rest = allPhrases.filter((p) => !priority.some((pr) => normPhrase(pr) === normPhrase(p)) && normPhrase(p) !== normPhrase('Hey Loki Doki'))
  const ordered = [...priority, ...rest]

  log(`Fleet retrain: ${ordered.length} phrases (${priority.length} priority + ${rest.length} rest). Manifest: ${MANIFEST_PATH}`)

  let done = 0
  for (const phrase of ordered) {
    const manifest = loadManifest() // reload each iteration so partial progress is never lost
    await retrainOne(phrase, manifest)
    done++
    log(`PROGRESS ${done}/${ordered.length} phrases attempted`)
  }
  log('Fleet retrain complete.')
}

await main()
process.exit(0)
