// Durable, server-owned background download queue.
//
// First-run hands the non-essential set (extra models, ZIMs, maps, components) here so
// the app boots on essentials and finishes the rest in the background — surviving page
// navigation and backend restarts. Scheduler rules (per product decision):
//   • at most 1 "large" job running at once
//   • at most 1 job per domain (host) at once
//   • at most MAX_CONCURRENT jobs total
// Each job retries up to maxAttempts with exponential backoff; .part files mean retries
// resume rather than restart.

import { randomUUID } from 'node:crypto'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm'
import { db } from '@/db'
import { downloadJobs } from '@/db/schema'
import { CATALOG, ROLE_SETTINGS_KEY } from '@/lib/catalog'
import { pullOllama, downloadHfFile, validateSafetensorsFile, dataDir, SDXL_VAE_DEST } from '@/lib/download'
import type { DownloadProgress } from '@/lib/download'
import { downloadArchive, syncKiwixWithArchives } from '@/lib/archives'
import { getKiwixState } from '@/lib/kiwix'
import { buildRegion } from '@/lib/maps/build'
import { getInstallComponent, recordInstalled, IMAGE_ROLES } from '@/lib/installRegistry'
import { setAppSetting } from '@/lib/settings'
import { isDownloadBlocked } from '@/lib/connectivity'
import { killByCommandLine } from '@/lib/platform'
import { logger } from '@/lib/logger'

export type JobType = 'model' | 'archive' | 'map' | 'component' | 'storage-move' | 'yt-media' | 'yt-export' | 'podcast-generate' | 'bookmark-archive' | 'bookmark-thumb'
export type Domain = 'ollama' | 'huggingface' | 'kiwix' | 'maps' | 'comfyui' | 'github' | 'local'

const LARGE_THRESHOLD = 2_000_000_000  // ≥2 GB is "large"
const MAX_CONCURRENT = 4
const BACKOFF_BASE_MS = 5_000
const BACKOFF_MAX_MS = 5 * 60_000
const PROGRESS_WRITE_MS = 1_000
// A running byte-streaming download (model/archive) that reports no progress for this long is
// considered hung. The watchdog aborts it so it requeues and resumes from its .part file instead
// of sitting in 'running' forever (the cause of downloads "stuck at 39%" needing a manual retry).
// Local CPU work (map builds) is intentionally excluded — its build phases are legitimately silent.
const STALL_TIMEOUT_MS = 6 * 60_000
const STALL_WATCHED_TYPES = new Set<JobType>(['model', 'archive'])
// Failed setup/library jobs (runtimes, models, ZIM archives, maps) revive themselves once they've
// sat in 'failed' for this long, so a transient mirror/network outage heals without the user ever
// clicking "Retry now" — the queue self-heals. User-content jobs (podcasts, YouTube media,
// bookmarks) are excluded: a failed episode is a real failure, not a stuck install.
const SELF_HEAL_TYPES: JobType[] = ['model', 'component', 'archive', 'map']
const SELF_HEAL_COOLDOWN_MS = 5 * 60_000

export interface JobSpec {
  type: JobType
  refId: string
  variantKey?: string
  domain: Domain
  sizeClass: 'large' | 'small'
  label: string
  priority: number
}

// ── Spec builders (translate the wizard's selection into job rows) ──────────────

function modelSpec(modelId: string): JobSpec | null {
  const m = CATALOG.find((x) => x.id === modelId)
  if (!m) return null
  // Image-pipeline models install through the component registry (ComfyUI).
  if (IMAGE_ROLES.has(m.role)) {
    return { type: 'component', refId: m.id, domain: 'huggingface', sizeClass: m.approxBytes >= LARGE_THRESHOLD ? 'large' : 'small', label: m.label, priority: 30 }
  }
  return {
    type: 'model', refId: m.id,
    domain: m.backend === 'ollama' ? 'ollama' : 'huggingface',
    sizeClass: m.approxBytes >= LARGE_THRESHOLD ? 'large' : 'small',
    label: m.label, priority: 10,
  }
}

function componentDomain(componentId: string): Domain {
  if (componentId.startsWith('comfyui')) return 'comfyui'
  if (/voice|whisper|wakeword|kokoro|piper|f5/i.test(componentId)) return 'huggingface'
  return 'github'
}

function componentSpec(componentId: string): JobSpec | null {
  const c = getInstallComponent(componentId)
  if (!c) return null
  return { type: 'component', refId: componentId, domain: componentDomain(componentId), sizeClass: 'small', label: c.label, priority: 20 }
}

function archiveSpec(z: { sourceId: string; variantKey?: string; label: string; approxBytes?: number }): JobSpec {
  return { type: 'archive', refId: z.sourceId, variantKey: z.variantKey, domain: 'kiwix', sizeClass: (z.approxBytes ?? 0) >= LARGE_THRESHOLD ? 'large' : 'small', label: z.label, priority: 40 }
}

