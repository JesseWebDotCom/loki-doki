// Book downloads over the shared blob store (download-jobs type 'book-download'),
// mirroring backend/src/lib/podcast/offline.ts's shape: one media_assets rendition
// per book (sourceType='book', sourceId=bookId, kind='ebook'), so two users adding
// the same Gutenberg/Archive.org book share one downloaded copy. bookLibrary rows
// are refs/pins (not a per-user offline-copy choice like podcasts — every library
// addition implies "I want this downloaded").

import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { books, bookChapters, bookLibrary, downloadJobs, mediaAssets } from '@/db/schema'
import { contentTmpDir, markBlobLive, putBlobFromFile, withLock } from '@/lib/content/store'
import { safeFetch } from '@/lib/ssrfGuard'
import { openEpub, readSpineChapters } from '@/lib/epub/parse'
import { resolveGutenbergDownload } from './gutenberg'
import { resolveArchiveOrgDownload } from './archiveOrg'
import { resolveIndexerDownload } from './indexer'
import { resolveWikisourceDownload } from './wikisource'
import type { BookSearchResult, DownloadableBookFormat, ResolvedDownload } from './types'
import { logger } from '@/lib/logger'

export interface BookDownloadPayload { bookId: string }

const SOURCE = 'book'
const lockKey = (bookId: string) => `book:${bookId}:ebook`

async function resolveDownloadUrl(sourceType: string, sourceRef: string, format: DownloadableBookFormat): Promise<ResolvedDownload> {
  if (sourceType === 'gutenberg') return resolveGutenbergDownload(sourceRef)
  if (sourceType === 'archiveorg') return resolveArchiveOrgDownload(sourceRef, format)
  if (sourceType === 'indexer') return resolveIndexerDownload(sourceRef)
  if (sourceType === 'wikisource') return resolveWikisourceDownload(sourceRef)
  // Standard Ebooks: sourceRef IS the direct .epub URL (captured at browse time),
  // no per-book lookup needed like Gutenberg/Archive.org's numeric-id schemes.
  if (sourceType === 'standardebooks') return { url: sourceRef, format: 'epub' }
  throw new Error(`Unknown source type: ${sourceType}`)
}

/** Get-or-create the shared catalog row for a Discover/search hit. */
async function getOrCreateCatalogBook(userId: string, result: BookSearchResult): Promise<{ id: string }> {
  const now = new Date()
  let [book] = await db.select({ id: books.id }).from(books)
    .where(and(eq(books.sourceType, result.source), eq(books.sourceRef, result.sourceRef))).limit(1)
  if (!book) {
    const id = randomUUID()
    await db.insert(books).values({
      id, title: result.title, author: result.author, language: result.language, publishedYear: result.publishedYear ?? null,
      coverUrl: result.coverUrl, description: result.description ?? null,
      sourceType: result.source, sourceRef: result.sourceRef, contentType: result.contentType ?? 'book',
      metadataJson: JSON.stringify({ downloadFormat: result.downloadFormat ?? 'epub' }),
      addedByUserId: userId, createdAt: now, updatedAt: now,
    }).onConflictDoNothing()
    ;[book] = await db.select({ id: books.id }).from(books)
      .where(and(eq(books.sourceType, result.source), eq(books.sourceRef, result.sourceRef))).limit(1)
  }
  if (!book) throw new Error('Failed to create catalog entry')
  return book
}

/** "Save" — add a search hit to the user's library WITHOUT downloading any bytes
 *  (status 'saved'). The user can read it via the source's online preview, or hit
 *  "Download offline" later to pull a local copy. No-ops if already in the library. */
export async function saveBook(userId: string, result: BookSearchResult): Promise<{ bookId: string }> {
  const book = await getOrCreateCatalogBook(userId, result)
  await db.insert(bookLibrary).values({ id: randomUUID(), userId, bookId: book.id, status: 'saved', addedAt: new Date() })
    .onConflictDoNothing()
  return { bookId: book.id }
}

/** "Download offline" for a book already in (or about to enter) the user's library:
 *  flip a lightweight 'saved'/'failed' ref to 'pending' (creating one if missing)
 *  and kick off — or reuse — the shared download job. A ref that's already
 *  downloading/ready is left as-is. */
export async function downloadBookOffline(userId: string, bookId: string): Promise<{ jobId: string | null }> {
  const now = new Date()
  const [ref] = await db.select({ status: bookLibrary.status }).from(bookLibrary)
    .where(and(eq(bookLibrary.userId, userId), eq(bookLibrary.bookId, bookId))).limit(1)
  if (!ref) {
    await db.insert(bookLibrary).values({ id: randomUUID(), userId, bookId, status: 'pending', addedAt: now })
      .onConflictDoNothing()
  } else if (ref.status === 'saved' || ref.status === 'failed') {
    await db.update(bookLibrary).set({ status: 'pending' })
      .where(and(eq(bookLibrary.userId, userId), eq(bookLibrary.bookId, bookId)))
  }
  return enqueueBookDownload(bookId)
}

