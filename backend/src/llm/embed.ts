import { ollamaEmbed } from './ollama'
import { CATALOG } from '@/lib/catalog'
import { getCachedAutotune } from '@/lib/engineAutotune'
import { isAutomatic } from '@/lib/resourceMode'

export const DEFAULT_EMBED_MODEL = 'nomic-embed-text'
// Dedicated router encoder — wider similarity spread than nomic, better separation
// between conversational and tool-intent messages for threshold-based routing.
// Shared by every model set on purpose: swapping it would invalidate the tool-router
// index for near-zero quality gain.
export const ROUTER_EMBED_MODEL = 'all-minilm'

// The general embedder is set-switchable. Hot paths need it synchronously (keep-alive
// policy) and embed() runs at high volume, so the resolved tag lives in a module cache:
// primed at boot via initEmbedModel(), updated by the model-set orchestrator on switch.
let activeEmbedModel = DEFAULT_EMBED_MODEL
let activeMrlDims: number | undefined

export function getEmbedModel(): string {
  return activeEmbedModel
}

/** Point embed() at a catalog embeddings entry (id === ollama tag for these). */
export function setEmbedModelCache(modelId: string): void {
  activeEmbedModel = modelId
  activeMrlDims = CATALOG.find((m) => m.id === modelId && m.role === 'embeddings')?.mrlDims
}

/** Prime the cache from the persisted setting. Call once at boot. */
export async function initEmbedModel(): Promise<void> {
  const { getAppSetting } = await import('@/lib/settings')
  const setting = await getAppSetting('embed_model')
  if (typeof setting === 'string' && setting.trim()) setEmbedModelCache(setting)
}

// Matryoshka truncation: models trained with MRL (e.g. Qwen3-Embedding) stay valid
// when sliced to a prefix, as long as the result is re-normalized. Keeps the vector
// store at a stable width across embedder swaps.
function mrlTruncate(vec: number[]): number[] {
  const dims = activeMrlDims
  if (!dims || vec.length <= dims) return vec
  const cut = vec.slice(0, dims)
  let mag = 0
  for (const v of cut) mag += v * v
  const norm = Math.sqrt(mag)
  if (norm === 0) return cut
  return cut.map((v) => v / norm)
}

// Automatic placement can exile the general embedder to the CPU (num_gpu: 0) when the
// GPU residents don't co-fit alongside the chat model (engineAutotune's placement
// cascade). Embedding tolerates it well: inputs are short, the model is ~0.6B, and bulk
// re-embeds stop competing with chat for the card. num_gpu is a LOAD-time param, so
// EVERY embed call for this model must route through here — a call site that omits it
// would flip the runner back onto the GPU (full reload each direction). The T1 router
// embedder (all-minilm, ~45MB) is latency-critical and always stays on the GPU.
//
// Two things can put the embedder on the CPU:
//   1. the boot-time cascade (autotune.embedOnCpu) - the residents never co-fit;
//   2. the runtime spill ladder (llmStatus.remediateChatSpill) - they fit on paper but
//      the chat model is observably spilling, so the embedder yields its VRAM live.
// The runtime flag is deliberately sticky until restart: flapping the embedder between
// devices pays a full model reload in each direction, and the next boot re-runs the
// cascade with fresh numbers anyway.
let embedCpuRuntimeOverride = false

/** Escalation hook for the spill ladder: run the general embedder on CPU from now on. */
export function setEmbedCpuOverride(on: boolean): void {
  embedCpuRuntimeOverride = on
}

/** True when automatic placement INTENDS the general embedder to run on the CPU right
 *  now - the LLM census uses this to label it "CPU by design" instead of alerting. */
export function isEmbedCpuPlanned(): boolean {
  return isAutomatic() && (embedCpuRuntimeOverride || getCachedAutotune()?.embedOnCpu === true)
}

function embedPlacement(): Record<string, unknown> | undefined {
  return isEmbedCpuPlanned() ? { num_gpu: 0 } : undefined
}

export async function embed(text: string): Promise<number[]> {
  return mrlTruncate(await ollamaEmbed(activeEmbedModel, text, embedPlacement()))
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

/** Flush the parsed-vector cache. Required after a re-embed: several tables key the
 *  cache on `${id}:${createdAt}` (no updatedAt column), so rewritten embeddings would
 *  otherwise keep serving the old model's vectors until the process restarts. */
export function clearVectorCache(): void {
  _vecCache.clear()
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
