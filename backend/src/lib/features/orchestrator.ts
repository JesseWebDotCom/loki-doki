// The one-switch feature orchestrator. Enable = flip the capability gate + store tool
// flags, then hand the missing physical parts to the durable background download queue
// (prereq injection, retries, resume, and the BackgroundSetupWidget all come with it).
// Disable = flip the flags back and cancel in-flight installs; bytes stay on disk and
// the install ledger keeps healing them, so re-enable is instant. Elevation-gated
// parts (the coding sandbox) are never auto-run: they surface as attention items the
// admin approves interactively through the existing SSE repair endpoint.

import { and, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { downloadJobs } from '@/db/schema'
import { setFeatureGate } from '@/lib/featureGate'
import { setToolEnabled } from '@/lib/toolConfig'
import { getInstallComponent } from '@/lib/installRegistry'
import { enqueueBackground, cancelJob } from '@/lib/downloadJobs'
import { isDownloadBlocked } from '@/lib/connectivity'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { logger } from '@/lib/logger'
import { USER_FEATURES, getUserFeature, resolveFeatureInstallSet, type UserFeatureDef } from './registry'
import { getFeatureStatus, type FeatureStatus } from './status'

export class FeatureError extends Error {
  constructor(message: string, readonly code: 'unknown_feature' | 'offline') {
    super(message)
  }
}

function requireDef(id: string): UserFeatureDef {
  const def = getUserFeature(id)
  if (!def) throw new FeatureError(`Unknown feature '${id}'`, 'unknown_feature')
  return def
}

/** Enqueue whatever is missing for a feature. force applies only to components that a
 *  completed job row says exist but whose files are live-verified gone. */
async function enqueueMissing(def: UserFeatureDef): Promise<number> {
  const set = await resolveFeatureInstallSet(def)
  const missingComponents = set.componentIds.filter((cid) => !getInstallComponent(cid)?.isInstalled())
  let queued = 0
  if (missingComponents.length) {
    queued += await enqueueBackground({ componentIds: missingComponents, force: true })
  }
  if (set.ollamaModelIds.length) {
    // No force: an already-pulled Ollama model resolves as a completed job / fast no-op.
    queued += await enqueueBackground({ modelIds: set.ollamaModelIds })
  }
  return queued
}

export async function enableFeature(id: string, adminId?: string): Promise<FeatureStatus> {
  const def = requireDef(id)
  const set = await resolveFeatureInstallSet(def)
  const missing = set.componentIds.some((cid) => !getInstallComponent(cid)?.isInstalled())
    || set.ollamaModelIds.length > 0
  if (missing && (await isDownloadBlocked())) {
    throw new FeatureError('Offline mode is active: downloads are blocked, so this feature cannot be set up right now.', 'offline')
  }

  await setFeatureGate(def.gateId, true)
  for (const toolId of def.toolIds ?? []) await setToolEnabled(toolId, true)
  await enqueueMissing(def)

  logger.info(`[features] ENABLED '${id}' by admin=${adminId ?? 'unknown'}`)
  return (await getFeatureStatus(id))!
}

export async function disableFeature(id: string, adminId?: string): Promise<FeatureStatus> {
  const def = requireDef(id)
  await setFeatureGate(def.gateId, false)
  for (const toolId of def.toolIds ?? []) await setToolEnabled(toolId, false)

  // Cancel this feature's in-flight installs; finished bytes stay on disk.
  const refIds = def.components.map((c) => c.componentId)
  const active = await db.select({ id: downloadJobs.id })
    .from(downloadJobs)
    .where(and(inArray(downloadJobs.refId, refIds), inArray(downloadJobs.status, ['pending', 'running'])))
  for (const job of active) await cancelJob(job.id)

  logger.info(`[features] DISABLED '${id}' by admin=${adminId ?? 'unknown'}`)
  return (await getFeatureStatus(id))!
}

/** Re-enqueue missing/failed parts (enqueueBackground resets failed jobs to pending). */
export async function repairFeature(id: string, adminId?: string): Promise<FeatureStatus> {
  const def = requireDef(id)
  if (await isDownloadBlocked()) {
    throw new FeatureError('Offline mode is active: downloads are blocked.', 'offline')
  }
  await enqueueMissing(def)
  logger.info(`[features] REPAIR '${id}' by admin=${adminId ?? 'unknown'}`)
  return (await getFeatureStatus(id))!
}

/** One-time boot migration: write an explicit gate row per user feature so switches
 *  reflect installed reality. A feature whose required, platform-supported components
 *  are all present seeds ON; anything else seeds OFF (it did not work anyway). Rows an
 *  admin already set are left alone. Runs before reconcileInstalls so healing is
 *  unaffected. */
export async function seedFeatureSwitchesOnce(): Promise<void> {
  if ((await getAppSetting('feature_switches_seeded')) === true) return
  for (const def of USER_FEATURES) {
    const existing = await getAppSetting(`app_feature.${def.gateId}`)
    if (typeof existing === 'boolean') continue
    const required = def.components.filter(
      (c) => !c.optional && (!c.platforms || c.platforms.includes(process.platform)),
    )
    const installed = required.every((c) => getInstallComponent(c.componentId)?.isInstalled() ?? false)
    await setFeatureGate(def.gateId, installed)
    logger.info(`[features] seeded switch '${def.id}' = ${installed ? 'on' : 'off'} (from installed state)`)
  }
  await setAppSetting('feature_switches_seeded', true)
}