/** Get-or-create the catalog row for a search hit, add it to the requesting user's
 *  library, and immediately download it offline (Save + Download in one step). */
export async function addAndDownloadBook(userId: string, result: BookSearchResult): Promise<{ bookId: string; jobId: string | null }> {
  const { bookId } = await saveBook(userId, result)
  const { jobId } = await downloadBookOffline(userId, bookId)
  return { bookId, jobId }
}

/** Get-or-create the (book, epub) asset and its download job. Returns immediately
 *  with `jobId: null` if the asset is already ready. */
export async function enqueueBookDownload(bookId: string): Promise<{ jobId: string | null }> {
  const [book] = await db.select().from(books).where(eq(books.id, bookId)).limit(1)
  if (!book) throw new Error('Unknown book')
  const now = new Date()
  const metadata = book.metadataJson ? JSON.parse(book.metadataJson) as { downloadFormat?: DownloadableBookFormat } : {}
  const format = metadata.downloadFormat ?? 'epub'

  return withLock(lockKey(bookId), async () => {
    let [asset] = await db.select().from(mediaAssets).where(and(
      eq(mediaAssets.sourceType, SOURCE), eq(mediaAssets.sourceId, bookId),
      eq(mediaAssets.kind, 'ebook'), eq(mediaAssets.format, format),
    )).limit(1)
    if (!asset) {
      const values: typeof mediaAssets.$inferInsert = {
        id: randomUUID(), sourceType: SOURCE, sourceId: bookId, kind: 'ebook', format,
        status: 'pending', createdAt: now, updatedAt: now,
      }
      await db.insert(mediaAssets).values(values)
      asset = (await db.select().from(mediaAssets).where(eq(mediaAssets.id, values.id!)).limit(1))[0]!
    } else if (asset.status === 'failed') {
      await db.update(mediaAssets).set({ status: 'pending', error: null, updatedAt: now }).where(eq(mediaAssets.id, asset.id))
      asset = { ...asset, status: 'pending' }
    }

    if (asset.status === 'ready') {
      await linkReady(bookId)
      return { jobId: null }
    }

    const refId = JSON.stringify({ bookId } satisfies BookDownloadPayload)
    const [existing] = await db.select().from(downloadJobs)
      .where(and(eq(downloadJobs.type, 'book-download'), eq(downloadJobs.refId, refId))).limit(1)
    let jobId: string
    if (existing) {
      jobId = existing.id
      if (['failed', 'cancelled', 'completed'].includes(existing.status)) {
        await db.update(downloadJobs)
          .set({ status: 'pending', attempts: 0, nextEligibleAt: null, lastError: null, updatedAt: now })
          .where(eq(downloadJobs.id, existing.id))
      }
    } else {
      jobId = randomUUID()
      await db.insert(downloadJobs).values({
        id: jobId, type: 'book-download', refId, variantKey: null,
        domain: 'books', sizeClass: 'small', label: `Book: ${book.title.slice(0, 100)}`,
        priority: 55, status: 'pending', attempts: 0, maxAttempts: 3,
        nextEligibleAt: null, lastError: null, progress: null, createdAt: now, updatedAt: now,
      })
    }
    return { jobId }
  })
}

/** Terminal-failure hook (called from the job queue after retries are exhausted). */
export async function failBookDownloadByJobRefId(refId: string, error: string): Promise<void> {
  let payload: BookDownloadPayload
  try { payload = JSON.parse(refId) as BookDownloadPayload } catch { return }
  await withLock(lockKey(payload.bookId), async () => {
    const now = new Date()
    await db.update(mediaAssets).set({ status: 'failed', error: error.slice(0, 300), updatedAt: now })
      .where(and(eq(mediaAssets.sourceType, SOURCE), eq(mediaAssets.sourceId, payload.bookId), eq(mediaAssets.kind, 'ebook')))
    await db.update(bookLibrary).set({ status: 'failed' })
      .where(and(eq(bookLibrary.bookId, payload.bookId), inArray(bookLibrary.status, ['pending', 'downloading'])))
  })
}