function mapSpec(regionId: string, label: string): JobSpec {
  return { type: 'map', refId: regionId, domain: 'maps', sizeClass: 'large', label, priority: 35 }
}

export interface EnqueueInput {
  modelIds?: string[]
  componentIds?: string[]
  zimSelections?: { sourceId: string; variantKey?: string; label: string; approxBytes?: number }[]
  maps?: { regionId: string; label: string } | null
}

/** Create job rows for the non-essential set. Idempotent per (type, refId): an existing
 *  pending/running/completed job is left alone; a failed one is reset to pending. */
export async function enqueueBackground(input: EnqueueInput): Promise<number> {
  // Auto-add prerequisite runtimes so content has something to install into.
  const componentIds = [...(input.componentIds ?? [])]
  if ((input.zimSelections ?? []).length && !componentIds.includes('kiwix-tools')) componentIds.push('kiwix-tools')
  if (input.maps && !componentIds.includes('maps-toolchain')) componentIds.push('maps-toolchain')
  // Image-pipeline models need ComfyUI set up before their files can be used.
  // Auto-inject the runtime + extensions when any image-role model is queued, so
  // they install first (priority 20) and the prereqMet gate holds back model jobs
  // (priority 30) until the runtime is ready.
  const hasImageModels = (input.modelIds ?? []).some(id => {
    const m = CATALOG.find(x => x.id === id)
    return m && IMAGE_ROLES.has(m.role)
  })
  if (hasImageModels) {
    if (!componentIds.includes('comfyui-base'))  componentIds.push('comfyui-base')
    if (!componentIds.includes('comfyui-nodes')) componentIds.push('comfyui-nodes')
  }

  const specs: JobSpec[] = []
  for (const id of input.modelIds ?? []) { const s = modelSpec(id); if (s) specs.push(s) }
  for (const id of componentIds) { const s = componentSpec(id); if (s) specs.push(s) }
  for (const z of input.zimSelections ?? []) specs.push(archiveSpec(z))
  if (input.maps) specs.push(mapSpec(input.maps.regionId, input.maps.label))

  const now = new Date()
  let created = 0
  for (const s of specs) {
    const existing = await db.select().from(downloadJobs)
      .where(and(eq(downloadJobs.type, s.type), eq(downloadJobs.refId, s.refId)))
      .then((r) => r[0])
    if (existing) {
      if (existing.status === 'failed' || existing.status === 'cancelled') {
        await db.update(downloadJobs)
          .set({ status: 'pending', attempts: 0, nextEligibleAt: null, lastError: null, updatedAt: now })
          .where(eq(downloadJobs.id, existing.id))
        created++
      }
      continue
    }
    await db.insert(downloadJobs).values({
      id: randomUUID(), type: s.type, refId: s.refId, variantKey: s.variantKey ?? null,
      domain: s.domain, sizeClass: s.sizeClass, label: s.label, priority: s.priority,
      status: 'pending', attempts: 0, maxAttempts: 6, nextEligibleAt: null, lastError: null,
      progress: null, createdAt: now, updatedAt: now,
    })
    created++
  }
  kickScheduler()
  return created
}

// ── Scheduler ───────────────────────────────────────────────────────────────────

// Content jobs can't run until their runtime exists (archives→kiwix, maps→toolchain,
// image models→comfyui-base). The prereq component has lower priority so it installs
// first; until then content jobs stay pending (not failed).
function prereqMet(job: Pick<typeof downloadJobs.$inferSelect, 'type' | 'refId'>): boolean {
  if (job.type === 'archive') return getInstallComponent('kiwix-tools')?.isInstalled() ?? true
  if (job.type === 'map')     return getInstallComponent('maps-toolchain')?.isInstalled() ?? true
  if (job.type === 'component') {
    // comfyui-nodes needs the base runtime to exist first.
    if (job.refId === 'comfyui-nodes') return getInstallComponent('comfyui-base')?.isInstalled() ?? false
    // Image-pipeline model files (refId = catalog model id) need ComfyUI installed.
    const m = CATALOG.find(x => x.id === job.refId)
    if (m && IMAGE_ROLES.has(m.role)) return getInstallComponent('comfyui-base')?.isInstalled() ?? false
  }
  return true
}

// Coalesce kiwix restarts across a bulk archive download. Start the server if it isn't
// serving yet (so finished archives are readable mid-batch), but once it's up just wait
// until no archive jobs remain, then restart ONCE — instead of bouncing it per archive
// (which made the reader hit "kiwix-serve unreachable").
async function maybeSyncKiwix(): Promise<void> {
  const remaining = await db.select().from(downloadJobs)
    .where(and(eq(downloadJobs.type, 'archive'), inArray(downloadJobs.status, ['pending', 'running'])))
  if (remaining.length > 0 && getKiwixState() === 'ready') return
  await syncKiwixWithArchives()
}

