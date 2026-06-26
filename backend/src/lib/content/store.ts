// App-wide content-addressable blob store (Layer 1).
//
// Anything byte-identical collapses to a single file on disk, keyed by sha256(bytes),
// regardless of which app/user/source produced it. Blobs live UNDER the user data root
// (so an admin storage-move carries them, and resolveUserPath() gives path-containment),
// at `<root>/content/blobs/{ab}/{cd}/{hash}`.
//
// Lifecycle: a freshly-written blob is `staging` and is invisible to GC until a referrer
// (a media_assets row, today) flips it to `live` in the same critical section that pins it.
// This closes the "GC deletes a just-written, not-yet-referenced blob" race. Physical
// deletion happens ONLY in gcSweep(), never inline at a delete site.
//
// Reference counting is DERIVED, never a trusted counter: a media blob is pinned iff a
// media_assets row points at its hash. Deriving avoids drift across our inline-migration
// boundary (there is no framework to recompute a stored counter).

import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { mkdir, rename, cp, rm, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { and, eq, lt, notExists } from 'drizzle-orm'
import { db } from '@/db'
import { blobs, mediaAssets, ytDownloads } from '@/db/schema'
import { resolveUserPath, toRelativePath } from '@/lib/storage/paths'
import { logger } from '@/lib/logger'

// ── Keyed async mutex ───────────────────────────────────────────────────────────
// Single process, single SQLite writer — but `await` points between a read and a
// dependent write still let two requests interleave. withLock() serializes the
// save-decision / asset-swap / release critical sections per asset so the
// refcount/height invariants hold. Keep callbacks short (no network/yt-dlp inside).

const _locks = new Map<string, Promise<unknown>>()
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = _locks.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)           // run after prev settles, success or failure
  const tail = run.catch(() => {})        // error-swallowing tail others chain behind
  _locks.set(key, tail)
  void tail.then(() => { if (_locks.get(key) === tail) _locks.delete(key) })
  return run
}

// ── In-flight read tracking (for GC safety) ─────────────────────────────────────
// A blob being streamed must not be physically deleted out from under an open fd that a
// player re-issues range requests against. Serve paths bracket their streams with these.

const _inFlight = new Map<string, number>()
export function acquireRead(hash: string): void {
  _inFlight.set(hash, (_inFlight.get(hash) ?? 0) + 1)
}
export function releaseRead(hash: string): void {
  const n = (_inFlight.get(hash) ?? 0) - 1
  if (n <= 0) _inFlight.delete(hash)
  else _inFlight.set(hash, n)
}
function inFlightReads(hash: string): number { return _inFlight.get(hash) ?? 0 }

// ── Paths ───────────────────────────────────────────────────────────────────────

/** Relative (DB-stored) path for a blob, sharded two levels to avoid huge directories. */
function blobRelPath(hash: string): string {
  return join('content', 'blobs', hash.slice(0, 2), hash.slice(2, 4), hash)
}

/** Absolute path to a blob's bytes under the current data root. */
export function blobAbsPath(hash: string): Promise<string> {
  return resolveUserPath(blobRelPath(hash))
}

/** A scratch path under the data root for a worker to download into before putBlobFromFile.
 *  Same filesystem as the blob store, so the subsequent move is a cheap rename. */
export async function contentTmpDir(): Promise<string> {
  const dir = await resolveUserPath(join('content', 'tmp'))
  await mkdir(dir, { recursive: true })
  return dir
}

// ── Hashing ─────────────────────────────────────────────────────────────────────

export function hashFile(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(absPath)
    s.on('error', reject)
    s.on('data', (d) => h.update(d as Buffer))
    s.on('end', () => resolve(h.digest('hex')))
  })
}

// ── Put ─────────────────────────────────────────────────────────────────────────

export interface PutResult { hash: string; sizeBytes: number; deduped: boolean }

/** Bring a finished file into the blob store as `staging`, deduping on content hash. By default
 *  the source is CONSUMED (moved, or deleted on a dedup hit). Pass `keepSource` to copy instead
 *  — used by the background migration so a crash mid-run leaves the original intact for dual-read.
 *  Caller must flip the blob to `live` via markBlobLive() inside the same critical section that
 *  creates the referrer. */
