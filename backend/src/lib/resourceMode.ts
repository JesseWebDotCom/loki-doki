// ONE switch for resource management across every subsystem (LLM, voice, image,
// video). This is the simplification layer over the pile of individual "smart"
// pieces (engineAutotune, hwfit GPU placement, voice device detect, ComfyUI vram
// fit): instead of a knob per subsystem, there is one mode.
//
//   automatic (default): the system owns every placement decision: which model
//     fits VRAM, what runs on GPU vs CPU, which GPU, when to evict. Per-subsystem
//     manual overrides (a pinned LLM model, a forced voice device) are IGNORED so
//     "best performance" is coherent and self-healing. This is what a family box
//     should run.
//   manual: the operator's explicit per-subsystem settings take effect, for people
//     who want to pin a specific model / force a device.
//
// Boot-cached like engineGuards so hot paths (getModel) read it synchronously.

import { getAppSetting, setAppSetting } from '@/lib/settings'
import { logger } from '@/lib/logger'

export type ResourceMode = 'automatic' | 'manual'
export const RESOURCE_MODE_KEY = 'resource.mode'

let cache: ResourceMode = 'automatic'

/** Load the persisted mode into the sync cache. Call at boot (before the first model
 *  spawn) and after every change. Defaults to 'automatic' on anything unexpected. */
export async function resolveResourceMode(): Promise<ResourceMode> {
  try {
    const raw = await getAppSetting(RESOURCE_MODE_KEY)
    cache = raw === 'manual' ? 'manual' : 'automatic'
  } catch { cache = 'automatic' }
  return cache
}

/** Sync accessor for hot paths (getModel, sidecar spawn). 'automatic' until resolved. */
export function getCachedResourceMode(): ResourceMode { return cache }

/** True when the system should own placement and ignore per-subsystem manual overrides. */
export function isAutomatic(): boolean { return cache === 'automatic' }

/** Persist the mode and refresh the cache. */
export async function setResourceMode(mode: ResourceMode): Promise<ResourceMode> {
  await setAppSetting(RESOURCE_MODE_KEY, mode)
  cache = mode
  logger.info(`[resource] mode = ${mode}`)
  return cache
}
