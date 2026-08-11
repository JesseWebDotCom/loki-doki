// Model-set orchestration: plan/apply/finalize switching between named sets of the
// Ollama-backed roles (chat, vision, router LLM, embeddings), with disk cleanup of
// superseded models. Only Ollama roles differ between sets — the ComfyUI image/video
// stack is identical in both, so cleanup never touches checkpoints or LoRAs.
//
// A switch is durable and crash-safe: `model_set_pending` is persisted first, the
// pulls run through the download-jobs queue, and maybeFinalizeSetSwitch() (called on
// every model-job completion and at boot) flips the role settings only once every
// target model is actually installed — the app keeps running on the old set until
// the new one is fully present.
import { eq, and } from 'drizzle-orm'
import { db } from '@/db'
import { downloadJobs } from '@/db/schema'
import {
  CATALOG, MODEL_SETS, DEFAULT_MODEL_SET, ROLE_SETTINGS_KEY, catalogForTier,
  recommendedTier, inSet, type CatalogModel, type ModelSetId,
} from '@/lib/catalog'
import { getActiveModelSetSync, setActiveModelSetSync } from '@/lib/modelSetState'
import { getAppSetting, setAppSetting, deleteAppSetting } from '@/lib/settings'
import { detectHardware } from '@/lib/hwfit'
import { ollamaList, ollamaUnloadModel } from '@/llm/ollama'
import { setEmbedModelCache } from '@/llm/embed'
import {
  setModelSettingAndUnloadDisplaced, invalidateRouterModelCache, invalidateFastModelCache,
} from '@/lib/models'
import { removeFromLedger } from '@/lib/installRegistry'
import { logger } from '@/lib/logger'

const SETTING_ACTIVE = 'model_set'
const SETTING_PENDING = 'model_set_pending'

const normTag = (t: string) => t.replace(/:latest$/, '')

function isSetId(v: unknown): v is ModelSetId {
  return typeof v === 'string' && MODEL_SETS.some((s) => s.id === v)
}

export async function getActiveModelSet(): Promise<ModelSetId> {
  const v = await getAppSetting(SETTING_ACTIVE)
  return isSetId(v) ? v : DEFAULT_MODEL_SET
}

export async function getPendingModelSet(): Promise<ModelSetId | null> {
  const v = await getAppSetting(SETTING_PENDING)
  return isSetId(v) ? v : null
}

/** Prime the sync cache and resume any interrupted switch. Call once at boot. */
export async function initModelSets(): Promise<void> {
  setActiveModelSetSync(await getActiveModelSet())
  await maybeFinalizeSetSwitch().catch((err) => {
    logger.warn(`[model-sets] boot finalize check failed: ${String(err)}`)
  })
}

/**
 * Persist a catalog model as the choice for its role. Single source of truth for the
 * pattern previously duplicated in setup.ts / downloadJobs.ts / adminInstall.ts:
 * role key first, then the canonical 'model'/'vision_model' keys through the
 * displaced-unload helper so the outgoing pinned model releases its runner.
 */
export async function applyModelRoleSelection(m: CatalogModel): Promise<void> {
  const key = ROLE_SETTINGS_KEY[m.role]
  if (key) await setAppSetting(key, m.id)
  if (m.role === 'llm' || m.role === 'uncensored_llm') await setModelSettingAndUnloadDisplaced('model', m.id)
  if ((m.role === 'llm' || m.role === 'uncensored_llm') && m.builtinVision) await setModelSettingAndUnloadDisplaced('vision_model', m.id)
  if (m.role === 'router_llm') { invalidateRouterModelCache(); invalidateFastModelCache() }
  if (m.role === 'embeddings') setEmbedModelCache(m.id)
}

/**
 * While a set switch is pending, its models must not flip role settings one by one as
 * their downloads finish — the finalizer applies the whole set atomically once every
 * piece is installed. Individual installs unrelated to the pending set behave as before.
 */