export async function putBlobFromFile(absPath: string, opts: { mime?: string | null; keepSource?: boolean } = {}): Promise<PutResult> {
  const hash = await hashFile(absPath)
  const [existing] = await db.select({ sizeBytes: blobs.sizeBytes }).from(blobs).where(eq(blobs.hash, hash)).limit(1)
  if (existing) {
    // Identical bytes already stored — drop the incoming copy (unless asked to keep it).
    if (!opts.keepSource) { try { await unlink(absPath) } catch { /* best-effort */ } }
    return { hash, sizeBytes: existing.sizeBytes, deduped: true }
  }

  const dest = await blobAbsPath(hash)
  await mkdir(dirname(dest), { recursive: true })
  if (opts.keepSource) {
    await cp(absPath, dest, { preserveTimestamps: true })
  } else {
    try {
      await rename(absPath, dest)
    } catch (err) {
      // Cross-device (data root on a network share / external drive): rename throws EXDEV —
      // fall back to copy-then-unlink, mirroring lib/storage/migrate.ts.
      if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
        await cp(absPath, dest, { preserveTimestamps: true })
        await rm(absPath, { force: true })
      } else throw err
    }
  }

  const sizeBytes = statSync(dest).size
  const now = new Date()
  await db.insert(blobs).values({
    hash, relPath: await toRelativePath(dest), sizeBytes, mime: opts.mime ?? null,
    status: 'staging', lastAccessedAt: now, createdAt: now,
  }).onConflictDoNothing()
  return { hash, sizeBytes, deduped: false }
}

/** Flip a blob to `live` (GC-eligible referrer now committed). */
export async function markBlobLive(hash: string): Promise<void> {
  await db.update(blobs).set({ status: 'live' }).where(eq(blobs.hash, hash))
}

/** Bump a blob's last-access time (used for cache-class LRU; cheap, best-effort). */
export async function touchBlob(hash: string): Promise<void> {
  await db.update(blobs).set({ lastAccessedAt: new Date() }).where(eq(blobs.hash, hash)).catch(() => {})
}

// ── Garbage collection ────────────────────────────────────────────────────────────

/** Delete blob FILES that are `live`, unreferenced, not being streamed, and past a short
 *  settle window. The settle window is a second belt against a blob written (staging→live)
 *  but whose referrer transaction hasn't landed yet. Unlink first, then drop the row; on a
 *  failed unlink (open handle on a network root) keep the row and retry next sweep. */
const GC_SETTLE_MS = 60_000

export async function gcSweep(): Promise<{ removed: number; bytes: number; assets: number }> {
  const cutoff = new Date(Date.now() - GC_SETTLE_MS)

  // Step 1: drop orphaned assets — a media_assets row that no yt_downloads row references
  // anymore. This is what reclaims space when refs disappear via a path that bypasses the
  // explicit release helper, most importantly a user deletion (FK ON DELETE CASCADE drops the
  // user's refs directly). The settle window protects the brief create-time window where an
  // asset exists before its first ref is inserted (both happen together under withLock).
  const orphanAssets = await db.delete(mediaAssets).where(and(
    lt(mediaAssets.createdAt, cutoff),
    notExists(db.select().from(ytDownloads).where(eq(ytDownloads.assetId, mediaAssets.id))),
  )).returning({ id: mediaAssets.id })

  // Step 2: delete blob FILES now unreferenced (any orphan assets above just released theirs).
  // Unreferenced = no media_assets row points at the hash. (Future cache-class blobs with
  // their own pin rows extend this predicate.)
  const candidates = await db.select({ hash: blobs.hash, relPath: blobs.relPath, sizeBytes: blobs.sizeBytes })
    .from(blobs)
    .where(and(
      eq(blobs.status, 'live'),
      lt(blobs.createdAt, cutoff),
      notExists(db.select().from(mediaAssets).where(eq(mediaAssets.blobHash, blobs.hash))),
    ))

  let removed = 0, bytes = 0
  for (const b of candidates) {
    if (inFlightReads(b.hash) > 0) continue   // being streamed — skip, reclaim next sweep
    const abs = await resolveUserPath(b.relPath)
    try {
      await unlink(abs)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        // e.g. EBUSY on an open handle (Windows/SMB) — leave the row, retry next sweep.
        continue
      }
      // ENOENT: file already gone, fall through to drop the row.
    }
    await db.delete(blobs).where(eq(blobs.hash, b.hash))
    removed++; bytes += b.sizeBytes ?? 0
  }
  if (removed || orphanAssets.length) {
    logger.info(`[content] gc reclaimed ${removed} blob(s) (${(bytes / 1e6).toFixed(1)} MB), ${orphanAssets.length} orphan asset(s)`)
  }
  return { removed, bytes, assets: orphanAssets.length }
}

let _gcTimer: ReturnType<typeof setInterval> | null = null
/** Start the periodic GC sweep (idempotent). */
export function startContentGc(): void {
  if (_gcTimer) return
  setTimeout(() => void gcSweep().catch(() => {}), 60_000)
  _gcTimer = setInterval(() => void gcSweep().catch(() => {}), 30 * 60_000)
}
