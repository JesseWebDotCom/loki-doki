/**
 * Weekly memory consolidation + contradiction sweep.
 *
 * The judge only merges facts opportunistically (when a NEW similar fact
 * arrives), so a store accumulates near-duplicate phrasings that never co-occur
 * in one judge batch, and dissimilarly-phrased contradictions both stay active.
 * This pass fixes both, offline, on the sweep's cadence:
 *
 *   1. MERGE: active pairs in the same scope with cosine >= MERGE_COSINE are
 *      merged by the LLM into one statement; the losers are superseded with a
 *      link to the merged row.
 *   2. CONTRADICTION: durable pairs in the same category with a mid cosine
 *      (related but not duplicate) are checked by the LLM; when they contradict,
 *      the older row is superseded by the newer one.
 *
 * Both passes are hard-bounded per run so a big store amortizes over weeks
 * instead of monopolizing the model. Self-gated to at most once per
 * CONSOLIDATION_INTERVAL_DAYS via an app_settings stamp.
 */

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { memories } from '@/db/schema'
import { cosineSimilarity, cachedVector, embed } from '@/llm/embed'
import { structuredCall } from '@/llm/structured'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { invalidateAllMemoryBlocks } from './blockCache'
import { logger } from '@/lib/logger'

const CONSOLIDATION_INTERVAL_DAYS = 7
const STAMP_KEY = 'memory.last_consolidation_at'

const MERGE_COSINE = 0.86
const CONTRA_COSINE_MIN = 0.55
const CONTRA_COSINE_MAX = 0.86
const MAX_MERGES_PER_RUN = 10
const MAX_CONTRA_CHECKS_PER_RUN = 15

const MERGE_PROMPT = `These two remembered facts about the same person overlap. Merge them into ONE accurate statement that keeps every distinct detail. Reply with EXACTLY one JSON object: {"text":"<merged statement>"}.

Fact A: "{a}"
Fact B: "{b}"`

const CONTRA_PROMPT = `Do these two remembered facts CONTRADICT each other (both cannot be true at once — e.g. "lives in NYC" vs "lives in Boston"), or can they coexist (e.g. "likes coffee" and "likes tea")? Reply with EXACTLY one JSON object: {"contradicts":true|false}.

Fact A (older): "{a}"
Fact B (newer): "{b}"`

type MemRow = typeof memories.$inferSelect

function scopeKey(m: MemRow): string {
  return `${m.userId ?? ''}:${m.characterId ?? ''}`
}

function vecOf(m: MemRow): number[] | null {
  if (!m.embedding) return null
  return cachedVector(`${m.id}:${m.updatedAt?.getTime() ?? 0}`, m.embedding)
}

export async function runConsolidation(model: string): Promise<void> {
  const last = (await getAppSetting(STAMP_KEY)) as number | null
  if (last && Date.now() - last < CONSOLIDATION_INTERVAL_DAYS * 86_400_000) return
  await setAppSetting(STAMP_KEY, Date.now())

  const rows = await db.select().from(memories).where(eq(memories.status, 'active'))
  if (rows.length < 2) return

  // Group by scope — merges/contradictions only make sense within one scope.
  const byScope = new Map<string, MemRow[]>()
  for (const r of rows) {
    const key = scopeKey(r)
    const arr = byScope.get(key) ?? []
    arr.push(r)
    byScope.set(key, arr)
  }

  let merges = 0
  let contraChecks = 0
  let contradictions = 0
  const superseded = new Set<string>()

  for (const scopeRows of byScope.values()) {
    for (let i = 0; i < scopeRows.length; i++) {
      const a = scopeRows[i]!
      if (superseded.has(a.id)) continue
      const va = vecOf(a)
      if (!va) continue
      for (let j = i + 1; j < scopeRows.length; j++) {
        const b = scopeRows[j]!
        if (superseded.has(b.id) || superseded.has(a.id)) continue
        const vb = vecOf(b)
        if (!vb) continue
        const cos = cosineSimilarity(va, vb)

        // ── Pass 1: near-duplicate merge ───────────────────────────────────
        if (cos >= MERGE_COSINE && merges < MAX_MERGES_PER_RUN) {
          try {
            const out = await structuredCall<{ text: string }>(
              model,
              MERGE_PROMPT.replace('{a}', a.text).replace('{b}', b.text),
            )
            const mergedText = out?.text?.trim()
            if (!mergedText || mergedText.length < 5) continue
            const now = new Date()
            // Keep the row with the higher importance/tier as the survivor.
            const keep = (a.tier === 'durable') === (b.tier === 'durable')
              ? (a.importance >= b.importance ? a : b)
              : (a.tier === 'durable' ? a : b)
            const drop = keep.id === a.id ? b : a
            const mergedEmbedding = await embed(mergedText)
            await db.update(memories)
              .set({ text: mergedText, embedding: JSON.stringify(mergedEmbedding), importance: Math.max(a.importance, b.importance), updatedAt: now })
              .where(eq(memories.id, keep.id))
            await db.update(memories)
              .set({ status: 'superseded', supersededBy: keep.id, updatedAt: now })
              .where(eq(memories.id, drop.id))
            superseded.add(drop.id)
            keep.text = mergedText
            merges++
          } catch { /* skip this pair */ }
          continue
        }

        // ── Pass 2: contradiction check (durable, same category, related) ───
        if (
          a.tier === 'durable' && b.tier === 'durable' && a.category === b.category &&
          cos >= CONTRA_COSINE_MIN && cos < CONTRA_COSINE_MAX &&
          contraChecks < MAX_CONTRA_CHECKS_PER_RUN
        ) {
          contraChecks++
          try {
            const older = a.createdAt.getTime() <= b.createdAt.getTime() ? a : b
            const newer = older.id === a.id ? b : a
            const out = await structuredCall<{ contradicts: boolean }>(
              model,
              CONTRA_PROMPT.replace('{a}', older.text).replace('{b}', newer.text),
            )
            if (out?.contradicts === true) {
              await db.update(memories)
                .set({ status: 'superseded', supersededBy: newer.id, updatedAt: new Date() })
                .where(eq(memories.id, older.id))
              superseded.add(older.id)
              contradictions++
            }
          } catch { /* skip this pair */ }
        }
      }
    }
  }

  if (merges > 0 || contradictions > 0) {
    invalidateAllMemoryBlocks()
    logger.info(`[memory:consolidate] merges=${merges} contradiction_checks=${contraChecks} superseded=${contradictions}`)
  }
}