export async function shouldDeferRoleSelection(m: CatalogModel): Promise<boolean> {
  const pending = await getPendingModelSet()
  if (!pending) return false
  return !!m.sets && inSet(m, pending)
}

/** The per-role Ollama targets a set resolves to on this machine's tier. */
async function ollamaTargetsForSet(set: ModelSetId): Promise<CatalogModel[]> {
  const hw = await detectHardware()
  const tier = recommendedTier(hw)
  return catalogForTier(tier, set).filter((m) => m.backend === 'ollama' && m.ollamaTag)
}

async function installedOllamaTags(): Promise<Set<string>> {
  try {
    return new Set((await ollamaList()).map((m) => normTag(m.name)))
  } catch {
    return new Set()
  }
}

/** Every model tag any setting still points at — the "do not delete" list. */
async function referencedModelIds(): Promise<Set<string>> {
  const keys = [
    ...Object.values(ROLE_SETTINGS_KEY),
    'model', 'podcast.script_model', 'books.generate_model',
  ]
  const refs = new Set<string>()
  for (const key of keys) {
    const v = await getAppSetting(key)
    if (typeof v === 'string' && v.trim()) { refs.add(v); refs.add(normTag(v)) }
  }
  for (const env of [process.env.MODEL, process.env.ROUTER_MODEL]) {
    if (env) { refs.add(env); refs.add(normTag(env)) }
  }
  return refs
}

export interface SetSwitchPlan {
  target: ModelSetId
  active: ModelSetId
  pending: ModelSetId | null
  toInstall: { id: string; label: string; approxBytes: number; role: string }[]
  toRemove: { id: string; label: string; approxBytes: number; role: string }[]
  downloadBytes: number
  reclaimBytes: number
  embedderChanges: boolean
}

/** Diff a target set against what's installed + configured. Read-only. */
export async function planSetSwitch(target: ModelSetId): Promise<SetSwitchPlan> {
  const active = await getActiveModelSet()
  const pending = await getPendingModelSet()
  const installed = await installedOllamaTags()

  const targets = await ollamaTargetsForSet(target)
  const toInstall = targets.filter((m) => !installed.has(normTag(m.ollamaTag!)))

  // Removal candidates: set-specific Ollama entries that are NOT in the target set.
  // Shared entries (no `sets` field: all-minilm, ornith) are never candidates, and the
  // final safety check against live settings happens again at cleanup time.
  const targetIds = new Set(targets.map((m) => m.id))
  const toRemove = CATALOG.filter((m) =>
    m.backend === 'ollama' && m.ollamaTag && m.sets && !inSet(m, target) &&
    !targetIds.has(m.id) && installed.has(normTag(m.ollamaTag)),
  )

  const activeEmbed = targets.find((m) => m.role === 'embeddings')
  const currentEmbed = await getAppSetting('embed_model')
  const embedderChanges = !!activeEmbed && typeof currentEmbed === 'string'
    ? normTag(activeEmbed.id) !== normTag(currentEmbed)
    : !!toInstall.find((m) => m.role === 'embeddings')

  const shape = (m: CatalogModel) => ({ id: m.id, label: m.label, approxBytes: m.approxBytes, role: m.role })
  return {
    target, active, pending,
    toInstall: toInstall.map(shape),
    toRemove: toRemove.map(shape),
    downloadBytes: toInstall.reduce((s, m) => s + m.approxBytes, 0),
    reclaimBytes: toRemove.reduce((s, m) => s + m.approxBytes, 0),
    embedderChanges,
  }
}

/**
 * Start switching to a set: mark it pending and queue the missing pulls. The flip to
 * the new set (settings, caches, cleanup, re-embed) happens in maybeFinalizeSetSwitch()
 * once every target model is installed.
 */
export async function applySetSwitch(target: ModelSetId): Promise<SetSwitchPlan> {
  const plan = await planSetSwitch(target)
  if (plan.active === target && !plan.pending) return plan

  await setAppSetting(SETTING_PENDING, target)
  if (plan.toInstall.length) {
    const { enqueueBackground } = await import('@/lib/downloadJobs')
    await enqueueBackground({ modelIds: plan.toInstall.map((m) => m.id), force: true })
  }
  // Everything may already be on disk (e.g. switching back) — finalize immediately.
  await maybeFinalizeSetSwitch()
  return plan
}