interface RunningMeta { ctrl: AbortController; domain: string; sizeClass: string; type: JobType }
const running = new Map<string, RunningMeta>()
// Last time each running job reported progress; the stall watchdog compares against STALL_TIMEOUT_MS.
const lastProgressAt = new Map<string, number>()
// Jobs the watchdog force-aborted (vs. a user cancel or shutdown) so startJob's catch resumes them.
const stalledJobs = new Set<string>()
let tickScheduled = false
let intervalStarted = false

function kickScheduler() { void tick() }

/** Periodic safety net so backoff-eligible retries resume even with no other activity. */
export function startDownloadScheduler() {
  if (intervalStarted) return
  intervalStarted = true
  let ticks = 0
  setInterval(async () => {
    checkStalledJobs()
    if (ticks++ % 12 === 0) await selfHealFailed()  // ~once a minute
    void tick()
  }, 5_000)
  void tick()
}

/** Revive setup/library downloads that exhausted their retry burst, once they've sat in 'failed'
 *  for SELF_HEAL_COOLDOWN_MS. This is what makes the queue self-healing: a Wikipedia/Stack Overflow
 *  mirror that was briefly unreachable gets picked back up automatically — the user never has to
 *  notice or click "Retry now". A genuinely dead source just keeps cycling quietly in the
 *  background (and the user can Dismiss it). updatedAt gates the cooldown, so each
 *  failed→pending→failed round waits another full cooldown rather than hammering the mirror. */
async function selfHealFailed(): Promise<void> {
  const cutoff = new Date(Date.now() - SELF_HEAL_COOLDOWN_MS)
  const stuck = await db.select({ label: downloadJobs.label }).from(downloadJobs)
    .where(and(eq(downloadJobs.status, 'failed'), inArray(downloadJobs.type, SELF_HEAL_TYPES), lte(downloadJobs.updatedAt, cutoff)))
  if (!stuck.length) return
  await db.update(downloadJobs)
    .set({ status: 'pending', attempts: 0, nextEligibleAt: null, lastError: null, updatedAt: new Date() })
    .where(and(eq(downloadJobs.status, 'failed'), inArray(downloadJobs.type, SELF_HEAL_TYPES), lte(downloadJobs.updatedAt, cutoff)))
  logger.info(`[jobs] ↻ self-heal revived ${stuck.length} stuck download(s): ${stuck.map((s) => s.label).join(', ')}`)
}

/** Abort running model/archive downloads that have gone silent past STALL_TIMEOUT_MS. The abort
 *  propagates to the fetch body read, so the job throws → requeues → resumes from its .part file,
 *  instead of sitting in 'running' forever. */
function checkStalledJobs(): void {
  const now = Date.now()
  for (const [id, meta] of running) {
    if (!STALL_WATCHED_TYPES.has(meta.type)) continue
    const last = lastProgressAt.get(id) ?? now
    if (now - last <= STALL_TIMEOUT_MS) continue
    stalledJobs.add(id)
    lastProgressAt.set(id, now)  // debounce so we don't re-abort every tick while the abort lands
    logger.warn(`[jobs] ⏱ stalled — no progress for ${Math.round((now - last) / 1000)}s, aborting to resume: ${id}`)
    meta.ctrl.abort()
  }
}

async function tick(): Promise<void> {
  if (tickScheduled) return
  tickScheduled = true
  try {
    if (await isDownloadBlocked()) return  // offline mode — pause
    // Re-entrancy guard via tickScheduled; loop until no more can start.
    for (;;) {
      if (running.size >= MAX_CONCURRENT) return
      const now = new Date()
      const candidates = await db.select().from(downloadJobs)
        .where(and(
          eq(downloadJobs.status, 'pending'),
          or(isNull(downloadJobs.nextEligibleAt), lte(downloadJobs.nextEligibleAt, now)),
        ))
        .orderBy(asc(downloadJobs.priority), asc(downloadJobs.createdAt))
      const largeRunning = [...running.values()].some((r) => r.sizeClass === 'large')
      const domainsRunning = new Set([...running.values()].map((r) => r.domain))
      const next = candidates.find((j) => {
        if (running.has(j.id)) return false
        // At most one "large" download at a time, globally: a large archive is now internally
        // parallel (aria2 saturates the link across mirrors), so running two would just split
        // bandwidth and finish nothing sooner.
        if (j.sizeClass === 'large' && largeRunning) return false
        if (!prereqMet(j)) return false
        // Per-domain serialization, EXCEPT small archive jobs — they're quick, the kiwix restart
        // is coalesced across the batch, and letting them run alongside the one large archive
        // gives the user fast wins instead of waiting behind an 80 GB download.
        const smallArchive = j.type === 'archive' && j.sizeClass === 'small'
        if (!smallArchive && domainsRunning.has(j.domain)) return false
        return true
      })
      if (!next) return
      void startJob(next)
      // Loop to try to fill another slot (its domain/large state is now reserved).
      // startJob registers into `running` synchronously before its first await.
    }
  } finally {
    tickScheduled = false
  }
}

