import { and, eq } from 'drizzle-orm'
import { existsSync, statSync, createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { db } from '@/db'
import { zimArchives, downloadJobs } from '@/db/schema'
import { ZIM_CATALOG } from '@/lib/zimCatalog'
import { kiwixZimDir, getZimBookName, restartKiwix, validateZimWindows } from '@/lib/kiwix'
import { IS_WIN } from '@/lib/platform'

const BACKEND_DIR = join(import.meta.dir, '../..')

/**
 * Validate a downloaded ZIM by opening it in an ISOLATED child process. libzim crashes
 * the whole process (native C++ exception, uncatchable in JS) on a corrupt archive — so we
 * must never open an unvalidated file in the backend or zim-server. A non-zero exit means
 * the archive is bad. On Windows (no libzim) we validate with kiwix-manage instead.
 */
export function validateZimFile(path: string): Promise<boolean> {
  if (IS_WIN) return validateZimWindows(path)
  return new Promise((resolve) => {
    const script = `const { Archive } = await import('@openzim/libzim'); const a = new Archive(${JSON.stringify(path)}); a.getMetadata('Name'); void a.allEntryCount;`
    const child = spawn('bun', ['-e', script], { cwd: BACKEND_DIR, stdio: 'ignore', timeout: 30_000 })
    child.on('exit', (code) => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
}

export interface ArchiveProgress {
  completed: number
  total: number
  speedBps: number
  etaSeconds: number
  note?: string   // human status while no bytes are flowing (resolving / starting server)
}

export type ArchiveProgressFn = (p: ArchiveProgress) => void | Promise<void>

/**
 * Download one ZIM archive end-to-end: resolve the latest file from the Kiwix
 * directory, download it (resumable), upsert the DB record, restart the ZIM server,
 * and read the book-name metadata. Shared by the admin SSE route and the background
 * download-job manager so the logic lives in exactly one place.
 */
export async function downloadArchive(
  sourceId: string,
  variantKeyArg: string | undefined,
  onProgress: ArchiveProgressFn,
  signal: AbortSignal,
  opts: { restartAfter?: boolean } = {},
): Promise<{ kiwixBookName: string; filePath: string }> {
  // restartAfter=false lets the background job manager coalesce kiwix restarts across a
  // bulk download (one restart at the end) instead of bouncing the server per archive —
  // which was making the reader hit "kiwix-serve unreachable" mid-batch.
  const restartAfter = opts.restartAfter !== false
  const source = ZIM_CATALOG.find((s) => s.sourceId === sourceId)
  if (!source) throw new Error('Unknown source')
  const variantKey = variantKeyArg ?? source.defaultVariant
  const variant = source.variants.find((v) => v.key === variantKey)
  if (!variant) throw new Error('Unknown variant')

  const note = async (msg: string) => onProgress({ completed: 0, total: 0, speedBps: 0, etaSeconds: 0, note: msg })

  // ── 1. Resolve latest ZIM filename from the Kiwix download directory ───────────
  await note('Resolving latest ZIM from Kiwix download server…')
  const kiwixName = variant.kiwixName
  const kiwixDir = source.kiwixDir
  const dirRes = await fetch(`https://download.kiwix.org/zim/${kiwixDir}/`, {
    headers: { 'User-Agent': 'loki-doki/1.0' },
    signal: AbortSignal.timeout(45_000),
  })
  if (!dirRes.ok) throw new Error(`Download directory returned ${dirRes.status}`)
  const dirHtml = await dirRes.text()

  const escaped = kiwixName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const fileRegex = new RegExp(`href="(${escaped}_\\d{4}-\\d{2}\\.zim)"`, 'gi')
  const fileNames = [...dirHtml.matchAll(fileRegex)].map((m) => m[1])
  if (fileNames.length === 0) throw new Error(`No ZIM file found for '${kiwixName}' in download directory`)

  const zimFileName = fileNames[fileNames.length - 1]
  const downloadUrl = `https://download.kiwix.org/zim/${kiwixDir}/${zimFileName}`
  const zimDate = zimFileName.match(/_(\d{4}-\d{2})\.zim$/)?.[1] ?? null

  // ── 2. Download (resumable) ────────────────────────────────────────────────────
  const destDir = join(kiwixZimDir, sourceId)
  const destPath = join(destDir, zimFileName)
  const partPath = destPath + '.part'
  await mkdir(destDir, { recursive: true })

  let didValidate = false
  if (!existsSync(destPath)) {
    let resumeFrom = 0
    try { resumeFrom = statSync(partPath).size } catch { /* no partial */ }
    const headers: Record<string, string> = { 'User-Agent': 'loki-doki/1.0' }
    if (resumeFrom > 0) headers['Range'] = `bytes=${resumeFrom}-`

    await note(`Downloading ${zimFileName}…`)
    const dlRes = await fetch(downloadUrl, { signal, headers })
    if (!dlRes.ok && dlRes.status !== 206) throw new Error(`Download failed: ${dlRes.status}`)
    if (!dlRes.body) throw new Error('No response body')

    const isPartial = dlRes.status === 206
    const contentLen = parseInt(dlRes.headers.get('content-length') ?? '0', 10)
    const total = isPartial ? resumeFrom + contentLen : contentLen
    const reader = dlRes.body.getReader()
    const fileStream = createWriteStream(partPath, { flags: isPartial ? 'a' : 'w' })

    let completed = isPartial ? resumeFrom : 0
    let lastTime = Date.now()
    let lastBytes = completed
    let lastEmit = 0

    while (true) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      fileStream.write(value)
      completed += value.length
      const now = Date.now()
      if (now - lastEmit >= 500 || completed >= total) {
        const elapsed = (now - lastTime) / 1000
        const speedBps = elapsed > 0 ? (completed - lastBytes) / elapsed : 0
        const etaSeconds = speedBps > 0 ? (total - completed) / speedBps : 0
        await onProgress({ completed, total, speedBps, etaSeconds })
        lastTime = now; lastBytes = completed; lastEmit = now
      }
    }
    await new Promise<void>((res, rej) => fileStream.end((err?: Error | null) => (err ? rej(err) : res())))
    await rename(partPath, destPath)

    // ── 2b. Validate (isolated) — a corrupt archive crashes libzim natively, which would
    // take down the whole ZIM server. Reject it here so the job retries instead.
    await note('Verifying archive…')
    if (!(await validateZimFile(destPath))) {
      await rm(destPath, { force: true }).catch(() => {})
      throw new Error('Downloaded archive is corrupt (failed to open) — will retry')
    }
    didValidate = true
  }

  // ── 3. Upsert DB record ─────────────────────────────────────────────────────────
  const now = new Date()
  const sizeBytes = existsSync(destPath) ? statSync(destPath).size : variant.approxBytes
  const existing = await db.select().from(zimArchives).where(eq(zimArchives.sourceId, sourceId)).then((r) => r[0])
  // We only just validated when we actually downloaded; a pre-existing file is left for the
  // boot quarantine sweep to verify.
  const verifiedAt = didValidate ? now : undefined
  if (existing) {
    await db.update(zimArchives)
      .set({ variantKey, kiwixBookName: kiwixName, filePath: destPath, fileSizeBytes: sizeBytes, zimDate, downloadedAt: now, updatedAt: now, ...(verifiedAt ? { verifiedAt } : {}) })
      .where(eq(zimArchives.sourceId, sourceId))
  } else {
    await db.insert(zimArchives).values({
      id: randomUUID(), sourceId, variantKey, kiwixBookName: kiwixName, filePath: destPath,
      fileSizeBytes: sizeBytes, zimDate, downloadedAt: now, verifiedAt: verifiedAt ?? null, createdAt: now, updatedAt: now,
    })
  }

  // ── 4. Restart ZIM server + read metadata — only when not deferring to the manager.
  if (!restartAfter) return { kiwixBookName: kiwixName, filePath: destPath }

  await note('Starting ZIM server…')
  const allRows = await db.select().from(zimArchives)
  const zimPaths = allRows.map((r) => r.filePath).filter(Boolean) as string[]
  await restartKiwix(zimPaths)

  // ── 5. Read book-name metadata from the running server ───────────────────────────
  await note('Reading ZIM metadata…')
  const kiwixBookName = (await getZimBookName(destPath)) ?? kiwixName
  if (kiwixBookName !== kiwixName) {
    await db.update(zimArchives).set({ kiwixBookName, updatedAt: new Date() }).where(eq(zimArchives.sourceId, sourceId))
  }

  return { kiwixBookName, filePath: destPath }
}

// Re-queue an archive's download (the scheduler's periodic tick picks it up). Direct DB
// update to avoid a circular import on the downloadJobs module.
async function requeueArchiveDownload(sourceId: string): Promise<void> {
  await db.update(downloadJobs)
    .set({ status: 'pending', attempts: 0, nextEligibleAt: null, lastError: null, updatedAt: new Date() })
    .where(and(eq(downloadJobs.type, 'archive'), eq(downloadJobs.refId, sourceId)))
    .catch(() => {})
}

/**
 * Detect & quarantine corrupt archives, returning the paths safe to serve. A corrupt ZIM
 * crashes libzim natively and would take down the whole ZIM server, so we validate each in
 * an isolated child process. Already-verified files (verifiedAt set + still present) are
 * trusted and skipped, so this is cheap on a warm boot. Bad/missing files are deleted, their
 * DB row dropped, and their download re-queued. Safe to call before every (re)spawn.
 */
export async function listHealthyArchivePaths(): Promise<{ valid: string[]; quarantined: string[] }> {
  const rows = await db.select().from(zimArchives)
  const valid: string[] = []
  const quarantined: string[] = []
  let idx = 0
  const worker = async () => {
    while (idx < rows.length) {
      const row = rows[idx++]
      if (!row.filePath) continue
      if (row.verifiedAt && existsSync(row.filePath)) { valid.push(row.filePath); continue }  // trusted
      if (!existsSync(row.filePath) || !(await validateZimFile(row.filePath))) {
        if (existsSync(row.filePath)) await rm(row.filePath, { force: true }).catch(() => {})
        await db.delete(zimArchives).where(eq(zimArchives.sourceId, row.sourceId))
        await requeueArchiveDownload(row.sourceId)
        quarantined.push(row.sourceId)
        continue
      }
      await db.update(zimArchives).set({ verifiedAt: new Date(), updatedAt: new Date() }).where(eq(zimArchives.sourceId, row.sourceId))
      valid.push(row.filePath)
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker))
  return { valid, quarantined }
}

/** (Re)start kiwix with the healthy archive list (corrupt ones quarantined first) and
 *  refresh book-name metadata. Used by the background job manager once a bulk archive batch
 *  settles, so the server bounces at most twice (initial spawn + final). */
export async function syncKiwixWithArchives(): Promise<void> {
  const { valid: paths, quarantined } = await listHealthyArchivePaths()
  if (quarantined.length) console.warn(`[archives] quarantined ${quarantined.length} corrupt archive(s), re-queued: ${quarantined.join(', ')}`)
  if (!paths.length) return
  await restartKiwix(paths)
  const rows = await db.select().from(zimArchives)
  for (const r of rows) {
    if (!r.filePath) continue
    try {
      const name = await getZimBookName(r.filePath)
      if (name && name !== r.kiwixBookName) {
        await db.update(zimArchives).set({ kiwixBookName: name, updatedAt: new Date() }).where(eq(zimArchives.sourceId, r.sourceId))
      }
    } catch { /* best-effort metadata refresh */ }
  }
}
