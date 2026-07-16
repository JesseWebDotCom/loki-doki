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

const MAIN_BASE = () => (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '')

export type LlmEngine = 'main' | 'coding'

export interface LoadedLlmModel {
  engine: LlmEngine
  name: string
  sizeBytes: number
  vramBytes: number
  /** 0 = fully in VRAM, 100 = fully on CPU. */
  offloadPct: number
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
  const models = [...main.models, ...coding.models]

  const offloaders = models.filter((m) => m.offloadPct >= OFFLOAD_ALERT_PCT)
  const offloaderKeys = new Set(offloaders.map((m) => `${m.engine}:${m.name}`))
  const sustainedOffload = offloaders.filter((m) => prevOffloaders.has(`${m.engine}:${m.name}`))
  prevOffloaders = offloaderKeys

  if (sustainedOffload.length > 0) {
    logger.warn(`[llm-status] sustained CPU offload: ${sustainedOffload.map((m) => `${m.name}@${m.engine} ${m.offloadPct}%`).join(', ')}`)
  }

  return {
    models,
    engines: { main: main.up, coding: coding.up },
    orphanSweep: lastOrphanSweep(),
    sustainedOffload,
  }
}
