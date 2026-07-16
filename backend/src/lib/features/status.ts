// Per-feature state derivation over the four underlying mechanisms: the capability
// gate (intent), the install ledger/components (bytes on disk), the background job
// queue (in-flight installs), and Ollama (role models). Read-only; the orchestrator
// owns writes.

import { and, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { downloadJobs } from '@/db/schema'
import { isFeatureEnabled } from '@/lib/featureGate'
import { getInstallComponent } from '@/lib/installRegistry'
import { CATALOG } from '@/lib/catalog'
import { USER_FEATURES, resolveRoleModel, type UserFeatureDef } from './registry'

export type UserFeatureState = 'off' | 'installing' | 'on' | 'error'

export type FeaturePartState =
  | 'installed' | 'missing' | 'installing' | 'failed' | 'unsupported' | 'needs-approval' | 'needs-pkg-manager'

export interface FeaturePartStatus {
  id: string
  label: string
  kind: 'component' | 'model'
  state: FeaturePartState
  approxBytes: number
  optional: boolean
  error?: string
}

export interface FeatureProgress {
  completed: number
  total: number
  label: string
}

export interface FeatureStatus {
  id: string
  label: string
  description: string
  state: UserFeatureState
  /** The intent bit (capability gate). */
  enabled: boolean
  /** ON, but an installable optional part failed or awaits an interactive approval. */
  degraded: boolean
  /** Bytes still to download if enabled now (missing, platform-supported parts). */
  bytesRequired: number
  parts: FeaturePartStatus[]
  progress?: FeatureProgress
  contentNote?: string
}

interface JobRow {
  refId: string
  status: string
  lastError: string | null
  progress: string | null
}

function ollamaUrl(): string {
  return (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '')
}

async function installedOllamaTags(): Promise<Set<string> | null> {
  try {
    const r = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(3000) })
    if (!r.ok) return null
    const { models } = (await r.json()) as { models: { name: string }[] }
    return new Set(models.map((m) => m.name))
  } catch {
    return null
  }
}

function hasOllamaTag(tags: Set<string>, tag: string): boolean {
  if (tags.has(tag)) return true
  const prefix = tag.split(':')[0] ?? tag
  return [...tags].some((t) => t.startsWith(prefix))
}

const ACTIVE_JOB = new Set(['pending', 'running'])

async function featureStatusFrom(
  def: UserFeatureDef,
  jobs: Map<string, JobRow>,
  ollamaTags: Set<string> | null,
): Promise<FeatureStatus> {
  const enabled = await isFeatureEnabled(def.gateId)
  const parts: FeaturePartStatus[] = []

  for (const ref of def.components) {
    const comp = getInstallComponent(ref.componentId)
    if (!comp) continue
    const job = jobs.get(ref.componentId)
    let state: FeaturePartState
    if (ref.platforms && !ref.platforms.includes(process.platform)) state = 'unsupported'
    else if (comp.isInstalled()) state = 'installed'
    else if (job && ACTIVE_JOB.has(job.status)) state = 'installing'
    else if (job?.status === 'failed') state = 'failed'
    else if (comp.needsElevation) state = 'needs-approval'
    else if (comp.needsPackageManager) state = 'needs-pkg-manager'
    else state = 'missing'
    parts.push({
      id: comp.id, label: comp.label, kind: 'component', state,
      approxBytes: comp.approxBytes ?? 0, optional: ref.optional === true,
      error: state === 'failed' ? job?.lastError ?? undefined : undefined,
    })
  }

  for (const role of def.modelRoles ?? []) {
    const model = await resolveRoleModel(role)
    if (!model) continue
    // Image-role models are registry components and were not added above (they are
    // resolved per-role), so classify them here alongside Ollama models.
    const asComponent = getInstallComponent(model.id)
    const job = jobs.get(model.id)
    let state: FeaturePartState
    if (asComponent?.isInstalled()) state = 'installed'
    else if (model.backend === 'ollama' && model.ollamaTag && ollamaTags && hasOllamaTag(ollamaTags, model.ollamaTag)) state = 'installed'
    else if (job && ACTIVE_JOB.has(job.status)) state = 'installing'
    else if (job?.status === 'failed') state = 'failed'
    else state = 'missing'
    parts.push({
      id: model.id, label: model.label, kind: 'model', state,
      approxBytes: model.approxBytes ?? 0, optional: false,
      error: state === 'failed' ? job?.lastError ?? undefined : undefined,
    })
  }

  const required = parts.filter((p) => !p.optional && p.state !== 'unsupported')
  const bytesRequired = parts
    .filter((p) => p.state === 'missing' || p.state === 'failed' || p.state === 'installing')
    .reduce((sum, p) => sum + p.approxBytes, 0)

  let state: UserFeatureState
  if (!enabled) state = 'off'
  else if (required.some((p) => p.state === 'failed')) state = 'error'
  else if (parts.some((p) => p.state === 'installing')) state = 'installing'
  else if (required.every((p) => p.state === 'installed')) state = 'on'
  else state = 'installing' // enabled with parts still missing: treat as mid-setup

  const degraded = state === 'on' && parts.some(
    (p) => p.optional && (p.state === 'failed' || p.state === 'needs-approval' || p.state === 'needs-pkg-manager'),
  )

  // Byte-weighted aggregate progress across this feature's active jobs.
  let progress: FeatureProgress | undefined
  if (state === 'installing') {
    let completed = 0
    let total = 0
    let label = 'Preparing…'
    for (const p of parts) {
      if (p.state === 'installed') { completed += p.approxBytes; total += p.approxBytes; continue }
      if (p.state !== 'installing' && p.state !== 'missing') continue
      total += p.approxBytes
      const job = jobs.get(p.id)
      if (job?.status === 'running') label = `Installing ${p.label}…`
      if (job?.progress) {
        try {
          const pr = JSON.parse(job.progress) as { completed?: number; total?: number }
          if (pr.completed && pr.total) completed += Math.min(pr.completed, p.approxBytes || pr.total)
        } catch { /* ignore malformed progress */ }
      }
    }
    progress = { completed, total, label }
  }

  return {
    id: def.id, label: def.label, description: def.description,
    state, enabled, degraded, bytesRequired, parts, progress,
    contentNote: def.contentNote,
  }
}

/** All refIds a feature's parts can appear under in the job queue. */
function featureRefIds(def: UserFeatureDef): string[] {
  const ids = def.components.map((c) => c.componentId)
  for (const role of def.modelRoles ?? []) {
    for (const m of CATALOG) if (m.role === role) ids.push(m.id)
  }
  return ids
}

export async function listFeatureStatuses(): Promise<FeatureStatus[]> {
  const allRefIds = [...new Set(USER_FEATURES.flatMap(featureRefIds))]
  const rows = allRefIds.length
    ? await db.select({
        refId: downloadJobs.refId, status: downloadJobs.status,
        lastError: downloadJobs.lastError, progress: downloadJobs.progress,
      }).from(downloadJobs).where(and(
        inArray(downloadJobs.type, ['component', 'model']),
        inArray(downloadJobs.refId, allRefIds),
      ))
    : []
  const jobs = new Map<string, JobRow>(rows.map((r) => [r.refId, r]))
  const ollamaTags = await installedOllamaTags()
  return Promise.all(USER_FEATURES.map((def) => featureStatusFrom(def, jobs, ollamaTags)))
}

export async function getFeatureStatus(id: string): Promise<FeatureStatus | undefined> {
  return (await listFeatureStatuses()).find((f) => f.id === id)
}
