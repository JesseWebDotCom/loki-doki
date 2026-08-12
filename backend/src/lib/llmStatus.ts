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
import { getModel, getRouterModel } from '@/lib/models'
import { ollamaUnloadModel } from '@/llm/ollama'
import { getEmbedModel, isEmbedCpuPlanned, setEmbedCpuOverride } from '@/llm/embed'
import { detectCudaDevices } from '@/lib/hwfit'
import { recordResourceEvent } from '@/lib/resourceEvents'

const normTag = (t: string) => t.replace(/:latest$/, '')

// Spill auto-remediation (Phase 2.7): when the always-hot chat model is sustained-
// offloading to CPU in automatic mode, free VRAM in latency-tolerance order so the
// chat model can sit fully in VRAM. The ladder:
//   1. Evict the resident T2 router (a few GB that only a minority of turns use).
//      It reloads on the next ambiguous turn (an already-slower path).
//   2. Move the general embedder to the CPU (setEmbedCpuOverride) and unload it, so
//      its next call reloads it CPU-side. Embeddings tolerate the CPU well (short
//      inputs, ~0.6B weights); a spilling CHAT model does not.
// Bounded: fires at most one step per cooldown, only in automatic mode, and never
// when the GPUs themselves are unreachable (a wedged driver offloads everything at
// once - no amount of VRAM shuffling helps, and the driver alert owns that story).
let lastRemediationAt = 0
const REMEDIATION_COOLDOWN_MS = 5 * 60_000
// `all` is the full census and `sustained` only the models spilling across >=2 polls:
// the TRIGGER (chat spilling) reads `sustained`, but the residents to evict are looked
// up in `all` - a small router/embedder sitting fully in VRAM never appears in the
// sustained list, and searching there meant step 1 only fired when the router was
// itself spilling (i.e. almost never when it mattered).
async function remediateChatSpill(all: LoadedLlmModel[], sustained: LoadedLlmModel[]): Promise<void> {
  if (!isAutomatic()) return
  if (Date.now() - lastRemediationAt < REMEDIATION_COOLDOWN_MS) return
  try {
    const chat = normTag(await getModel())
    const chatSpilling = sustained.some((m) => m.engine === 'main' && normTag(m.name) === chat && m.offloadPct >= OFFLOAD_ALERT_PCT)
    if (!chatSpilling) return
    if ((await detectCudaDevices()).length === 0) return
    // Step 1: the T2 router yields first.
    const router = await getRouterModel()
    if (router && normTag(router) !== chat) {
      const routerResident = all.some((m) => m.engine === 'main' && normTag(m.name) === normTag(router))
      if (routerResident) {
        lastRemediationAt = Date.now()
        await ollamaUnloadModel(router)
        logger.warn(`[resource] chat model ${chat} spilling to CPU; evicted router ${router} to free VRAM (reloads on next ambiguous turn)`)
        recordResourceEvent('remediate', `Chat model was spilling to CPU; freed the router to recover`)
        return
      }
    }
    // Step 2: the general embedder moves to the CPU (skip when it's already there).
    const embedTag = normTag(getEmbedModel())
    const embedOnGpu = !isEmbedCpuPlanned() && embedTag !== chat &&
      all.some((m) => m.engine === 'main' && normTag(m.name) === embedTag && m.offloadPct < 100)
    if (!embedOnGpu) return
    lastRemediationAt = Date.now()
    setEmbedCpuOverride(true)
    await ollamaUnloadModel(getEmbedModel())
    logger.warn(`[resource] chat model ${chat} still spilling; moved embedder ${embedTag} to CPU (reloads there on next embed)`)
    recordResourceEvent('remediate', `Chat model was spilling to CPU; moved the embedder to the CPU to free VRAM`)
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