async function startJob(job: typeof downloadJobs.$inferSelect): Promise<void> {
  const ctrl = new AbortController()
  running.set(job.id, { ctrl, domain: job.domain, sizeClass: job.sizeClass, type: job.type as JobType })
  lastProgressAt.set(job.id, Date.now())
  await db.update(downloadJobs).set({ status: 'running', updatedAt: new Date() }).where(eq(downloadJobs.id, job.id))
  logger.info(`[jobs] start ${job.type}:${job.refId} (${job.label})`)

  // Bytes already on disk when this attempt began (kiwix/HF resume from a .part file). Used
  // below to tell "stalled, no progress" (counts an attempt) from "advancing but the mirror
  // hiccupped" (resume, don't burn the attempt budget) for large resumable downloads.
  const startCompleted = (() => { try { return JSON.parse(job.progress ?? '{}').completed ?? 0 } catch { return 0 } })()
  let lastCompleted = startCompleted

  let lastWrite = 0
  const onProgress = (p: DownloadProgress & { note?: string }) => {
    lastCompleted = p.completed
    const t = Date.now()
    lastProgressAt.set(job.id, t)  // feed the stall watchdog on every report, before throttling
    if (t - lastWrite < PROGRESS_WRITE_MS && p.completed < p.total) return
    lastWrite = t
    // NOTE: must use .catch() (not `void`) — Drizzle queries are lazy and only execute
    // when awaited/then'd/caught. `void builder` never ran the query, so progress stayed
    // null and the widget showed "starting…" forever even while bytes were flowing.
    db.update(downloadJobs)
      .set({ progress: JSON.stringify({ completed: p.completed, total: p.total, speedBps: p.speedBps, etaSeconds: p.etaSeconds, note: (p as { note?: string }).note ?? p.status }), updatedAt: new Date() })
      .where(eq(downloadJobs.id, job.id))
      .catch(() => { /* progress write is best-effort */ })
  }

  try {
    await runJob(job, onProgress, ctrl.signal)
    await db.update(downloadJobs).set({ status: 'completed', lastError: null, updatedAt: new Date() }).where(eq(downloadJobs.id, job.id))
    logger.info(`[jobs] ✓ ${job.type}:${job.refId}`)
    if (job.type === 'archive') { try { await maybeSyncKiwix() } catch { /* best-effort */ } }
  } catch (err) {
    // Treat any error after an abort as a cancellation — not all runners reject with a
    // DOMException (yt-dlp/podcast reject with a plain Error('Aborted')), which previously
    // fell into the retry branch and re-spawned the very job the user cancelled.
    const aborted = ctrl.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')
    if (aborted && stalledJobs.has(job.id)) {
      // The watchdog force-aborted a hung download. Resume from the .part file after a short
      // backoff and DON'T spend the attempt budget — a resumable download that stalls but keeps
      // its bytes always converges once the mirror recovers. Guarded on status='running' so a
      // racing cancelJob is never resurrected.
      await db.update(downloadJobs).set({ status: 'pending', nextEligibleAt: new Date(Date.now() + BACKOFF_BASE_MS), lastError: 'Stalled (no progress) — resuming', updatedAt: new Date() })
        .where(and(eq(downloadJobs.id, job.id), eq(downloadJobs.status, 'running')))
      logger.warn(`[jobs] ↻ ${job.type}:${job.refId} resuming after stall`)
    } else if (aborted) {
      // Requeue a transient abort (shutdown), but only if still 'running' — never resurrect
      // a row cancelJob already flipped to 'cancelled' (else the scheduler re-runs it).
      await db.update(downloadJobs).set({ status: 'pending', updatedAt: new Date() })
        .where(and(eq(downloadJobs.id, job.id), eq(downloadJobs.status, 'running')))
    } else if (job.type === 'archive' && lastCompleted > startCompleted) {
      // The download advanced this attempt but the mirror stalled before finishing. It resumes
      // from the .part file, so keep retrying WITHOUT spending the attempt budget — a finite
      // file that gains bytes every attempt always converges. (A truly stuck download makes no
      // progress and falls through to the normal attempt-counting branch below, so it still
      // gives up.) This stops large ZIM downloads from "failing" with most of the file in hand.
      await db.update(downloadJobs).set({ status: 'pending', nextEligibleAt: new Date(Date.now() + BACKOFF_BASE_MS), lastError: String(err), updatedAt: new Date() })
        .where(and(eq(downloadJobs.id, job.id), eq(downloadJobs.status, 'running')))
      logger.warn(`[jobs] ↻ ${job.type}:${job.refId} stalled at ${lastCompleted} bytes — resuming (attempt not counted)`)
    } else {
      const attempts = job.attempts + 1
      // Guard on status='running' just like the abort branch above: if cancelJob flipped the
      // row to 'cancelled' while this runner was failing for an unrelated reason, never
      // resurrect it to 'pending'/'failed'.
      if (attempts < job.maxAttempts) {
        const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS)
        await db.update(downloadJobs).set({ status: 'pending', attempts, nextEligibleAt: new Date(Date.now() + delay), lastError: String(err), updatedAt: new Date() }).where(and(eq(downloadJobs.id, job.id), eq(downloadJobs.status, 'running')))
        logger.warn(`[jobs] ✗ ${job.type}:${job.refId} (attempt ${attempts}/${job.maxAttempts}) — retrying in ${Math.round(delay / 1000)}s: ${err}`)
      } else {
        await db.update(downloadJobs).set({ status: 'failed', attempts, lastError: String(err), updatedAt: new Date() }).where(and(eq(downloadJobs.id, job.id), eq(downloadJobs.status, 'running')))
        logger.error(`[jobs] ✗ ${job.type}:${job.refId} — gave up after ${attempts} attempts: ${err}`)
        // Propagate terminal failure to the shared media asset + every waiting ref, so a second
        // user who attached to this job doesn't sit on 'pending' forever.
        if (job.type === 'yt-media') {
          const { failAssetByJobRefId } = await import('@/lib/youtube/assets')
          await failAssetByJobRefId(job.refId, String(err)).catch(() => {})
        }
      }
    }
  } finally {
    running.delete(job.id)
    lastProgressAt.delete(job.id)
    stalledJobs.delete(job.id)
    void tick()  // fill the freed slot
  }
}

