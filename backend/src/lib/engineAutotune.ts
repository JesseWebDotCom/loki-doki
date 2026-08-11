// Intelligent LLM engine auto-tuning. Detects GPU VRAM and picks a chat model that
// actually FITS the card, so an oversized model never silently spills layers to CPU
// (a 5-10x generation slowdown that no amount of pipeline tuning can fix). Mirrors
// engineGuards' boot-cache pattern: resolve once at boot, read sync on hot paths.
//
// The catalog carries per-model `approxBytes`; the always-resident small models
// (router LLM, router embed, embeddings) share the same card, so the budget for the
// chat model is VRAM minus those minus display/CUDA overhead. Among models that fit,
// we prefer the 'fast'-tagged one (this whole effort is about latency), not the
// biggest; bigger-but-quality is a deliberate opt-in, never an auto-pick.

import { detectCudaDevices } from '@/lib/hwfit'
import { CATALOG, inSet, type CatalogModel } from '@/lib/catalog'
import { getActiveModelSetSync } from '@/lib/modelSetState'
import { logger } from '@/lib/logger'

const GB = 1_000_000_000
// VRAM the chat model can't have: display/compositor + CUDA context + safety margin.
const OVERHEAD_BYTES = 1.3 * GB
// Fraction of total VRAM we're willing to fill (leave a little slack for fragmentation).
const USABLE_FRACTION = 0.94
// Rough KV-cache reserve for a given context window (q8_0 cache, ~8B class). Generous
// on purpose: better to under-promise context than to spill.
function kvReserveBytes(numCtx: number): number { return (numCtx / 4096) * 0.6 * GB }

const FALLBACK_MODEL = 'llama3.1:8b'

export interface EngineFit {
  vramBytes: number          // 0 = no NVIDIA card detected (CPU-only or Mac)
  hasGpu: boolean
  overheadBytes: number      // reserved for small resident models + display/CUDA
  budgetBytes: number        // what's left for the chat model + its KV cache
  recommendedModel: string   // ollama tag
  recommendedNumCtx: number  // advisory (applying it must keep warmup in sync)
  reason: string
}

// Both helpers filter by the ACTIVE model set: with multiple sets in the catalog,
// summing every entry per role would double-count residents and shrink the chat
// budget for everyone, and the candidate pool would offer models from inactive sets.
function chatLlms(): CatalogModel[] {
  const set = getActiveModelSetSync()
  return CATALOG.filter((m) => (m.role === 'uncensored_llm' || m.role === 'llm') && m.backend === 'ollama' && inSet(m, set))
}

// Router LLM + router embed + embeddings are kept resident and share the card.
function residentSmallBytes(): number {
  const set = getActiveModelSetSync()
  const roles = new Set(['router_llm', 'router', 'embeddings'])
  return CATALOG.filter((m) => roles.has(m.role) && m.backend === 'ollama' && inSet(m, set))
    .reduce((s, m) => s + (m.approxBytes ?? 0), 0)
}

// Speed-first ordering among candidates: 'fast'-tagged first, then smaller (faster).
function bySpeed(a: CatalogModel, b: CatalogModel): number {
  const fa = a.tags?.includes('fast') ? 0 : 1
  const fb = b.tags?.includes('fast') ? 0 : 1
  if (fa !== fb) return fa - fb
  return (a.approxBytes ?? 0) - (b.approxBytes ?? 0)
}

const gib = (n: number) => (n / GB).toFixed(1)

/** Pure recommendation from a VRAM figure (no I/O), so it's easy to reason about/test. */
export function recommend(vramBytes: number): EngineFit {
  const hasGpu = vramBytes > 0
  const overhead = OVERHEAD_BYTES + residentSmallBytes()
  const budget = Math.max(0, vramBytes * USABLE_FRACTION - overhead)
  const llms = chatLlms()
  const smallest = [...llms].sort((a, b) => (a.approxBytes ?? 0) - (b.approxBytes ?? 0))[0]
  const smallestTag = smallest?.ollamaTag ?? FALLBACK_MODEL

  if (!hasGpu) {
    return {
      vramBytes, hasGpu, overheadBytes: overhead, budgetBytes: budget,
      recommendedModel: smallestTag, recommendedNumCtx: 4096,
      reason: 'No NVIDIA GPU detected; using the lightest chat model + 4k context as a safe default (Mac unified memory is not probed here).',
    }
  }

  const fitting = llms
    .filter((m) => (m.approxBytes ?? 0) + kvReserveBytes(2048) <= budget)
    .sort(bySpeed)
  const pick = fitting[0] ?? smallest
  const pickTag = pick?.ollamaTag ?? smallestTag
  const headroom = budget - (pick?.approxBytes ?? 0)
  // Floor at 4096: a smaller window truncates the system prompt (presentation policy
  // + character + memory + briefing can run ~1-2k tokens on its own).
  const numCtx = headroom >= kvReserveBytes(8192) ? 8192 : 4096

  // Note: this is a boot-time ESTIMATE from one card's VRAM; on a multi-GPU box the
  // router/embeds may sit on a different card, so the live "on GPU" figure is the
  // truth. The wording avoids a definitive spill claim the live data often contradicts.
  const reason = fitting.length
    ? `${gib(vramBytes)}GB VRAM, ~${gib(overhead)}GB reserved for router/embeds + overhead → ${pick?.label} (${gib(pick?.approxBytes ?? 0)}GB) at ${numCtx / 1024}k context.`
    : `${gib(vramBytes)}GB per GPU is tight for ${pick?.label} plus the router and embedders; it should still fit on most setups, but watch the "on GPU" figure and pick a smaller model if it starts offloading.`

  return { vramBytes, hasGpu, overheadBytes: overhead, budgetBytes: budget, recommendedModel: pickTag, recommendedNumCtx: numCtx, reason }
}

/** Whether a specific model tag fits the detected card. Unknown size / no GPU → no warning. */
export function checkFit(modelTag: string, vramBytes: number): { fits: boolean; willSpill: boolean; sizeBytes: number } {
  const size = CATALOG.find((c) => c.ollamaTag === modelTag)?.approxBytes ?? 0
  if (vramBytes <= 0 || size === 0) return { fits: true, willSpill: false, sizeBytes: size }
  const budget = vramBytes * USABLE_FRACTION - (OVERHEAD_BYTES + residentSmallBytes())
  const fits = size + kvReserveBytes(2048) <= budget
  return { fits, willSpill: !fits, sizeBytes: size }
}

// ── Boot cache ────────────────────────────────────────────────────────────────
let cache: EngineFit | null = null

/** Detect VRAM and cache the recommendation. Call at boot (alongside
 *  resolveEngineGuards) and after hardware changes. Falls back to the no-GPU
 *  recommendation on any detection error. */
export async function resolveEngineAutotune(): Promise<EngineFit> {
  try {
    const devices = await detectCudaDevices()
    const vram = devices.length ? Math.max(...devices.map((d) => d.vramBytes)) : 0
    cache = recommend(vram)
    logger.info(`[autotune] ${cache.reason}`)
  } catch {
    cache = recommend(0)
  }
  return cache
}

/** Sync accessor for hot paths (getModel). Null until resolveEngineAutotune() runs. */
export function getCachedAutotune(): EngineFit | null { return cache }
