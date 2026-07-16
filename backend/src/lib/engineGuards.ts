// Admin-tunable guards for the local Ollama engines, sized for this app's reality: a home
// box where every model shares one or two consumer GPUs. These become `ollama serve` env
// vars, so they are resolved into a synchronous cache at boot (before the first spawn) the
// same way hwfit's GPU placement is - spawn paths can't await the DB.
//
// Why each guard exists:
// - maxLoadedModels: Ollama keeps this many runners resident before evicting. The old
//   hardcoded 6 let residents pile past physical VRAM, so NEW loads silently ran on the
//   CPU instead of evicting an idle model (observed: a 90-second chat reply). Default 5 =
//   the worst-case co-touched set for one routed vision turn (chat + router LLM + two
//   embedders + vision) - the count cap should never bind before VRAM-fit does.
// - numParallel: per-model parallel slots MULTIPLY the KV-cache allocation. A family box
//   serves one request per model at a time in practice; 1 stops paying KV for phantom
//   concurrency.
// - flashAttention + kvCacheType q8_0: FA enables quantized KV, roughly halving KV memory
//   with negligible quality loss. NOTE: the KV type is server-global (not per-model) - if
//   one model misbehaves under q8_0 the only rollback is f16 for everything. Embedding
//   models auto-fall-back harmlessly.
// - codingCtx: context window for the DEDICATED coding engine (codingEngine.ts). Claude
//   Code reaches Ollama through the Anthropic-compatible endpoint, which cannot send a
//   per-request num_ctx, so the engine's env default is the only lever. Must be large
//   enough for Claude Code's system prompt + tools (~8k truncation was the root cause of
//   the coding model "derailing"); 32768 is the safe floor.
//
// Changing guards requires an engine restart to take effect (env is baked at spawn); the
// admin panel surfaces that via its "Apply & restart engine" action.

import { getAppSetting, setAppSetting } from '@/lib/settings'
import { logger } from '@/lib/logger'

export interface EngineGuards {
  maxLoadedModels: number
  numParallel: number
  flashAttention: boolean
  kvCacheType: 'q8_0' | 'f16'
  codingCtx: number
}

export const DEFAULT_ENGINE_GUARDS: EngineGuards = {
  maxLoadedModels: 5,
  numParallel: 1,
  flashAttention: true,
  kvCacheType: 'q8_0',
  codingCtx: 32768,
}

const GUARDS_KEY = 'llm.engineGuards'

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(n)))

function sanitize(raw: Partial<EngineGuards> | null): EngineGuards {
  const d = DEFAULT_ENGINE_GUARDS
  return {
    maxLoadedModels: typeof raw?.maxLoadedModels === 'number' ? clamp(raw.maxLoadedModels, 1, 8) : d.maxLoadedModels,
    numParallel: typeof raw?.numParallel === 'number' ? clamp(raw.numParallel, 1, 4) : d.numParallel,
    flashAttention: typeof raw?.flashAttention === 'boolean' ? raw.flashAttention : d.flashAttention,
    kvCacheType: raw?.kvCacheType === 'f16' ? 'f16' : d.kvCacheType,
    codingCtx: typeof raw?.codingCtx === 'number' ? clamp(raw.codingCtx, 8192, 131072) : d.codingCtx,
  }
}

let cache: EngineGuards = DEFAULT_ENGINE_GUARDS

/** Load the persisted guards into the sync cache. Call at boot BEFORE the first Ollama spawn
 *  (alongside resolveGpuPlacement) and after every save. Falls back to defaults on any error. */
export async function resolveEngineGuards(): Promise<EngineGuards> {
  try {
    cache = sanitize((await getAppSetting(GUARDS_KEY)) as Partial<EngineGuards> | null)
  } catch (err) {
    logger.warn(`[engine-guards] resolve failed, using defaults: ${err instanceof Error ? err.message : String(err)}`)
    cache = DEFAULT_ENGINE_GUARDS
  }
  return cache
}

/** Synchronous accessor for spawn paths. Defaults until resolveEngineGuards() has run. */
export function getCachedEngineGuards(): EngineGuards {
  return cache
}

/** Persist a patch, refresh the cache, and report that a restart is needed to apply. */
export async function saveEngineGuards(patch: Partial<EngineGuards>): Promise<EngineGuards> {
  const next = sanitize({ ...cache, ...patch })
  await setAppSetting(GUARDS_KEY, next)
  cache = next
  return next
}
