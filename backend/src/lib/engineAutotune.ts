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

import { detectCudaDevices, getCachedGpuPlacement } from '@/lib/hwfit'
import { CATALOG, inSet, type CatalogModel } from '@/lib/catalog'
import { getActiveModelSetSync } from '@/lib/modelSetState'
import { getCachedEngineGuards } from '@/lib/engineGuards'
import { logger } from '@/lib/logger'

const GB = 1_000_000_000
// VRAM the chat model can't have: display/compositor + CUDA context. Calibrated against
// the reference dev box (Windows compositor + browser accel ≈ 0.65 GB); the old 1.3 GB
// figure re-counted a "safety margin" that USABLE_FRACTION already provides, and the
// stacked margins misclassified PROVEN co-resident lineups (8B chat + 3B router + embeds
// live on one 8 GB card) as not fitting — which pushed the placement cascade into
// offloading residents that demonstrably fit.
const OVERHEAD_BYTES = 0.7 * GB
// Fraction of total VRAM we're willing to fill (slack for fragmentation).
const USABLE_FRACTION = 0.96
// KV-cache reserve for a given context window (~8B class): ≈0.3 GB per 4k tokens at
// q8_0 (the previous 0.6 figure was the fp16 number mislabeled as q8). Reads the
// engine guards so an operator who rolls KV back to f16 gets the honest reserve.
function kvReserveBytes(numCtx: number): number {
  const q8 = getCachedEngineGuards().kvCacheType.startsWith('q8')
  return (numCtx / 4096) * (q8 ? 0.3 : 0.6) * GB
}

const FALLBACK_MODEL = 'llama3.1:8b'

export interface EngineFit {
  vramBytes: number          // 0 = no NVIDIA card detected (CPU-only or Mac)
  hasGpu: boolean
  overheadBytes: number      // reserved for small resident models + display/CUDA
  budgetBytes: number        // what's left for the chat model + its KV cache
  recommendedModel: string   // ollama tag
  recommendedNumCtx: number  // advisory (applying it must keep warmup in sync)
  /** Run the general embedder on CPU (num_gpu 0): the GPU residents didn't co-fit. */
  embedOnCpu: boolean
  /** No dedicated router-LLM resident: T2 routing shares the chat model's runner. */
  routerShared: boolean
  reason: string
}

// Both helpers filter by the ACTIVE model set: with multiple sets in the catalog,
// summing every entry per role would double-count residents and shrink the chat
// budget for everyone, and the candidate pool would offer models from inactive sets.
function chatLlms(): CatalogModel[] {
  const set = getActiveModelSetSync()
  return CATALOG.filter((m) => (m.role === 'uncensored_llm' || m.role === 'llm') && m.backend === 'ollama' && inSet(m, set))
}

// The small always-resident roles, split per role so the placement cascade can
// offload them one at a time when they don't co-fit with the chat model.
function residentParts(): { router: number; embed: number; minilm: number } {
  const set = getActiveModelSetSync()
  const sum = (role: string) => CATALOG
    .filter((m) => m.role === role && m.backend === 'ollama' && inSet(m, set))
    .reduce((s, m) => s + (m.approxBytes ?? 0), 0)
  return { router: sum('router_llm'), embed: sum('embeddings'), minilm: sum('router') }
}

// Speed-first ordering among candidates: 'fast'-tagged first, then smaller (faster).
function bySpeed(a: CatalogModel, b: CatalogModel): number {
  const fa = a.tags?.includes('fast') ? 0 : 1
  const fb = b.tags?.includes('fast') ? 0 : 1
  if (fa !== fb) return fa - fb
  return (a.approxBytes ?? 0) - (b.approxBytes ?? 0)
}

const gib = (n: number) => (n / GB).toFixed(1)

/** Pure recommendation from a VRAM figure (no I/O), so it's easy to reason about/test.
 *  `secondaryVramBytes` is the combined VRAM of the OTHER cards Ollama can see (0 on
 *  single-GPU boxes): when the small residents fit there, they stop taxing the chat
 *  card entirely - Ollama's scheduler loads each model onto the card with the most
 *  free memory, so with the chat model filling the primary, residents land on the
 *  secondary on their own. */