async function runJob(job: typeof downloadJobs.$inferSelect, onProgress: (p: DownloadProgress & { note?: string }) => void, signal: AbortSignal): Promise<void> {
  switch (job.type) {
    case 'model': {
      const m = CATALOG.find((x) => x.id === job.refId)
      if (!m) throw new Error(`Unknown model ${job.refId}`)
      if (m.backend === 'ollama' && m.ollamaTag) {
        await pullOllama(m.ollamaTag, onProgress, signal)
      } else if (m.backend === 'huggingface') {
        if (m.hf) await downloadHfFile(m.hf, onProgress, signal)
        if (m.hfFiles) {
          let accum = 0
          for (const f of m.hfFiles) {
            await downloadHfFile(f, (p) => onProgress({ ...p, completed: accum + p.completed, total: m.approxBytes }), signal)
            accum += f.approxBytes ?? 0
          }
        }
      }
      // Persist the chosen model for its role (mirrors setup.ts).
      const key = ROLE_SETTINGS_KEY[m.role]
      if (key) await setAppSetting(key, m.id)
      if (m.role === 'llm' || m.role === 'uncensored_llm') await setAppSetting('model', m.id)
      if ((m.role === 'llm' || m.role === 'uncensored_llm') && m.builtinVision) await setAppSetting('vision_model', m.id)
      return
    }
    case 'archive':
      // Defer the kiwix restart — maybeSyncKiwix() coalesces it across the batch.
      await downloadArchive(job.refId, job.variantKey ?? undefined, onProgress, signal, { restartAfter: false })
      return
    case 'map': {
      const mapPhaseLabel: Record<string, string> = {
        resolving: 'Resolving region…',
        downloading: 'Downloading map data…',
        building_streets: 'Building map tiles…',
        building_terrain: 'Building terrain…',
        building_landcover: 'Building landcover…',
        building_routing: 'Building routing graph…',
        building_geocoder: 'Indexing places…',
        ready: 'Ready',
        error: 'Error',
      }
      await buildRegion(job.refId, (e) => {
        // e.msg from makeLineThrottle is raw subprocess log output — use a clean phase label
        const note = mapPhaseLabel[e.phase] ?? e.phase
        onProgress({ completed: e.pct ?? 0, total: 100, speedBps: 0, etaSeconds: 0, note })
      }, signal)
      return
    }
    case 'component': {
      const comp = getInstallComponent(job.refId)
      if (!comp) throw new Error(`Unknown component ${job.refId}`)
      await comp.repair(onProgress, signal)
      await recordInstalled(job.refId)
      return
    }
    case 'storage-move': {
      const [fromRoot, toRoot] = job.refId.split('|')
      if (!fromRoot || !toRoot) throw new Error(`Invalid storage-move refId: ${job.refId}`)
      const { runStorageMove } = await import('@/lib/storage/migrate')
      await runStorageMove(fromRoot, toRoot, onProgress, signal)
      return
    }
    case 'yt-media': {
      const payload = JSON.parse(job.refId) as import('@/lib/youtube/download').YtMediaJobPayload
      const { runYtMediaJob } = await import('@/lib/youtube/download')
      await runYtMediaJob(payload, onProgress, signal)
      return
    }
    case 'yt-export': {
      const payload = JSON.parse(job.refId) as import('@/lib/youtube/download').YtExportJobPayload
      const { runYtExportJob } = await import('@/lib/youtube/download')
      await runYtExportJob(payload, onProgress, signal)
      return
    }
    case 'podcast-generate': {
      const { runPodcastGenerateJob } = await import('@/lib/podcast/generate')
      const payload = JSON.parse(job.refId)
      await runPodcastGenerateJob(payload, onProgress, signal)
      return
    }
    case 'bookmark-archive': {
      const { runArchiveArticleJob } = await import('@/lib/bookmarks/archive')
      await runArchiveArticleJob(job.refId, onProgress, signal)  // refId = bookmarks.id
      return
    }
    case 'bookmark-thumb': {
      const { runBookmarkThumbnailJob } = await import('@/lib/bookmarks/thumbnail')
      await runBookmarkThumbnailJob(job.refId, onProgress, signal)  // refId = bookmarks.id
      return
    }
  }
}