let finalizing = false

/**
 * Complete a pending switch if every target model is installed. Idempotent and safe to
 * call often — it runs after each model download job and at boot.
 */
export async function maybeFinalizeSetSwitch(): Promise<boolean> {
  if (finalizing) return false
  const pending = await getPendingModelSet()
  if (!pending) return false

  finalizing = true
  try {
    const installed = await installedOllamaTags()
    if (installed.size === 0) return false // Ollama unreachable — try again later
    const targets = await ollamaTargetsForSet(pending)
    const missing = targets.filter((m) => !installed.has(normTag(m.ollamaTag!)))
    if (missing.length) return false

    const currentEmbed = await getAppSetting('embed_model')

    // Flip every role. Order matters only for chat-vs-vision, which
    // applyModelRoleSelection already handles (builtinVision).
    for (const m of targets) await applyModelRoleSelection(m)

    await setAppSetting(SETTING_ACTIVE, pending)
    await deleteAppSetting(SETTING_PENDING)
    setActiveModelSetSync(pending)

    // Autotune budgets depend on the active set's residents — re-resolve.
    const { resolveEngineAutotune } = await import('@/lib/engineAutotune')
    await resolveEngineAutotune()

    // Embedder changed → every stored vector is from a different space. Queue the
    // full re-embed (backgrounded, resumable) before cleanup so search degrades
    // gracefully instead of silently mixing spaces.
    const newEmbed = targets.find((m) => m.role === 'embeddings')
    if (newEmbed && (typeof currentEmbed !== 'string' || normTag(currentEmbed) !== normTag(newEmbed.id))) {
      const { startReembed } = await import('@/lib/reembed')
      void startReembed(newEmbed.id)
    }

    await cleanupSupersededModels(pending)
    logger.info(`[model-sets] switched to '${pending}'`)
    return true
  } finally {
    finalizing = false
  }
}

/**
 * Delete Ollama models that belong only to other sets and are no longer referenced by
 * any model setting. Frees disk; never touches ComfyUI checkpoints, LoRAs, stock
 * models the user pulled themselves, or anything a setting still points at.
 */
export async function cleanupSupersededModels(target: ModelSetId): Promise<{ removed: string[]; reclaimedBytes: number }> {
  const installed = await installedOllamaTags()
  const refs = await referencedModelIds()
  const removed: string[] = []
  let reclaimedBytes = 0

  const candidates = CATALOG.filter((m) =>
    m.backend === 'ollama' && m.ollamaTag && m.sets && !inSet(m, target) &&
    installed.has(normTag(m.ollamaTag)) && !refs.has(m.id) && !refs.has(normTag(m.ollamaTag)),
  )

  for (const m of candidates) {
    const tag = m.ollamaTag!
    try {
      await ollamaUnloadModel(tag)
      const base = (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '')
      const res = await fetch(`${base}/api/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: tag }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) { logger.warn(`[model-sets] ollama delete failed for ${tag}: ${res.status}`); continue }
      // Purge the completed job row so a future switch back re-enqueues cleanly,
      // and drop it from the install ledger.
      await db.delete(downloadJobs).where(and(eq(downloadJobs.type, 'model'), eq(downloadJobs.refId, m.id)))
      await removeFromLedger(m.id)
      removed.push(tag)
      reclaimedBytes += m.approxBytes
    } catch (err) {
      logger.warn(`[model-sets] cleanup of ${tag} failed: ${String(err)}`)
    }
  }

  if (removed.length) {
    logger.info(`[model-sets] cleaned up ${removed.length} superseded model(s), ~${(reclaimedBytes / 1e9).toFixed(1)} GB reclaimed: ${removed.join(', ')}`)
  }
  return { removed, reclaimedBytes }
}
