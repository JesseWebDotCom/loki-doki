// Transcode cache store — the state machine behind on-demand media compatibility.
//
// ensureCompat(path) probes a stored file and either declares it browser-safe (no row,
// no disk cost) or creates a cache entry + queues a lazy transcode. Nothing is ever
// converted up front: a file only costs CPU/disk the first time someone actually plays
// it. Outputs live in data/cache/transcode/ and are bounded two ways, mirroring
// lib/imageProxy: a size-capped LRU (evict least-recently-served first) and an
// age-retention sweep, both run from the shared guardedSweep scheduler in index.ts.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { and, eq, like } from 'drizzle-orm'
import { db } from '@/db'
import { mediaCompatCache } from '@/db/schema'
import { dataDir } from '@/lib/download'
import { getAppSetting } from '@/lib/settings'
import { logger } from '@/lib/logger'
import { probeCompat, decideCompat, type CompatProbe, type CompatVerdict, type MediaKind } from './probe'

export const TRANSCODE_CACHE_DIR = join(dataDir, 'cache', 'transcode')

export type CompatVariant = 'video' | 'audio'
export type CompatRow = typeof mediaCompatCache.$inferSelect

export interface EnsureResult {
  /** True when the ORIGINAL file plays in every target browser — use the normal URL. */
  compatible: boolean
  kind: MediaKind
  /** Present when a transcode is needed (row created / reused). */
  id?: string
  status?: 'pending' | 'running' | 'ready' | 'failed'
  progressPct?: number | null
  error?: string | null
  reasons?: string[]
}

// ── Config (appSettings override → env → default, filetube-style precedence) ────

const GB = 1024 * 1024 * 1024

async function settingNumber(key: string, envName: string, fallback: number, min: number, max: number): Promise<number> {
  const fromSetting = await getAppSetting(key).catch(() => null)
  const fromEnv = process.env[envName]
  for (const raw of [fromSetting, fromEnv]) {
    const n = typeof raw === 'number' ? raw : raw != null ? Number(raw) : NaN
    if (Number.isFinite(n) && n >= min && n <= max) return n
  }
  return fallback
}

export const getCacheMaxBytes = () => settingNumber('transcode.cache_max_bytes', 'TRANSCODE_CACHE_MAX_BYTES', 5 * GB, 100 * 1024 * 1024, 1000 * GB)
/** 0 disables age-based retention (size cap still applies as the hard backstop). */
export const getCacheMaxAgeDays = () => settingNumber('transcode.cache_max_age_days', 'TRANSCODE_CACHE_MAX_AGE_DAYS', 30, 0, 3650)
export const getTranscodeCrf = () => settingNumber('transcode.crf', 'TRANSCODE_CRF', 23, 1, 51)

// ── Keys and paths ──────────────────────────────────────────────────────────────

/** Identity of a (file contents, variant) pair: path + mtime + size. A re-encoded or
 *  replaced source file gets a fresh key; the stale entry is dropped on ensure/sweep. */
function srcKey(absPath: string, mtimeMs: number, sizeBytes: number): string {
  return createHash('sha256').update(`${absPath}|${Math.round(mtimeMs)}|${sizeBytes}`).digest('hex').slice(0, 32)
}

export function entryOutPath(row: Pick<CompatRow, 'id' | 'outExt'>): string {
  return join(TRANSCODE_CACHE_DIR, `${row.id}.${row.outExt}`)
}

export async function getEntry(id: string): Promise<CompatRow | null> {
  const [row] = await db.select().from(mediaCompatCache).where(eq(mediaCompatCache.id, id)).limit(1)
  return row ?? null
}

// Probe results are tiny and probing costs a process spawn — cache per srcKey for the
// life of the process (a changed file changes its srcKey, so staleness self-resolves).
const probeMemo = new Map<string, Promise<CompatProbe>>()

async function probeCached(absPath: string, key: string): Promise<CompatProbe> {
  const hit = probeMemo.get(key)
  if (hit) return hit
  const p = (async () => {
    // A prior row for this same file already carries the probe — reuse across restarts.
    const [row] = await db.select().from(mediaCompatCache).where(like(mediaCompatCache.id, `${key}-%`)).limit(1)
    if (row?.probeJson) { try { return JSON.parse(row.probeJson) as CompatProbe } catch { /* fall through */ } }
    return probeCompat(absPath)
  })()
  probeMemo.set(key, p)
  p.catch(() => probeMemo.delete(key))
  return p
}