/** Enqueue an offline article archive for a bookmarks row. Idempotent per item id;
 *  a failed/cancelled prior job is reset to pending. domain='local' serializes fetches.
 *  Pass { force } for recurring auto-updates: a prior *completed* job is also reset so the
 *  page is re-fetched (without force, a one-shot archive never re-runs). A running job is
 *  never disturbed. */
export async function enqueueArchiveArticle(bookmarkId: string, label: string, opts: { force?: boolean } = {}): Promise<void> {
  const now = new Date()
  const existing = await db.select().from(downloadJobs)
    .where(and(eq(downloadJobs.type, 'bookmark-archive'), eq(downloadJobs.refId, bookmarkId)))
    .then((r) => r[0])
  if (existing) {
    const reset = existing.status === 'failed' || existing.status === 'cancelled' ||
      (opts.force && existing.status === 'completed')
    if (reset) {
      await db.update(downloadJobs)
        .set({ status: 'pending', attempts: 0, nextEligibleAt: null, lastError: null, updatedAt: now })
        .where(eq(downloadJobs.id, existing.id))
    }
  } else {
    await db.insert(downloadJobs).values({
      id: randomUUID(), type: 'bookmark-archive', refId: bookmarkId, variantKey: null,
      domain: 'local', sizeClass: 'small', label: label.slice(0, 120), priority: 50,
      status: 'pending', attempts: 0, maxAttempts: 4, nextEligibleAt: null, lastError: null,
      progress: null, createdAt: now, updatedAt: now,
    })
  }
  kickScheduler()
}

/** Enqueue a screenshot-thumbnail render for a bookmarks row (live bookmarks). Idempotent
 *  per item; a finished/failed prior job is reset so a re-request re-renders. */
export async function enqueueBookmarkThumbnail(bookmarkId: string, label: string): Promise<void> {
  const now = new Date()
  const existing = await db.select().from(downloadJobs)
    .where(and(eq(downloadJobs.type, 'bookmark-thumb'), eq(downloadJobs.refId, bookmarkId)))
    .then((r) => r[0])
  if (existing) {
    await db.update(downloadJobs)
      .set({ status: 'pending', attempts: 0, nextEligibleAt: null, lastError: null, updatedAt: now })
      .where(eq(downloadJobs.id, existing.id))
  } else {
    await db.insert(downloadJobs).values({
      id: randomUUID(), type: 'bookmark-thumb', refId: bookmarkId, variantKey: null,
      domain: 'local', sizeClass: 'small', label: label.slice(0, 120), priority: 40,
      status: 'pending', attempts: 0, maxAttempts: 2, nextEligibleAt: null, lastError: null,
      progress: null, createdAt: now, updatedAt: now,
    })
  }
  kickScheduler()
}

// ── Safetensors integrity scan ────────────────────────────────────────────────

/** Reset or insert a component download job, regardless of its current status.
 *  Used after deleting a corrupt file to guarantee a re-download is queued. */
async function forceRequeueComponent(componentId: string, label: string): Promise<void> {
  const now = new Date()
  // Derive domain + sizeClass from the catalog or fall back to sensible defaults.
  const m = CATALOG.find(x => x.id === componentId)
  const domain: Domain  = 'huggingface'
  const sizeClass       = m && m.approxBytes >= LARGE_THRESHOLD ? 'large' as const : 'small' as const
  const priority        = 30

  const existing = await db.select().from(downloadJobs)
    .where(and(eq(downloadJobs.type, 'component'), eq(downloadJobs.refId, componentId)))
    .then(r => r[0])

  if (existing) {
    await db.update(downloadJobs)
      .set({ status: 'pending', attempts: 0, nextEligibleAt: null, lastError: null, updatedAt: now })
      .where(eq(downloadJobs.id, existing.id))
  } else {
    await db.insert(downloadJobs).values({
      id: randomUUID(), type: 'component', refId: componentId, variantKey: null,
      domain, sizeClass, label, priority,
      status: 'pending', attempts: 0, maxAttempts: 6, nextEligibleAt: null, lastError: null,
      progress: null, createdAt: now, updatedAt: now,
    })
  }
}