export function recommend(vramBytes: number, secondaryVramBytes = 0): EngineFit {
  const hasGpu = vramBytes > 0
  const parts = residentParts()
  const llms = chatLlms()
  const smallest = [...llms].sort((a, b) => (a.approxBytes ?? 0) - (b.approxBytes ?? 0))[0]
  const smallestTag = smallest?.ollamaTag ?? FALLBACK_MODEL

  if (!hasGpu) {
    return {
      vramBytes, hasGpu, overheadBytes: OVERHEAD_BYTES + parts.router + parts.embed + parts.minilm,
      budgetBytes: 0, recommendedModel: smallestTag, recommendedNumCtx: 4096,
      embedOnCpu: false, routerShared: false,
      reason: 'No NVIDIA GPU detected; using the lightest chat model + 4k context as a safe default (Mac unified memory is not probed here).',
    }
  }

  // Placement cascade: when the small residents + the lightest chat model overflow the
  // card, offload residents in latency-tolerance order instead of letting Ollama spread
  // them (observed: an over-budget stack split the chat model across Thunderbolt onto
  // the imaging GPU). The general embedder goes first — short texts embed fine on CPU
  // and bulk re-embeds stop competing for the GPU. The dedicated router LLM goes next —
  // T2 routing falls back to the chat model's runner (the pre-granite behavior: slower
  // per T2 call, but it only fires on tier-1 misses and never pays a cold load). The T1
  // embedder (all-minilm, ~45MB) always stays.
  const usable = vramBytes * USABLE_FRACTION - OVERHEAD_BYTES
  const minChat = (smallest?.approxBytes ?? 0) + kvReserveBytes(2048)
  let embedOnCpu = false
  let routerShared = false
  let gpuResidents = parts.router + parts.embed + parts.minilm
  // Multi-GPU first: when a secondary card can host ALL the small residents (with its
  // own display/CUDA overhead accounted), they cost the chat card nothing and nothing
  // needs to leave the GPU. Partial splits are deliberately not modeled - the win is
  // small and the accounting gets speculative.
  const secondaryUsable = secondaryVramBytes > 0 ? Math.max(0, secondaryVramBytes * USABLE_FRACTION - OVERHEAD_BYTES) : 0
  const residentsOnSecondary = gpuResidents > 0 && gpuResidents <= secondaryUsable
  if (residentsOnSecondary) {
    gpuResidents = 0
  } else {
    if (minChat + gpuResidents > usable) { embedOnCpu = true; gpuResidents -= parts.embed }
    if (minChat + gpuResidents > usable) { routerShared = true; gpuResidents -= parts.router }
  }

  const overhead = OVERHEAD_BYTES + gpuResidents
  const budget = Math.max(0, vramBytes * USABLE_FRACTION - overhead)
  const fitting = llms
    .filter((m) => (m.approxBytes ?? 0) + kvReserveBytes(2048) <= budget)
    .sort(bySpeed)
  const pick = fitting[0] ?? smallest
  const pickTag = pick?.ollamaTag ?? smallestTag
  const headroom = budget - (pick?.approxBytes ?? 0)
  // Floor at 4096: a smaller window truncates the system prompt (presentation policy
  // + character + memory + briefing can run ~1-2k tokens on its own).
  const numCtx = headroom >= kvReserveBytes(8192) ? 8192 : 4096

  const moved = [
    ...(embedOnCpu ? ['embeddings → CPU'] : []),
    ...(routerShared ? ['T2 routing → chat model'] : []),
  ]
  const placementNote = residentsOnSecondary
    ? ' Small residents (router + embedders) fit on the second GPU, leaving this card to the chat model.'
    : moved.length ? ` Offloaded to fit: ${moved.join(', ')}.` : ''

  // Note: this is a boot-time ESTIMATE from one card's VRAM; on a multi-GPU box the
  // router/embeds may sit on a different card, so the live "on GPU" figure is the
  // truth. The wording avoids a definitive spill claim the live data often contradicts.
  const reason = (fitting.length
    ? `${gib(vramBytes)}GB VRAM, ~${gib(overhead)}GB reserved for GPU residents + overhead → ${pick?.label} (${gib(pick?.approxBytes ?? 0)}GB) at ${numCtx / 1024}k context.`
    : `${gib(vramBytes)}GB per GPU is tight for ${pick?.label} even alone; watch the "on GPU" figure and pick a smaller model if it starts offloading.`
  ) + placementNote

  return {
    vramBytes, hasGpu, overheadBytes: overhead, budgetBytes: budget,
    recommendedModel: pickTag, recommendedNumCtx: numCtx, embedOnCpu, routerShared, reason,
  }
}

/** Whether a specific model tag fits the detected card. Unknown size / no GPU → no warning. */
export function checkFit(modelTag: string, vramBytes: number): { fits: boolean; willSpill: boolean; sizeBytes: number } {
  const size = CATALOG.find((c) => c.ollamaTag === modelTag)?.approxBytes ?? 0
  if (vramBytes <= 0 || size === 0) return { fits: true, willSpill: false, sizeBytes: size }
  // Use the resolved fit's overhead when available — it reflects the placement
  // cascade (an offloaded embedder/router no longer counts against the card).
  const parts = residentParts()
  const overhead = cache?.overheadBytes ?? (OVERHEAD_BYTES + parts.router + parts.embed + parts.minilm)
  const budget = vramBytes * USABLE_FRACTION - overhead
  const fits = size + kvReserveBytes(2048) <= budget
  return { fits, willSpill: !fits, sizeBytes: size }
}

// ── Boot cache ────────────────────────────────────────────────────────────────
let cache: EngineFit | null = null

/** Detect VRAM and cache the recommendation. Call at boot (alongside
 *  resolveEngineGuards, AFTER resolveGpuPlacement) and after hardware changes.
 *  Falls back to the no-GPU recommendation on any detection error. */
export async function resolveEngineAutotune(): Promise<EngineFit> {
  try {
    const devices = await detectCudaDevices()
    // Budget only the cards Ollama can actually SEE. With placement confining it via
    // CUDA_VISIBLE_DEVICES (e.g. away from the imaging card), sizing the chat model
    // against the global biggest card can overstate the budget - the biggest card may
    // be exactly the one Ollama is excluded from.
    const visibleSpec = getCachedGpuPlacement().ollamaVisibleDevices
    const visibleSet = visibleSpec ? new Set(visibleSpec.split(',').map((s) => parseInt(s, 10))) : null
    const pool = visibleSet ? devices.filter((d) => visibleSet.has(d.index)) : devices
    const cards = (pool.length ? pool : devices).map((d) => d.vramBytes).sort((a, b) => b - a)
    const vram = cards[0] ?? 0
    const secondary = cards.slice(1).reduce((s, b) => s + b, 0)
    cache = recommend(vram, secondary)
    logger.info(`[autotune] ${cache.reason}`)
  } catch {
    cache = recommend(0)
  }
  return cache
}

/** Sync accessor for hot paths (getModel). Null until resolveEngineAutotune() runs. */
export function getCachedAutotune(): EngineFit | null { return cache }