export async function runBookDownloadJob(
  payload: BookDownloadPayload,
  onProgress: (p: { completed: number; total: number; speedBps: number; etaSeconds: number; note?: string }) => void,
  signal: AbortSignal,
): Promise<void> {
  const { bookId } = payload
  const [book] = await db.select().from(books).where(eq(books.id, bookId)).limit(1)
  if (!book || !book.sourceRef) throw new Error(`Unknown book ${bookId}`)

  const metadata = book.metadataJson ? JSON.parse(book.metadataJson) as { downloadFormat?: DownloadableBookFormat } : {}
  const { url, format, headers: authHeaders } = await resolveDownloadUrl(book.sourceType, book.sourceRef, metadata.downloadFormat ?? 'epub')

  const asset = await withLock(lockKey(bookId), async () => {
    const [a] = await db.select().from(mediaAssets).where(and(
      eq(mediaAssets.sourceType, SOURCE), eq(mediaAssets.sourceId, bookId),
      eq(mediaAssets.kind, 'ebook'), eq(mediaAssets.format, format),
    )).limit(1)
    if (!a) throw new Error('Asset row missing (enqueue creates it)')
    if (a.status === 'ready') return a
    await db.update(mediaAssets).set({ status: 'downloading', updatedAt: new Date() }).where(eq(mediaAssets.id, a.id))
    await db.update(bookLibrary).set({ status: 'downloading' })
      .where(and(eq(bookLibrary.bookId, bookId), eq(bookLibrary.status, 'pending')))
    return a
  })
  if (asset.status === 'ready') { await linkReady(bookId); return }

  const tmpPath = join(await contentTmpDir(), `book-${bookId}-${Date.now()}.${format}`)
  try {
    const fetchHeaders = { 'User-Agent': 'LokiDoki/3.0 books', Accept: '*/*', 'Accept-Encoding': 'identity', ...authHeaders }
    // A self-hosted indexer is admin-configured and typically on the LAN — bypass
    // the SSRF guard the same way lib/homeAssistant/client.ts does for the same
    // reason (Gutenberg/Archive.org are arbitrary public URLs and stay guarded).
    const res = book.sourceType === 'indexer'
      ? await fetch(url, { headers: fetchHeaders, signal: AbortSignal.timeout(30_000) })
      : await safeFetch(url, { headers: fetchHeaders }, { timeoutMs: 30_000, maxRedirects: 8 })
    if (!res.ok || !res.body) {
      res.body?.cancel().catch(() => {})
      throw new Error(`Source responded ${res.status}`)
    }
    const totalHeader = Number.parseInt(res.headers.get('content-length') ?? '', 10)
    const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : 0

    const out = createWriteStream(tmpPath)
    const reader = res.body.getReader()
    let completed = 0
    let lastTick = Date.now()
    let lastBytes = 0
    try {
      for (;;) {
        if (signal.aborted) throw new Error('Aborted')
        const { done, value } = await reader.read()
        if (done) break
        completed += value.byteLength
        await new Promise<void>((resolve, reject) => out.write(value, (err) => (err ? reject(err) : resolve())))
        const nowMs = Date.now()
        if (nowMs - lastTick >= 1000) {
          const speedBps = (completed - lastBytes) / ((nowMs - lastTick) / 1000)
          onProgress({
            completed, total: Math.max(total, completed), speedBps,
            etaSeconds: speedBps > 0 && total > completed ? Math.round((total - completed) / speedBps) : 0,
          })
          lastTick = nowMs; lastBytes = completed
        }
      }
    } finally {
      reader.releaseLock?.()
      await new Promise<void>((resolve) => out.end(() => resolve()))
    }
    if (completed === 0) throw new Error('Download returned no data')

    const chapters = format === 'epub' ? readSpineChapters(await openEpub(tmpPath)) : []
    const mime = format === 'epub' ? 'application/epub+zip'
      : format === 'pdf' ? 'application/pdf' : 'application/vnd.comicbook+zip'

    const put = await putBlobFromFile(tmpPath, { mime })
    await withLock(lockKey(bookId), async () => {
      const now = new Date()
      await db.update(mediaAssets).set({
        blobHash: put.hash, sizeBytes: put.sizeBytes, status: 'ready', error: null, updatedAt: now,
      }).where(eq(mediaAssets.id, asset.id))
      await markBlobLive(put.hash)

      const existingChapters = await db.select({ id: bookChapters.id }).from(bookChapters).where(eq(bookChapters.bookId, bookId))
      if (existingChapters.length === 0) {
        for (const [i, ch] of chapters.entries()) {
          await db.insert(bookChapters).values({ id: randomUUID(), bookId, idx: i, title: ch.title, epubHref: ch.href })
        }
      }
      await linkReady(bookId)
    })
    logger.info(`[books] downloaded "${book.title}" from ${book.sourceType} (${(put.sizeBytes / 1e6).toFixed(1)} MB${put.deduped ? ', deduped' : ''})`)
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    throw err
  }
}

/** Flip every waiting library ref for this book to ready. */
async function linkReady(bookId: string): Promise<void> {
  await db.update(bookLibrary).set({ status: 'ready' })
    .where(and(eq(bookLibrary.bookId, bookId), inArray(bookLibrary.status, ['pending', 'downloading'])))
}