/** Scan all installed .safetensors image-model files at boot.
 *  Validates each header + tensor-range; deletes and re-queues any corrupt file.
 *  Called before ComfyUI spawns so a bad model never causes a generation error. */
export async function scanAndRepairCorruptImageModels(): Promise<string[]> {
  const repaired: string[] = []

  // Collect candidate files: catalog IMAGE_ROLES models + SDXL VAE.
  type Candidate = { componentId: string; filePath: string; label: string }
  const candidates: Candidate[] = []

  for (const m of CATALOG) {
    if (!IMAGE_ROLES.has(m.role)) continue
    const dest = m.url?.dest ?? m.hf?.dest ?? m.hfFiles?.[0]?.dest
    if (!dest || !dest.endsWith('.safetensors')) continue
    const fullPath = join(dataDir, dest)
    if (!existsSync(fullPath)) continue
    candidates.push({ componentId: m.id, filePath: fullPath, label: m.label })
  }

  const vaePath = join(dataDir, SDXL_VAE_DEST)
  if (existsSync(vaePath)) {
    candidates.push({ componentId: 'sdxl-vae', filePath: vaePath, label: 'SDXL VAE (fp16-fix)' })
  }

  for (const { componentId, filePath, label } of candidates) {
    if (validateSafetensorsFile(filePath)) continue
    logger.warn(`[image] corrupt .safetensors file detected, removing and re-queuing: ${filePath}`)
    try { unlinkSync(filePath) } catch { /* already gone */ }
    repaired.push(label)
    try {
      await recordInstalled(componentId)  // ensure boot reconcile picks it up too
      await forceRequeueComponent(componentId, label)
    } catch (e) {
      logger.warn(`[image] failed to re-queue repair for ${componentId}: ${e}`)
    }
  }

  if (repaired.length) kickScheduler()
  return repaired
}

/** Force-queue a repair job for a specific image model component (exported so
 *  the status endpoint can queue a repair when it detects a missing/corrupt file
 *  without waiting for a generation attempt to fail first). */
export async function forceRequeueImageModel(componentId: string, label: string): Promise<void> {
  await recordInstalled(componentId)
  await forceRequeueComponent(componentId, label)
  kickScheduler()
}

/** Returns the first active (pending or running) repair job for an image model,
 *  or null if none. Used by /api/image/status to block generation while a
 *  model file is being re-downloaded after corruption detection. */
export async function getImageRepairJob(): Promise<{ label: string; pct: number | null } | null> {
  const imageComponentIds = [
    'sdxl-vae',
    ...CATALOG.filter(m => IMAGE_ROLES.has(m.role)).map(m => m.id),
  ]
  const row = await db.select({ label: downloadJobs.label, progress: downloadJobs.progress })
    .from(downloadJobs)
    .where(and(
      eq(downloadJobs.type, 'component'),
      inArray(downloadJobs.refId, imageComponentIds),
      inArray(downloadJobs.status, ['pending', 'running']),
    ))
    .orderBy(asc(downloadJobs.priority), asc(downloadJobs.createdAt))
    .limit(1)
    .then(r => r[0])
  if (!row) return null
  let pct: number | null = null
  try {
    const p = JSON.parse(row.progress ?? 'null') as { completed?: number; total?: number } | null
    if (p?.total && p.total > 0) pct = Math.round((p.completed ?? 0) / p.total * 100)
  } catch { /* ignore */ }
  return { label: row.label, pct }
}

// ── Boot resume + status + admin actions ─────────────────────────────────────────

/** On boot, requeue anything that was mid-flight when the process stopped. */
export async function resumeDownloadJobs(): Promise<void> {
  // Kill any orphaned map-build Java processes from the previous server instance.
  // Query BEFORE resetting so we know which regions need cleanup.
  const runningMaps = await db.select({ refId: downloadJobs.refId })
    .from(downloadJobs)
    .where(and(eq(downloadJobs.status, 'running'), eq(downloadJobs.type, 'map')))
  for (const { refId } of runningMaps) {
    killByCommandLine(refId)
  }

  await db.update(downloadJobs).set({ status: 'pending', updatedAt: new Date() }).where(eq(downloadJobs.status, 'running'))
  startDownloadScheduler()
}

