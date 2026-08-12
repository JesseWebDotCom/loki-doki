// Live LLM engine census: which models are loaded on which local engine, how much of each
// is actually in VRAM vs CPU-offloaded, plus the orphan-sweep record. Feeds the admin
// System-tab "AI engine" panel and the offload alert through the same GET /api/admin/gpu/status
// poll the GPU health card already uses.
//
// Deliberately LOCAL-only (127.0.0.1 engines): a paired remote engine's residency is not
// ours to monitor or manage. Both fetches carry tight timeouts - a mid-restart engine must
// never hang the 20 s admin poll.

import { CODING_ENGINE_BASE } from '@/lib/codingEngine'
import { lastOrphanSweep } from '@/lib/ollamaHygiene'
import { logger } from '@/lib/logger'
import { isAutomatic } from '@/lib/resourceMode'
import { getModel } from '@/lib/models'
import { ollamaUnloadModel, ollamaWarmModel } from '@/llm/ollama'
import { getEmbedModel, isEmbedCpuPlanned, setEmbedCpuOverride, ROUTER_EMBED_MODEL } from '@/llm/embed'
import { detectCudaDevices } from '@/lib/hwfit'
import { recordResourceEvent } from '@/lib/resourceEvents'

const normTag = (t: string) => t.replace(/:latest$/, '')

// Spill auto-remediation (Phase 2.7): when the always-hot chat model is sustained-
// offloading to CPU in automatic mode, recover in two steps:
//   1. Evict whatever NON-ESSENTIAL model holds GPU memory on the main engine - the
//      T2 router, the vision model, or any helper a route loaded (observed live
//      2026-08-12: image gen loaded a 4B onto the chat card and chat lost its seat).
//      Only the chat model itself and the tiny T1 embedder (all-minilm, ~45MB,
//      latency-critical) are exempt. An evicted general embedder is also flipped to
//      CPU-by-design so it reloads there instead of re-taking the card.
//   2. Nothing else on the card but chat is still mostly CPU-side: it was loaded
//      while the card was busy, and a runner NEVER re-places itself - with the
//      app's infinite keep_alive it would sit stranded on the CPU forever (also
//      observed live). Unload + re-warm so it loads back into the now-free VRAM.
// Bounded: fires at most one step per cooldown, only in automatic mode, and never
// when the GPUs themselves are unreachable (a wedged driver offloads everything at
// once - no amount of VRAM shuffling helps, and the driver alert owns that story).
let lastRemediationAt = 0
const REMEDIATION_COOLDOWN_MS = 5 * 60_000
// `all` is the full census and `sustained` only the models spilling across >=2 polls:
// the TRIGGER (chat spilling) reads `sustained`, but eviction candidates are looked
// up in `all` - a small resident sitting fully in VRAM never appears in the
// sustained list, and searching there meant eviction only fired when the resident
// was itself spilling (i.e. almost never when it mattered).
async function remediateChatSpill(all: LoadedLlmModel[], sustained: LoadedLlmModel[]): Promise<void> {
  if (!isAutomatic()) return
  if (Date.now() - lastRemediationAt < REMEDIATION_COOLDOWN_MS) return
  try {
    const chat = normTag(await getModel())
    const chatSpilling = sustained.some((m) => m.engine === 'main' && normTag(m.name) === chat && m.offloadPct >= OFFLOAD_ALERT_PCT)
    if (!chatSpilling) return
    if ((await detectCudaDevices()).length === 0) return
    // Step 1: evict the first non-essential model holding VRAM on the main engine.
    const essential = new Set([chat, normTag(ROUTER_EMBED_MODEL)])
    const squatter = all.find((m) => m.engine === 'main' && !essential.has(normTag(m.name)) && m.vramBytes > 0)
    if (squatter) {
      lastRemediationAt = Date.now()
      if (normTag(squatter.name) === normTag(getEmbedModel())) setEmbedCpuOverride(true)
      await ollamaUnloadModel(squatter.name)
      logger.warn(`[resource] chat model ${chat} spilling to CPU; evicted ${squatter.name} to free VRAM (reloads on demand)`)
      recordResourceEvent('remediate', `Chat model was spilling to CPU; freed ${squatter.name} to recover`)
      return
    }
    // Step 2: card is clear of squatters - reload a stranded chat model onto it.
    // Gated at >=50% offload: below that a full reload costs more than it recovers.
    const chatModel = all.find((m) => m.engine === 'main' && normTag(m.name) === chat)
    if (!chatModel || chatModel.offloadPct < 50) return
    lastRemediationAt = Date.now()
    await ollamaUnloadModel(chatModel.name)
    await ollamaWarmModel(chatModel.name)
    logger.warn(`[resource] chat model ${chat} was stranded ${chatModel.offloadPct}% on the CPU with a free card; reloaded it onto the GPU`)
    recordResourceEvent('remediate', `Chat model was stranded on the CPU; reloaded it onto the GPU`)
  } catch { /* best-effort */ }
}

