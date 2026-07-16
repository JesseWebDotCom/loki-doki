// The dedicated coding engine: a second `ollama serve` instance pinned to the imaging GPU
// (the card ComfyUI uses), serving ONLY the coding model for Claude Code. Why it exists:
//
// - Claude Code reaches Ollama through the Anthropic-compatible endpoint, which cannot send
//   a per-request num_ctx - the engine's env default is the only context lever, and Claude
//   Code's system prompt + tools need a large one (truncation makes the model "derail").
//   Giving the MAIN engine a large global default ballooned the KV cache of every load that
//   omitted num_ctx, so the big context lives here, scoped to this engine alone.
// - Chat and coding stop contending: chat stays pinned on its own card at full speed, the
//   coding model gets a whole card while coding is actually happening (user decision:
//   coding shares the imaging GPU; coding-vs-imaging contention is accepted and mitigated
//   by the imaging handoff below).
//
// Lifecycle: NOTHING is reserved speculatively. The engine spawns on the first coding
// session; the model's VRAM returns to imaging via keep_alive expiry or the explicit
// imaging handoff. The engine PROCESS deliberately stays alive once started (an empty
// engine holds no VRAM, just ~150 MB host RAM): persistent tmux Claude sessions bake
// ANTHROPIC_BASE_URL at spawn, so killing the process would strand every resumed session
// against a dead port. prepareCodingSession() restarts it on the next open regardless.
//
// Both engines share one models dir - safe because the blob store is content-addressed
// and ONLY the main engine ever pulls; this one is a read-only consumer.

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { CATALOG } from '@/lib/catalog'
import { getAppSetting } from '@/lib/settings'
import { getCachedEngineGuards } from '@/lib/engineGuards'
import { getCachedGpuPlacement, detectCudaDevices } from '@/lib/hwfit'
import { dataDir, ollamaModelsDir, findSystemOllama, OLLAMA_BIN_DEST } from '@/lib/download'
import { spawnDetachedHidden, killByListeningPort } from '@/lib/platform'
import { sweepOrphanLlamaRunners } from '@/lib/ollamaHygiene'
import { remoteEngineState } from '@/lib/remoteEngine'
import { ollamaUnloadModel } from '@/llm/ollama'
import { logger } from '@/lib/logger'

export const CODING_ENGINE_PORT = 11435
export const CODING_ENGINE_BASE = `http://127.0.0.1:${CODING_ENGINE_PORT}`

/** The Ollama tag serving the coding role (Claude Code's ANTHROPIC_MODEL). */
export async function resolveCodingModelTag(): Promise<string> {
  const settingId = await getAppSetting('coding_model') as string | null
  const id = settingId ?? CATALOG.find((m) => m.role === 'coding')?.id ?? 'ornith:9b'
  const entry = CATALOG.find((m) => m.id === id && m.role === 'coding')
  return entry?.ollamaTag ?? id
}

// The codingCtx actually baked into the RUNNING engine's env at spawn. The warm request
// must use this - not the live guard cache - or a saved-but-not-applied ctx change makes
// the warm and Claude Code's first request load the runner twice at different sizes.
let spawnedCtx: number | null = null
export function codingEngineSpawnedCtx(): number | null { return spawnedCtx }

// ── Active-session tracking (drives the imaging handoff) ─────────────────────
// coding.ts increments/decrements around each terminal WS; the headless companion tool
// wraps its run. "0 active" means an image job may safely evict the coding model.
let activeSessions = 0
export function codingSessionOpened(): void { activeSessions++ }
export function codingSessionClosed(): void { activeSessions = Math.max(0, activeSessions - 1) }
export function activeCodingSessions(): number { return activeSessions }

function codingEngineEnv(): NodeJS.ProcessEnv {
  const guards = getCachedEngineGuards()
  const placement = getCachedGpuPlacement()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OLLAMA_HOST: `127.0.0.1:${CODING_ENGINE_PORT}`,
    OLLAMA_MODELS: ollamaModelsDir(),
    OLLAMA_MAX_LOADED_MODELS: '1',
    OLLAMA_NUM_PARALLEL: '1',
    OLLAMA_FLASH_ATTENTION: guards.flashAttention ? '1' : '0',
    OLLAMA_KV_CACHE_TYPE: guards.kvCacheType,
    // The one place the big coding context is allowed to be a server default: this engine
    // serves nothing but Claude Code, whose endpoint can't send num_ctx per request.
    OLLAMA_CONTEXT_LENGTH: String(guards.codingCtx),
  }
  // Pin to the imaging card (user decision: coding shares it). comfyIndex defaults to 1
  // in the placement; if placement is unresolved this stays unpinned and availability
  // gating below keeps us off single-GPU boxes anyway.
  const idx = placement.comfyIndex
  if (idx != null) {
    env.CUDA_DEVICE_ORDER = 'PCI_BUS_ID'
    env.CUDA_VISIBLE_DEVICES = String(idx)
    if (placement.ollamaDisableVulkan && process.env.OLLAMA_VULKAN === undefined) env.OLLAMA_VULKAN = '0'
  }
  return env
}

