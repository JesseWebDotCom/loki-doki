import { ollamaEmbed } from './ollama'

export const EMBED_MODEL = 'nomic-embed-text'
// Dedicated router encoder — wider similarity spread than nomic, better separation
// between conversational and tool-intent messages for threshold-based routing.
export const ROUTER_EMBED_MODEL = 'all-minilm'

export async function embed(text: string): Promise<number[]> {
  return ollamaEmbed(EMBED_MODEL, text)
}

export async function embedForRouter(text: string): Promise<number[]> {
  return ollamaEmbed(ROUTER_EMBED_MODEL, text)
}

// ── Parsed-vector cache ───────────────────────────────────────────────────────
// Embeddings are stored as JSON text (~15 KB of "0.0123," per row); recall and the
// judge used to JSON.parse up to 150 of them on every cache-miss turn. Parse once
// per (row id, version) and reuse the Float64 result. Bounded — a full clear at
// the cap is simpler and safer than LRU bookkeeping at this scale.
const _vecCache = new Map<string, number[]>()
const VEC_CACHE_MAX = 4000

/**
 * Parse a stored embedding once and cache it. `key` must change when the row's
 * embedding changes — use `${rowId}:${updatedAtMs}`. Returns null on bad JSON.
 */
export function cachedVector(key: string, json: string): number[] | null {
  const hit = _vecCache.get(key)
  if (hit) return hit
  try {
    const vec = JSON.parse(json) as number[]
    if (!Array.isArray(vec) || vec.length === 0) return null
    if (_vecCache.size >= VEC_CACHE_MAX) _vecCache.clear()
    _vecCache.set(key, vec)
    return vec
  } catch {
    return null
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let magA = 0
  let magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    magA += a[i]! * a[i]!
    magB += b[i]! * b[i]!
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB)
  return denom === 0 ? 0 : dot / denom
}