// ── Ensure ──────────────────────────────────────────────────────────────────────

/**
 * Probe a stored media file and, when it can't play natively, get-or-create the cache
 * entry for its browser-safe rendition (queueing the transcode job on first demand).
 *
 * `want`:
 *  - 'auto'  — a playable rendition of the file as-is (video stays video).
 *  - 'audio' — an audio-only rendition, used for lock-screen/background continuation of
 *              a video. For an audio file this behaves like 'auto'.
 */
export async function ensureCompat(absPath: string, want: 'auto' | 'audio' = 'auto', opts?: { priority?: number }): Promise<EnsureResult> {
  const st = await stat(absPath)   // throws → caller's 404
  const key = srcKey(absPath, st.mtimeMs, st.size)
  const probe = await probeCached(absPath, key)
  const verdict: CompatVerdict = decideCompat(probe)

  const wantAudioOnly = want === 'audio' && verdict.kind === 'video'
  if (!wantAudioOnly && verdict.compatible) return { compatible: true, kind: verdict.kind }

  const variant: CompatVariant = wantAudioOnly ? 'audio' : verdict.kind
  const id = `${key}-${variant}`
  const existing = await getEntry(id)
  if (existing) {
    if (existing.status === 'ready' && !existsSync(entryOutPath(existing))) {
      // Swept or lost the output — fall through to requeue below.
      await db.delete(mediaCompatCache).where(eq(mediaCompatCache.id, id))
    } else {
      return { compatible: false, kind: verdict.kind, id, status: existing.status as EnsureResult['status'], progressPct: existing.progressPct, error: existing.error, reasons: verdict.reasons }
    }
  }

  // The file changed on disk: drop entries (and outputs) minted from its older bytes.
  const stale = await db.select().from(mediaCompatCache)
    .where(and(eq(mediaCompatCache.srcPath, absPath), eq(mediaCompatCache.variant, variant)))
  for (const row of stale) {
    await rm(entryOutPath(row), { force: true }).catch(() => {})
    await db.delete(mediaCompatCache).where(eq(mediaCompatCache.id, row.id))
  }

  const now = new Date()
  const outExt = variant === 'audio' ? 'm4a' : 'mp4'
  await db.insert(mediaCompatCache).values({
    id, srcPath: absPath, variant, status: 'pending', probeJson: JSON.stringify(probe),
    outExt, progressPct: 0, sizeBytes: null, error: null, createdAt: now, updatedAt: now, lastServedAt: null,
  }).onConflictDoNothing()

  const { enqueueMediaCompat } = await import('@/lib/downloadJobs')
  await enqueueMediaCompat(id, transcodeLabel(absPath, variant), { priority: opts?.priority })
  return { compatible: false, kind: verdict.kind, id, status: 'pending', progressPct: 0, reasons: verdict.reasons }
}

/**
 * Ingest-time hook: probe a freshly stored file and, when it can't play natively, park
 * its transcode in the opportunistic band so it renders during an idle moment instead
 * of on first tap (where iOS waits through the whole encode). A later real play
 * escalates the same job to user priority via enqueueMediaCompat's coalescing.
 * Best-effort by contract: never throws, does nothing when the admin switch is off.
 */