async function reachable(timeoutMs = 1_500): Promise<boolean> {
  try {
    const r = await fetch(`${CODING_ENGINE_BASE}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) })
    return r.ok
  } catch { return false }
}

/** Is the imaging GPU actually present right now? The eGPU can drop off the bus (code 47 /
 *  reboot-recognition quirk), and a single-GPU box has no second card to dedicate. */
export async function codingGpuAvailable(): Promise<boolean> {
  const idx = getCachedGpuPlacement().comfyIndex
  if (idx == null) return false
  try {
    const gpus = await detectCudaDevices()
    return gpus.some((g) => g.index === idx)
  } catch { return false }
}

// Non-overlapping ensure: concurrent session opens must not race two spawns.
let ensuring: Promise<boolean> | null = null

/** Spawn the coding engine if it isn't running. Returns true when it's reachable. */
export async function ensureCodingEngine(): Promise<boolean> {
  if (remoteEngineState().enabled) return false
  if (ensuring) return ensuring
  ensuring = (async () => {
    try {
      if (await reachable()) return true
      if (!(await codingGpuAvailable())) return false
      const bin = findSystemOllama() ?? join(dataDir, OLLAMA_BIN_DEST)
      if (!existsSync(bin)) return false
      const guards = getCachedEngineGuards()
      spawnDetachedHidden(bin, ['serve'], { env: codingEngineEnv() }).unref()
      spawnedCtx = guards.codingCtx
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 500))
        if (await reachable()) {
          logger.info(`[coding-engine] up on :${CODING_ENGINE_PORT} (GPU ${getCachedGpuPlacement().comfyIndex}, ctx ${spawnedCtx})`)
          return true
        }
      }
      logger.warn('[coding-engine] spawned but never became reachable')
      return false
    } finally {
      ensuring = null
    }
  })()
  return ensuring
}

/**
 * The base URL Claude Code should talk to. Remote engine wins (unchanged passthrough);
 * then the dedicated engine when its GPU is present; else the MAIN local engine (coding
 * shares the chat card - slower, but alive when the eGPU is dropped).
 */
export async function codingEngineUrl(): Promise<string> {
  const remote = remoteEngineState()
  if (remote.enabled) return remote.baseUrl ?? remote.localUrl
  if (await ensureCodingEngine()) return CODING_ENGINE_BASE
  logger.warn('[coding-engine] unavailable - coding falls back to the main engine (shared GPU)')
  return remoteEngineState().localUrl
}

/**
 * Fire on every coding-session open (terminal WS, remote claude-code, headless tool):
 * brings the engine up and warms the coding model at the engine's baked context so the
 * first prompt doesn't pay the cold load. Fire-and-forget safe.
 */
export async function prepareCodingSession(): Promise<void> {
  try {
    if (remoteEngineState().enabled) return
    if (!(await ensureCodingEngine())) return
    const model = await resolveCodingModelTag()
    const ctx = spawnedCtx ?? getCachedEngineGuards().codingCtx
    await fetch(`${CODING_ENGINE_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 30m keep_alive: a coding session in active use refreshes residency on every
      // request; after 30 idle minutes the VRAM returns to imaging on its own.
      body: JSON.stringify({ model, keep_alive: '30m', options: { num_ctx: ctx } }),
      signal: AbortSignal.timeout(300_000),
    })
  } catch (err) {
    logger.warn(`[coding-engine] prepare failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Imaging handoff: an image job is about to run on the shared GPU. If nobody is actively
 * coding, release the coding model so ComfyUI gets the whole card. Best-effort.
 */
export async function releaseCodingGpuForImaging(): Promise<void> {
  if (activeSessions > 0) return
  if (!(await reachable())) return
  try {
    const model = await resolveCodingModelTag()
    await ollamaUnloadModel(model, CODING_ENGINE_BASE)
    logger.info('[coding-engine] released coding model for an image job')
  } catch { /* best-effort */ }
}

/** Stop the engine process (admin restart-engine action / uninstall). Kill is by LISTENING
 *  PORT - both engines run an identical `ollama serve` command line, so a command-line match
 *  would take the main engine down too. Sweeps the runners the kill orphans. Sessions
 *  reconnect via prepareCodingSession on their next open. */
export async function stopCodingEngine(): Promise<void> {
  await killByListeningPort(CODING_ENGINE_PORT)
  await sweepOrphanLlamaRunners('stopCodingEngine')
  spawnedCtx = null
}