// The status endpoint splits the queue into two user-facing tracks:
//   • "setup"   — runtimes + models + components the app needs to function (finishes in minutes)
//   • "content" — optional library content (ZIM archives, maps) that can be many GB and hours
// Framing a 140 GB library download as "Setting up your apps … 87%" made a perfectly usable app
// look broken for 12 hours; separating them lets setup finish fast and content download honestly
// (real GB / speed / ETA) without blocking anything.
// User-content jobs (podcast generation, YouTube media/export, storage moves) flow through the
// same queue but belong to neither track — a failed episode is not a broken install.
const SETUP_JOB_TYPES = new Set<JobType>(['model', 'component'])
const CONTENT_JOB_TYPES = new Set<JobType>(['archive', 'map'])

// A single corrupt progress blob must not 500 the whole status endpoint (which feeds the
// setup widget for every job at once): fall back to null for the bad row only.
function parseProgressBlob(blob: string | null): { completed?: number; total?: number; speedBps?: number; etaSeconds?: number; note?: string } | null {
  if (!blob) return null
  try { return JSON.parse(blob) } catch { return null }
}

type JobRow = typeof downloadJobs.$inferSelect

function summarize(rows: JobRow[]) {
  const counts = { total: rows.length, pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 }
  for (const r of rows) counts[r.status as keyof typeof counts]++
  const active = counts.total - counts.completed - counts.failed - counts.cancelled
  const pct = counts.total > 0 ? Math.round((counts.completed / counts.total) * 100) : 100

  // Byte-level aggregate (drives the honest "X GB of Y GB · Z MB/s · ~N min left" readout).
  // Only rows that have reported a real total contribute; pending rows of unknown size don't.
  let downloadedBytes = 0
  let totalBytes = 0
  let speedBps = 0
  for (const r of rows) {
    const p = parseProgressBlob(r.progress)
    if (p && typeof p.total === 'number' && p.total > 0) {
      totalBytes += p.total
      downloadedBytes += Math.min(p.completed ?? 0, p.total)
    }
    if (r.status === 'running' && typeof p?.speedBps === 'number') speedBps += p.speedBps
  }
  const etaSeconds = speedBps > 0 && totalBytes > downloadedBytes ? Math.round((totalBytes - downloadedBytes) / speedBps) : 0

  return {
    counts, pct, active, done: active === 0,
    downloadedBytes, totalBytes, speedBps, etaSeconds,
    jobs: rows.map((r) => ({
      id: r.id, type: r.type, refId: r.refId, label: r.label, domain: r.domain,
      sizeClass: r.sizeClass, status: r.status, attempts: r.attempts, lastError: r.lastError,
      progress: parseProgressBlob(r.progress),
    })),
  }
}

export async function getJobsStatus() {
  const allRows = await db.select().from(downloadJobs).orderBy(asc(downloadJobs.priority), asc(downloadJobs.createdAt))
  const setupRows = allRows.filter((r) => SETUP_JOB_TYPES.has(r.type as JobType))
  const contentRows = allRows.filter((r) => CONTENT_JOB_TYPES.has(r.type as JobType))

  const setup = summarize(setupRows)
  const content = summarize(contentRows)
  // Top-level fields stay = setup+content combined for backward-compatible consumers
  // (per-app "preparing" badges iterate `jobs`); the widget reads `setup` / `content`.
  const combined = summarize([...setupRows, ...contentRows])
  return { ...combined, setup, content }
}

export async function retryJob(id: string): Promise<void> {
  await db.update(downloadJobs).set({ status: 'pending', attempts: 0, nextEligibleAt: null, lastError: null, updatedAt: new Date() }).where(eq(downloadJobs.id, id))
  kickScheduler()
}

export async function cancelJob(id: string): Promise<void> {
  // Mark cancelled BEFORE aborting so the runner's abort handler (which requeues only
  // while status='running') can't race this write and resurrect the job to 'pending'.
  const [job] = await db.select({ type: downloadJobs.type, refId: downloadJobs.refId }).from(downloadJobs).where(eq(downloadJobs.id, id)).limit(1)
  await db.update(downloadJobs).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(downloadJobs.id, id))
  running.get(id)?.ctrl.abort()
  // A cancelled shared media job would otherwise leave its waiting refs stuck on 'pending'.
  if (job?.type === 'yt-media') {
    const { failAssetByJobRefId } = await import('@/lib/youtube/assets')
    await failAssetByJobRefId(job.refId, 'cancelled').catch(() => {})
  }
}

export async function retryAllFailed(): Promise<void> {
  await db.update(downloadJobs).set({ status: 'pending', attempts: 0, nextEligibleAt: null, lastError: null, updatedAt: new Date() }).where(inArray(downloadJobs.status, ['failed', 'cancelled']))
  kickScheduler()
}

/** User explicitly gave up on the stuck downloads: mark every failed job cancelled so the widget
 *  closes and self-heal won't revive them. (They can still be re-queued later from Admin.) */
export async function dismissAllFailed(): Promise<void> {
  await db.update(downloadJobs).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(downloadJobs.status, 'failed'))
}
