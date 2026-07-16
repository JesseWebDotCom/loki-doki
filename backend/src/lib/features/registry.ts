// The user-facing feature registry: one entry per switchable feature, declaring
// everything "on" is made of — install components (installRegistry), model roles
// (catalog), store tool flags, and the capability gate (featureGate). The Features
// hub, the orchestrator, and the App Store all read THIS, so a feature's composition
// lives in exactly one place.
//
// Deliberately separate from featureGate.FEATURES: that stays the security-gate
// registry (risk, perProfile, enforcement); this maps a gate id to the physical
// parts the switch orchestrates. Disabling a feature never deletes bytes: components
// stay in the install ledger (boot keeps healing them) so re-enable is instant.

import type { ModelRole, CatalogModel } from '@/lib/catalog'
import { CATALOG, ROLE_SETTINGS_KEY, recommendedTier, catalogForTier } from '@/lib/catalog'
import { getInstallComponent, availablePackageManagers } from '@/lib/installRegistry'
import { getAppSetting } from '@/lib/settings'
import { detectHardware } from '@/lib/hwfit'

export interface FeaturePartRef {
  componentId: string
  /** The feature counts as ON without it (still installed by enable when supported). */
  optional?: boolean
  /** Restrict to platforms; omit = all. Unsupported parts are excluded from bytes and state. */
  platforms?: NodeJS.Platform[]
}

export interface UserFeatureDef {
  id: string
  label: string
  description: string
  /** featureGate FEATURES id (app_feature.<gateId> is the intent bit). */
  gateId: string
  components: FeaturePartRef[]
  /** Roles whose selected (or tier-recommended) model must be installed. */
  modelRoles?: ModelRole[]
  /** toolGlobalConfig __enabled flags flipped with the switch. */
  toolIds?: string[]
  /** Shown under the switch, e.g. "content packs are chosen inside the app". */
  contentNote?: string
}

export const USER_FEATURES: UserFeatureDef[] = [
  {
    id: 'coding',
    label: 'Coding',
    description: 'AI coding terminals (Claude Code) running on this server, one per person.',
    gateId: 'coding',
    components: [
      { componentId: 'claude-code' },
      { componentId: 'tmux', optional: true, platforms: ['darwin', 'linux'] },
      { componentId: 'coding-sandbox-user', optional: true },
    ],
    modelRoles: ['coding'],
    toolIds: ['coding'],
  },
  {
    id: 'voice',
    label: 'Voice',
    description: 'Talking companions, narration, and dictation, all processed locally.',
    gateId: 'voice',
    components: [
      { componentId: 'voice-core' },
      { componentId: 'silero-vad', optional: true },
      { componentId: 'wakeword-core', optional: true },
    ],
  },
  {
    id: 'image_gen',
    label: 'Image Generation',
    description: 'Create images and video on this server with ComfyUI.',
    gateId: 'image_gen',
    components: [
      { componentId: 'comfyui-base' },
      { componentId: 'comfyui-nodes' },
      { componentId: 'sdxl-vae' },
      { componentId: 'vtracer', optional: true },
    ],
    modelRoles: ['image_gen'],
    toolIds: ['image_gen'],
  },
  {
    id: 'music_studio',
    label: 'Music Studio',
    description: 'Split songs into stems for karaoke, remixing, and instrument practice.',
    gateId: 'music_studio',
    components: [{ componentId: 'stem-audio' }],
    toolIds: ['music_insights'],
  },
  {
    id: 'web_search',
    label: 'Web Search',
    description: 'Private web search for you and the companion, via bundled SearXNG.',
    gateId: 'web_search',
    components: [{ componentId: 'searxng' }],
    toolIds: ['search'],
  },
  {
    id: 'reference',
    label: 'Reference Library',
    description: 'Offline encyclopedias, guides, and manuals served from this server.',
    gateId: 'reference',
    components: [{ componentId: 'kiwix-tools' }],
    toolIds: ['knowledge'],
    contentNote: 'Reference packs (Wikipedia, repair guides, and more) are chosen inside the Reference app.',
  },
]

export function getUserFeature(id: string): UserFeatureDef | undefined {
  return USER_FEATURES.find((f) => f.id === id)
}

/** Reverse map: store tool id → owning user feature (for the App Store install flow). */
export function featureIdForTool(toolId: string): string | undefined {
  return USER_FEATURES.find((f) => f.toolIds?.includes(toolId))?.id
}

/** The selected model for a role (app_settings), else the tier-recommended one. */
export async function resolveRoleModel(role: ModelRole): Promise<CatalogModel | null> {
  const configured = (await getAppSetting(ROLE_SETTINGS_KEY[role])) as string | null
  if (configured) {
    const m = CATALOG.find((x) => x.id === configured)
    if (m) return m
  }
  const hw = await detectHardware()
  return catalogForTier(recommendedTier(hw)).find((m) => m.role === role) ?? null
}

export interface FeatureInstallSet {
  /** Registry components to enqueue (platform-supported, non-elevation), including
   *  image-role models, which ARE install components. */
  componentIds: string[]
  /** Ollama-backed role models to enqueue. */
  ollamaModelIds: string[]
  /** Platform-excluded component ids (never counted or enqueued). */
  unsupported: string[]
  /** Components needing a one-time interactive OS approval (never auto-enqueued). */
  needsElevation: string[]
  /** Components whose install shells out to an absent package manager. */
  needsPackageManager: string[]
}

/** Resolve the concrete install set for this machine right now. */
export async function resolveFeatureInstallSet(def: UserFeatureDef): Promise<FeatureInstallSet> {
  const set: FeatureInstallSet = { componentIds: [], ollamaModelIds: [], unsupported: [], needsElevation: [], needsPackageManager: [] }
  const pkgManagers = availablePackageManagers()

  for (const part of def.components) {
    if (part.platforms && !part.platforms.includes(process.platform)) { set.unsupported.push(part.componentId); continue }
    const comp = getInstallComponent(part.componentId)
    if (!comp) continue
    if (comp.needsElevation) { set.needsElevation.push(part.componentId); continue }
    if (comp.needsPackageManager && pkgManagers.length === 0) { set.needsPackageManager.push(part.componentId); continue }
    set.componentIds.push(part.componentId)
  }

  for (const role of def.modelRoles ?? []) {
    const model = await resolveRoleModel(role)
    if (!model) continue
    if (model.backend === 'ollama') set.ollamaModelIds.push(model.id)
    else if (getInstallComponent(model.id)) set.componentIds.push(model.id)
  }

  return set
}