const MAIN_BASE = () => (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '')

export type LlmEngine = 'main' | 'coding'

export interface LoadedLlmModel {
  engine: LlmEngine
  name: string
  sizeBytes: number
  vramBytes: number
  /** 0 = fully in VRAM, 100 = fully on CPU. */
  offloadPct: number
  /** True when the placement engine PUT this model on the CPU on purpose (e.g. the
   *  general embedder yielding VRAM to the chat model). Planned CPU residency is a
   *  feature, not a failure: it never counts toward the offload alert, and the UI
   *  labels it instead of alarming. */
  plannedCpu: boolean
  contextLength: number | null
  expiresAt: string | null
}

export interface LlmStatus {
  models: LoadedLlmModel[]
  engines: { main: boolean; coding: boolean }   // reachable right now
  orphanSweep: { at: number; pids: number[] }
  /** Models whose offload has persisted across >=2 consecutive polls (alert-worthy). */
  sustainedOffload: LoadedLlmModel[]
}

interface PsModel { name: string; size: number; size_vram: number; context_length?: number; expires_at?: string }

async function queryEngine(base: string, engine: LlmEngine): Promise<{ up: boolean; models: LoadedLlmModel[] }> {
  try {
    const r = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(3_000) })
    if (!r.ok) return { up: false, models: [] }
    const data = (await r.json()) as { models?: PsModel[] }
    const models = (data.models ?? []).map((m): LoadedLlmModel => ({
      engine,
      name: m.name,
      sizeBytes: m.size,
      vramBytes: m.size_vram,
      offloadPct: m.size > 0 ? Math.round(100 * (1 - m.size_vram / m.size)) : 0,
      plannedCpu: false,  // stamped by getLlmStatus, which knows the placement intent
      contextLength: m.context_length ?? null,
      expiresAt: m.expires_at ?? null,
    }))
    return { up: true, models }
  } catch {
    return { up: false, models: [] }
  }
}

// Offload must persist across two consecutive polls before it alerts - a model is briefly
// "offloaded" mid-load while layers stream into VRAM, and that transient must not toast.
const OFFLOAD_ALERT_PCT = 25
let prevOffloaders = new Set<string>()

export async function getLlmStatus(): Promise<LlmStatus> {
  const [main, coding] = await Promise.all([
    queryEngine(MAIN_BASE(), 'main'),
    queryEngine(CODING_ENGINE_BASE, 'coding'),
  ])
  // Stamp placement intent: the general embedder on the main engine is plannedCpu
  // whenever automatic placement wants it CPU-side (boot cascade or spill ladder).
  const embedTag = normTag(getEmbedModel())
  const models = [...main.models, ...coding.models].map((m) => (
    m.engine === 'main' && normTag(m.name) === embedTag && isEmbedCpuPlanned()
      ? { ...m, plannedCpu: true }
      : m
  ))

  const offloaders = models.filter((m) => m.offloadPct >= OFFLOAD_ALERT_PCT && !m.plannedCpu)
  const offloaderKeys = new Set(offloaders.map((m) => `${m.engine}:${m.name}`))
  const sustainedOffload = offloaders.filter((m) => prevOffloaders.has(`${m.engine}:${m.name}`))
  prevOffloaders = offloaderKeys

  if (sustainedOffload.length > 0) {
    logger.warn(`[llm-status] sustained CPU offload: ${sustainedOffload.map((m) => `${m.name}@${m.engine} ${m.offloadPct}%`).join(', ')}`)
    void remediateChatSpill(models, sustainedOffload)
  }

  return {
    models,
    engines: { main: main.up, coding: coding.up },
    orphanSweep: lastOrphanSweep(),
    sustainedOffload,
  }
}