export async function precomputeCompat(absPath: string, want: 'auto' | 'audio' = 'auto'): Promise<void> {
  const { isOpportunisticEnabled, OPPORTUNISTIC_PRIORITY } = await import('@/lib/idleScheduler')
  if (!isOpportunisticEnabled()) return
  try {
    await ensureCompat(absPath, want, { priority: OPPORTUNISTIC_PRIORITY })
  } catch (err) {
    logger.warn(`[transcode-cache] ingest precompute skipped for ${absPath}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** JSON shape every per-route compat endpoint returns — players share one client for it. */
export function compatPayload(r: EnsureResult): Record<string, unknown> {
  if (r.compatible) return { compatible: true, kind: r.kind }
  return {
    compatible: false,
    kind: r.kind,
    id: r.id,
    status: r.status,
    progressPct: r.progressPct ?? null,
    error: r.error ?? null,
    reasons: r.reasons ?? [],
    streamUrl: `/api/compat/stream/${r.id}`,
    liveUrl: `/api/compat/live/${r.id}`,
  }
}

function transcodeLabel(absPath: string, variant: CompatVariant): string {
  const base = absPath.split(/[\\/]/).pop() ?? absPath
  return variant === 'audio' ? `Audio track: ${base}` : `Make playable: ${base}`
}

/** Re-queue a failed entry (user-visible "Retry"). */
export async function retryEntry(id: string): Promise<boolean> {
  const row = await getEntry(id)
  if (!row || row.status !== 'failed') return false
  await db.update(mediaCompatCache).set({ status: 'pending', error: null, progressPct: 0, updatedAt: new Date() }).where(eq(mediaCompatCache.id, id))
  const { enqueueMediaCompat } = await import('@/lib/downloadJobs')
  await enqueueMediaCompat(id, transcodeLabel(row.srcPath, row.variant as CompatVariant))
  return true
}

// ── Serve bookkeeping ───────────────────────────────────────────────────────────

// lastServedAt drives LRU eviction; a write per Range request would be pure churn, so
// throttle to one write per entry per minute (same reasoning as blobs.touchBlob).
const lastTouch = new Map<string, number>()

export function touchServed(id: string): void {
  const now = Date.now()
  if ((lastTouch.get(id) ?? 0) > now - 60_000) return
  lastTouch.set(id, now)
  db.update(mediaCompatCache).set({ lastServedAt: new Date() }).where(eq(mediaCompatCache.id, id)).catch(() => {})
}

// ── Sweep (registered via guardedSweep in index.ts) ─────────────────────────────

const FAILED_ROW_TTL_MS = 24 * 3600_000
const TMP_MAX_AGE_MS = 6 * 3600_000

export async function transcodeCacheSweep(): Promise<void> {
  await mkdir(TRANSCODE_CACHE_DIR, { recursive: true }).catch(() => {})
  const rows = await db.select().from(mediaCompatCache)
  const now = Date.now()
  const byFile = new Map<string, CompatRow>()
  const dropped = new Set<string>()

  const drop = async (row: CompatRow, why: string) => {
    await rm(entryOutPath(row), { force: true }).catch(() => {})
    await db.delete(mediaCompatCache).where(eq(mediaCompatCache.id, row.id))
    dropped.add(row.id)
    logger.info(`[transcode-cache] evicted ${row.id} (${why})`)
  }

  const maxAgeDays = await getCacheMaxAgeDays()
  for (const row of rows) {
    byFile.set(`${row.id}.${row.outExt}`, row)
    // Failed rows: keep briefly so the UI can show the error + offer retry, then forget.
    if (row.status === 'failed' && now - row.updatedAt.getTime() > FAILED_ROW_TTL_MS) { await drop(row, 'failed, stale'); continue }
    // Source file gone → rendition is orphaned.
    if (row.status === 'ready' && !existsSync(row.srcPath)) { await drop(row, 'source removed'); continue }
    // Age retention: not served within the window.
    if (row.status === 'ready' && maxAgeDays > 0) {
      const last = (row.lastServedAt ?? row.createdAt).getTime()
      if (now - last > maxAgeDays * 24 * 3600_000) { await drop(row, `unwatched ${maxAgeDays}d`) ; continue }
    }
  }

  // Size cap — the hard backstop regardless of age settings. Evict least-recently-served.
  const maxBytes = await getCacheMaxBytes()
  const ready = rows.filter((r) => r.status === 'ready' && !dropped.has(r.id))
    .sort((a, b) => (a.lastServedAt ?? a.createdAt).getTime() - (b.lastServedAt ?? b.createdAt).getTime())
  let total = ready.reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0)
  for (const row of ready) {
    if (total <= maxBytes) break
    total -= row.sizeBytes ?? 0
    await drop(row, 'size cap')
  }

  // Disk hygiene: stale .tmp partials and files with no surviving row.
  const names = await readdir(TRANSCODE_CACHE_DIR).catch(() => [] as string[])
  for (const name of names) {
    const full = join(TRANSCODE_CACHE_DIR, name)
    if (name.endsWith('.tmp')) {
      const s = await stat(full).catch(() => null)
      if (s && now - s.mtimeMs > TMP_MAX_AGE_MS) await rm(full, { force: true }).catch(() => {})
      continue
    }
    const row = byFile.get(name)
    if (!row || dropped.has(row.id)) await rm(full, { force: true }).catch(() => {})
  }
}
