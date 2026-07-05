// Restore plan — the persisted "these previously-installed things are missing and
// restoring them is big enough (or delicate enough) to ask first" record.
//
// Written by boot reconcile (routes/system.ts) when it detects an OS reinstall or a
// large missing set; read by GET /api/system/restore; consumed by the admin-facing
// RestorePrompt in the frontend. Lives in app_settings (data/app.db) so it survives
// backend restarts — the whole point is that data/ is the drive that survived.

import { getAppSetting, setAppSetting } from '@/lib/settings'

const PLAN_KEY = 'restore_plan'

export interface RestoreAttentionItem {
  id: string
  label: string
  /** Human-readable reason this can't be auto-repaired (needs elevation / a package manager). */
  reason: string
}

export interface RestorePlan {
  createdAt: string
  /** True when the OS fingerprint changed — i.e. Windows/macOS/Linux was reinstalled. */
  osChanged: boolean
  /** Registry component ids awaiting consent to re-download. */
  componentIds: string[]
  /** Catalog Ollama-model ids awaiting consent to re-pull. */
  modelIds: string[]
  /** Estimated total download for componentIds + modelIds. */
  totalBytes: number
  /** Items we will never auto-repair — they need the user to act (admin prompt, install winget…). */
  attention: RestoreAttentionItem[]
  status: 'pending' | 'started' | 'dismissed'
}

export async function getRestorePlan(): Promise<RestorePlan | null> {
  const v = await getAppSetting(PLAN_KEY)
  if (!v || typeof v !== 'object') return null
  const plan = v as RestorePlan
  return Array.isArray(plan.componentIds) && Array.isArray(plan.modelIds) ? plan : null
}

export async function saveRestorePlan(plan: RestorePlan): Promise<void> {
  await setAppSetting(PLAN_KEY, plan)
}

export async function clearRestorePlan(): Promise<void> {
  await setAppSetting(PLAN_KEY, null)
}
