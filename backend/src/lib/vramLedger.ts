// VRAM coordination across subsystems (Phase 2 of docs/internal/resource-management-plan.md).
// The freeze/lag failure mode on a single-GPU box is oversubscription: image/video
// generation launches while the resident LLM still holds most of the card, so both
// spill to system RAM (WDDM sysmem fallback) and the machine stutters. Multi-GPU is
// already handled (hwfit segregates Ollama and ComfyUI onto separate cards); this
// module handles the SHARED-card case.
//
// It is intentionally small and best-effort: it reads live VRAM and, in automatic
// mode on a shared card, evicts the LLM before a heavy GPU job so the job has room.
// The LLM reloads on the next chat (keep_alive), so the worst case is one cold chat,
// never a freeze. In manual mode or on a segregated multi-GPU box it does nothing.

import { getCachedGpuPlacement } from '@/lib/hwfit'
import { queryGpus } from '@/lib/gpuMonitor'
import { ollamaUnloadModel, ollamaWarmModel } from '@/llm/ollama'
import { getModel } from '@/lib/models'
import { comfyUrl } from '@/lib/comfyui'
import { isAutomatic } from '@/lib/resourceMode'
import { logger } from '@/lib/logger'

// Ask ComfyUI to release its VRAM (unload checkpoints + free the allocator) so the
// LLM can move back onto the card cleanly. Best-effort; ComfyUI frees lazily anyway.
async function freeComfyVram(): Promise<void> {
  try {
    await fetch(`${comfyUrl()}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch { /* best-effort */ }
}

/** True when ComfyUI (image/video) runs on the SAME physical card as Ollama, so a
 *  heavy generation and the resident LLM contend for one pool of VRAM. Derived from
 *  the cached hwfit placement: no GPU → false; Ollama unconfined (uses all cards,
 *  including ComfyUI's) → true; otherwise true only if ComfyUI's card is in Ollama's
 *  visible set. */
export function sharesGpuWithLlm(): boolean {
  const p = getCachedGpuPlacement()
  if (p.comfyIndex == null) return false // ComfyUI on CPU / no NVIDIA
  if (!p.ollamaVisibleDevices) return true // Ollama unconfined → same card in play
  const ollamaCards = new Set(p.ollamaVisibleDevices.split(',').map((s) => parseInt(s, 10)))
  return ollamaCards.has(p.comfyIndex)
}

/** Live free VRAM (bytes) on a card, or null if nvidia-smi can't be read. */
export async function freeVramBytes(gpuIndex: number): Promise<number | null> {
  const gpus = await queryGpus()
  const g = gpus?.find((x) => x.index === gpuIndex)
  if (!g || g.memTotalMb == null || g.memUsedMb == null) return null
  return Math.max(0, (g.memTotalMb - g.memUsedMb) * 1_048_576)
}

// Serialize evict/restore so concurrent heavy jobs don't double-evict or race the
// re-warm. A simple promise chain is enough (jobs are seconds-to-minutes scale).
let lock: Promise<void> = Promise.resolve()

/**
 * Run a heavy GPU job (image/video generation) with VRAM headroom. On a shared card
 * in automatic mode, unload the resident chat model first so the job doesn't
 * oversubscribe the GPU and stall the box; the LLM reloads on the next chat. In
 * manual mode or on a segregated multi-GPU box, just runs the job unchanged.
 *
 * Best-effort by construction: an eviction failure never blocks the job, and the job
 * always runs even if coordination is unavailable.
 */
export async function runGpuHeavyJob<T>(label: string, job: () => Promise<T>): Promise<T> {
  if (!isAutomatic() || !sharesGpuWithLlm()) return job()

  // Wait for any prior heavy job's evict/restore to settle, then take the lock.
  const prior = lock
  let release!: () => void
  lock = new Promise<void>((r) => { release = r })
  try { await prior } catch { /* ignore */ }

  let evicted: string | null = null
  try {
    const model = await getModel()
    try {
      await ollamaUnloadModel(model)
      evicted = model
      logger.info(`[resource] evicted ${model} to free VRAM for ${label}`)
    } catch (e) {
      logger.warn(`[resource] could not evict LLM before ${label}: ${(e as Error).message}`)
    }
    return await job()
  } finally {
    // Re-warm proactively so the next chat isn't cold: free ComfyUI's VRAM first (else
    // the LLM would load into a still-occupied card and spill), then warm the model
    // back. Detached so the generation response returns immediately; the lock is held
    // until the model is resident so a back-to-back job doesn't fight the re-warm.
    if (evicted) {
      const model = evicted
      void (async () => {
        try {
          await freeComfyVram()
          await ollamaWarmModel(model)
          logger.info(`[resource] ${label} done; re-warmed ${model}`)
        } catch { /* the model still loads on demand on the next chat */ }
        finally { release() }
      })()
    } else {
      release()
    }
  }
}
