// Read-through embedding cache for the interest engine. Pool builds embed the same
// titles across rebuilds (a user's history changes slowly; trending candidates recur),
// so vectors persist in lookup_cache for 30 days and parse once per process via an
// in-memory map. Failures (Ollama down / model missing) return null — the ranker
// degrades to non-cosine scoring instead of failing the build.

import { embed } from '@/llm/embed'
import { cachedLookup, THIRTY_DAYS_MS } from '@/lib/lookupCache'
import { logger } from '@/lib/logger'

const NAMESPACE = 'interests:emb'

// Parse-once cache, bounded like llm/embed.ts's _vecCache (full clear beats LRU
// bookkeeping at this scale).
const _mem = new Map<string, number[] | null>()
const MEM_MAX = 4000

export async function embedCached(text: string): Promise<number[] | null> {
  const key = text.trim().toLowerCase()
  if (!key) return null
  const hit = _mem.get(key)
  if (hit !== undefined) return hit

  let vec: number[] | null
  try {
    vec = await cachedLookup<number[]>(NAMESPACE, key, THIRTY_DAYS_MS, () => embed(text))
    if (!Array.isArray(vec) || vec.length === 0) vec = null
  } catch (err) {
    // Not cached (cachedLookup never writes on fetcher throw) — retried next build.
    logger.debug(`[interests] embed failed for "${text.slice(0, 60)}": ${String(err)}`)
    vec = null
  }
  if (_mem.size >= MEM_MAX) _mem.clear()
  _mem.set(key, vec)
  return vec
}
