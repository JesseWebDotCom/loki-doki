// Book ingestion: validate + land an uploaded file in the content store (EPUB
// parsed for metadata/chapters; PDF/CBZ stored as-is for their client-side
// renderers; CBR transparently converted to CBZ so the reader only handles one
// comic format; audio files land as a 'audio' kind asset for direct playback),
// and auto-add the result to the uploader's library.

import { randomUUID } from 'node:crypto'
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { eq, and, desc, isNotNull, inArray, sql } from 'drizzle-orm'
import { db } from '@/db'
import { books, bookChapters, bookLibrary, bookProgress, downloadJobs, mediaAssets } from '@/db/schema'
import { blobAbsPath, contentTmpDir, markBlobLive, putBlobFromFile, withLock } from '@/lib/content/store'
import { openEpub, readMetadata, readSpineChapters, type EpubHandle } from '@/lib/epub/parse'
import { convertCbrToCbz } from './comic'
import { getLibrivoxAudiobook } from './librivox'

const lockKey = (bookId: string) => `book:${bookId}:ebook`
const coverLockKey = (bookId: string) => `book:${bookId}:cover`

const COVER_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
}

/** Persist an EPUB's cover as a `kind:'cover'` media-asset blob so /:id/cover never
 *  has to re-unzip the book per request. Extracted once at ingest/download (callers
 *  already have the EPUB open) or lazily on the first cover request (see
 *  getOrExtractBookCover). Dedups + GC's through the shared blob store like any
 *  other rendition. Best-effort: a cover failure never blocks ingestion. */
async function storeCoverAsset(bookId: string, handle: EpubHandle, coverHref: string | null): Promise<{ format: string; mime: string } | null> {
  if (!coverHref) return null
  const bytes = handle.entries[coverHref]
  if (!bytes) return null
  const ext = coverHref.split('.').pop()?.toLowerCase() ?? 'jpg'
  const format = ext in COVER_MIME ? ext : 'jpg'
  const mime = COVER_MIME[format] ?? 'image/jpeg'
  return withLock(coverLockKey(bookId), async () => {
    const [existing] = await db.select({ id: mediaAssets.id, status: mediaAssets.status }).from(mediaAssets)
      .where(and(eq(mediaAssets.sourceType, 'book'), eq(mediaAssets.sourceId, bookId), eq(mediaAssets.kind, 'cover'), eq(mediaAssets.format, format))).limit(1)
    if (existing?.status === 'ready') return { format, mime }
    const tmpPath = join(await contentTmpDir(), `book-cover-${bookId}-${randomUUID()}.${format}`)
    await writeFile(tmpPath, bytes)
    const put = await putBlobFromFile(tmpPath, { mime })
    const now = new Date()
    if (existing) {
      await db.update(mediaAssets).set({ blobHash: put.hash, sizeBytes: put.sizeBytes, status: 'ready', updatedAt: now }).where(eq(mediaAssets.id, existing.id))
    } else {
      await db.insert(mediaAssets).values({
        id: randomUUID(), sourceType: 'book', sourceId: bookId, kind: 'cover', format,
        blobHash: put.hash, sizeBytes: put.sizeBytes, status: 'ready', createdAt: now, updatedAt: now,
      }).onConflictDoNothing()
    }
    await markBlobLive(put.hash)
    return { format, mime }
  }).catch(() => null)
}

export async function cacheBookCoverFromEpub(bookId: string, handle: EpubHandle, coverHref: string | null): Promise<void> {
  await storeCoverAsset(bookId, handle, coverHref)
}

/** Serve-path helper for /:id/cover: return the cached cover bytes, extracting +
 *  caching them on the first request for books ingested before covers were cached.
 *  Returns null when the book has no EPUB cover. */
export async function getOrExtractBookCover(bookId: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  // Fast path: a ready cover asset already exists.
  const [cover] = await db.select({ blobHash: mediaAssets.blobHash, format: mediaAssets.format, status: mediaAssets.status })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.sourceType, 'book'), eq(mediaAssets.sourceId, bookId), eq(mediaAssets.kind, 'cover'))).limit(1)
  if (cover?.status === 'ready' && cover.blobHash) {
    const abs = await blobAbsPath(cover.blobHash)
    try {
      const bytes = await Bun.file(abs).bytes()
      return { bytes, mime: COVER_MIME[cover.format] ?? 'image/jpeg' }
    } catch { /* blob missing — fall through to re-extract */ }
  }
  // Lazy backfill: extract from the EPUB blob, cache for next time, return bytes.
  const ebook = await getReadyAssetBlobHash(bookId, 'ebook')
  if (!ebook || ebook.format !== 'epub') return null
  const abs = await blobAbsPath(ebook.hash)
  const handle = await openEpub(abs)
  const meta = readMetadata(handle)
  if (!meta.coverHref) return null
  const bytes = handle.entries[meta.coverHref]
  if (!bytes) return null
  await storeCoverAsset(bookId, handle, meta.coverHref)
  const ext = meta.coverHref.split('.').pop()?.toLowerCase() ?? 'jpg'
  return { bytes, mime: COVER_MIME[ext] ?? 'image/jpeg' }
}

export interface BookListItem {
  id: string
  title: string
  author: string | null
  narrator: string | null
  seriesName: string | null
  seriesIndex: number | null
  coverUrl: string | null
  sourceType: string
  contentType: 'book' | 'magazine' | 'children' | 'comic' | 'manga' | 'coloring_book'
  libraryStatus: string
  hasEbook: boolean
  hasAudio: boolean
  progress: { mode: string; percent: number; completed: boolean } | null
}

type EbookFormat = 'epub' | 'pdf' | 'cbz' | 'cbr'
type UploadKind = EbookFormat | 'audio'

const EBOOK_MIME: Record<EbookFormat, string> = {
  epub: 'application/epub+zip', pdf: 'application/pdf', cbz: 'application/vnd.comicbook+zip', cbr: 'application/x-rar-compressed',
}
const AUDIO_EXT_MIME: Record<string, string> = { mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac' }

function detectUploadKind(filename: string): UploadKind | null {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  if (ext === 'epub' || ext === 'pdf' || ext === 'cbz' || ext === 'cbr') return ext
  if (ext in AUDIO_EXT_MIME) return 'audio'
  return null
}

export async function uploadBookFile(userId: string, filename: string, bytes: Uint8Array): Promise<{ bookId: string }> {
  const kind = detectUploadKind(filename)
  if (!kind) throw new Error('Unsupported file type — .epub, .pdf, .cbz, .cbr, .mp3, .m4a, .m4b, .aac are supported')
  if (kind === 'audio') return uploadAudiobook(userId, filename, bytes)
  return uploadEbookFile(userId, filename, bytes, kind)
}

async function uploadEbookFile(userId: string, filename: string, bytes: Uint8Array, format: EbookFormat): Promise<{ bookId: string }> {
  const tmpPath = join(await contentTmpDir(), `book-upload-${randomUUID()}.${format}`)
  await writeFile(tmpPath, bytes)

  let title = filename.replace(/\.[^.]+$/, '')
  let author: string | null = null
  let language: string | null = null
  let coverHref: string | null = null
  let finalPath = tmpPath
  let finalFormat: EbookFormat = format
  let chapters: { href: string; title: string }[] = []
  let handle: EpubHandle | null = null

  try {
    if (format === 'epub') {
      handle = await openEpub(tmpPath)
      const meta = readMetadata(handle)
      title = meta.title || title
      author = meta.author
      language = meta.language
      coverHref = meta.coverHref
      chapters = readSpineChapters(handle)
    } else if (format === 'cbr') {
      const cbzPath = join(await contentTmpDir(), `book-upload-${randomUUID()}.cbz`)
      await convertCbrToCbz(tmpPath, cbzPath)
      await unlink(tmpPath).catch(() => {})
      finalPath = cbzPath
      finalFormat = 'cbz'
    }
    // pdf/cbz: stored as-is — their readers (pdf.js / client-side unzip) work
    // directly off the raw file, no server-side metadata extraction in v1.
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    await unlink(finalPath).catch(() => {})
    throw new Error(`Not a valid ${format.toUpperCase()} file: ${err instanceof Error ? err.message : err}`)
  }

  const bookId = randomUUID()
  const now = new Date()

  await withLock(lockKey(bookId), async () => {
    const put = await putBlobFromFile(finalPath, { mime: EBOOK_MIME[finalFormat] })
    await db.insert(mediaAssets).values({
      id: randomUUID(), sourceType: 'book', sourceId: bookId, kind: 'ebook', format: finalFormat,
      blobHash: put.hash, sizeBytes: put.sizeBytes, status: 'ready', createdAt: now, updatedAt: now,
    })
    await markBlobLive(put.hash)

    await db.insert(books).values({
      id: bookId, title, author, language, sourceType: 'upload', sourceRef: null,
      contentType: finalFormat === 'cbz' ? 'comic' : 'book',
      metadataJson: coverHref ? JSON.stringify({ coverHref }) : null,
      addedByUserId: userId, createdAt: now, updatedAt: now,
    })

    for (const [i, ch] of chapters.entries()) {
      await db.insert(bookChapters).values({ id: randomUUID(), bookId, idx: i, title: ch.title, epubHref: ch.href })
    }

    await db.insert(bookLibrary).values({ id: randomUUID(), userId, bookId, status: 'ready', addedAt: now })
  })

  // Cache the cover now while the EPUB is already parsed, so /:id/cover never unzips.
  if (handle && coverHref) await cacheBookCoverFromEpub(bookId, handle, coverHref)

  return { bookId }
}

async function uploadAudiobook(userId: string, filename: string, bytes: Uint8Array): Promise<{ bookId: string }> {
  const ext = filename.toLowerCase().split('.').pop()!
  const tmpPath = join(await contentTmpDir(), `book-upload-${randomUUID()}.${ext}`)
  await writeFile(tmpPath, bytes)

  const bookId = randomUUID()
  const now = new Date()
  const title = filename.replace(/\.[^.]+$/, '')

  await withLock(lockKey(bookId), async () => {
    const put = await putBlobFromFile(tmpPath, { mime: AUDIO_EXT_MIME[ext] ?? 'audio/mpeg' })
    await db.insert(mediaAssets).values({
      id: randomUUID(), sourceType: 'book', sourceId: bookId, kind: 'audio', format: ext,
      blobHash: put.hash, sizeBytes: put.sizeBytes, status: 'ready', createdAt: now, updatedAt: now,
    })
    await markBlobLive(put.hash)
    await db.insert(books).values({
      id: bookId, title, sourceType: 'upload', sourceRef: null, addedByUserId: userId, createdAt: now, updatedAt: now,
    })
    await db.insert(bookLibrary).values({ id: randomUUID(), userId, bookId, status: 'ready', addedAt: now })
  })

  return { bookId }
}

/** Adds a LibriVox audiobook (via Internet Archive) to the shared catalog and the
 *  calling user's library. Unlike EPUB downloads, there's no job/blob-store step:
 *  chapters stream straight from archive.org's CDN via the /chapters/:idx/stream
 *  proxy, so this only needs to persist metadata + per-chapter URLs. Multiple users
 *  adding the same audiobook share one `books` row via the (sourceType, sourceRef)
 *  unique index — the second add is just a new bookLibrary ref. */
export async function addLibrivoxAudiobook(userId: string, identifier: string, publishedYear?: number | null): Promise<{ bookId: string }> {
  const [existing] = await db.select({ id: books.id }).from(books)
    .where(and(eq(books.sourceType, 'librivox'), eq(books.sourceRef, identifier))).limit(1)

  const now = new Date()
  let bookId: string

  if (existing) {
    bookId = existing.id
  } else {
    const audiobook = await getLibrivoxAudiobook(identifier)
    bookId = randomUUID()
    await db.insert(books).values({
      id: bookId, title: audiobook.title, author: audiobook.author, description: audiobook.description,
      language: audiobook.language, publishedYear: publishedYear ?? null, sourceType: 'librivox', sourceRef: identifier,
      coverUrl: `https://archive.org/services/img/${identifier}`,
      addedByUserId: userId, createdAt: now, updatedAt: now,
    })
    for (const [i, ch] of audiobook.chapters.entries()) {
      await db.insert(bookChapters).values({
        id: randomUUID(), bookId, idx: i, title: ch.title,
        externalAudioUrl: ch.url, externalAudioDurationSec: ch.durationSec,
      })
    }
  }

  await db.insert(bookLibrary).values({ id: randomUUID(), userId, bookId, status: 'ready', addedAt: now })
    .onConflictDoNothing()

  return { bookId }
}

/** Every book in the given user's library, with their own progress attached. */
export async function listLibrary(userId: string): Promise<BookListItem[]> {
  const rows = await db.select({
    id: books.id, title: books.title, author: books.author, narrator: books.narrator,
    seriesName: books.seriesName, seriesIndex: books.seriesIndex, coverUrl: books.coverUrl,
    sourceType: books.sourceType, contentType: books.contentType, addedAt: bookLibrary.addedAt, libraryStatus: bookLibrary.status,
  })
    .from(bookLibrary)
    .innerJoin(books, eq(bookLibrary.bookId, books.id))
    .where(eq(bookLibrary.userId, userId))
    .orderBy(desc(bookLibrary.addedAt))

  if (!rows.length) return []
  const bookIds = rows.map((r) => r.id)

  // Only a READY asset counts as "available" — a book mid-download shouldn't
  // claim to have an ebook/audio yet. Scope the scan to this user's books
  // (was a global sweep of every household book asset, filtered in JS).
  // Multi-track (LibriVox) audiobooks have no mediaAssets row at all — their
  // chapters stream directly from an external URL — so "has audio" also needs to
  // check bookChapters for at least one externalAudioUrl. Both run in parallel
  // with the per-user progress read.
  const [assets, progressRows, externalAudioRows] = await Promise.all([
    db.select({ sourceId: mediaAssets.sourceId, kind: mediaAssets.kind })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.sourceType, 'book'), eq(mediaAssets.status, 'ready'), inArray(mediaAssets.sourceId, bookIds))),
    db.select().from(bookProgress).where(eq(bookProgress.userId, userId)),
    db.selectDistinct({ bookId: bookChapters.bookId }).from(bookChapters)
      .where(and(isNotNull(bookChapters.externalAudioUrl), inArray(bookChapters.bookId, bookIds))),
  ])

  const kindsByBook = new Map<string, Set<string>>()
  for (const a of assets) {
    if (!kindsByBook.has(a.sourceId)) kindsByBook.set(a.sourceId, new Set())
    kindsByBook.get(a.sourceId)!.add(a.kind)
  }

  const progressByBook = new Map(progressRows.map((p) => [p.bookId, p]))
  const externalAudioBookIds = new Set(externalAudioRows.map((r) => r.bookId))

  return rows.map((r) => {
    const kinds = kindsByBook.get(r.id)
    const p = progressByBook.get(r.id)
    return {
      id: r.id, title: r.title, author: r.author, narrator: r.narrator,
      seriesName: r.seriesName, seriesIndex: r.seriesIndex, coverUrl: r.coverUrl,
      sourceType: r.sourceType, contentType: r.contentType, libraryStatus: r.libraryStatus,
      hasEbook: kinds?.has('ebook') ?? false,
      hasAudio: (kinds?.has('audio') ?? false) || externalAudioBookIds.has(r.id),
      progress: p ? { mode: p.mode, percent: p.percent, completed: p.completed } : null,
    }
  })
}

export interface LibraryIndexEntry { source: string; sourceRef: string; bookId: string; status: string; progress: number | null }

/** A lightweight map of the user's library keyed by external source ref, so
 *  storefront tiles/cards (which only hold a `source:sourceRef`, not a bookId)
 *  can show the right Save/Download/Offline state without a per-tile lookup.
 *  Entries mid-download carry the job's byte progress as a 0..1 fraction. */
export async function listLibraryIndex(userId: string): Promise<LibraryIndexEntry[]> {
  const rows = await db.select({
    source: books.sourceType, sourceRef: books.sourceRef, bookId: books.id, status: bookLibrary.status,
  })
    .from(bookLibrary)
    .innerJoin(books, eq(bookLibrary.bookId, books.id))
    .where(eq(bookLibrary.userId, userId))

  const progressByBook = new Map<string, number>()
  if (rows.some((r) => r.status === 'pending' || r.status === 'downloading')) {
    const jobs = await db.select({ refId: downloadJobs.refId, progress: downloadJobs.progress }).from(downloadJobs)
      .where(and(eq(downloadJobs.type, 'book-download'), inArray(downloadJobs.status, ['pending', 'running'])))
    for (const job of jobs) {
      try {
        const { bookId } = JSON.parse(job.refId) as { bookId?: string }
        const { completed, total } = JSON.parse(job.progress ?? '{}') as { completed?: number; total?: number }
        if (bookId && completed && total) progressByBook.set(bookId, Math.min(1, completed / total))
      } catch { /* malformed job rows just show no percent */ }
    }
  }

  return rows.flatMap((r) => (r.sourceRef
    ? [{ source: r.source, sourceRef: r.sourceRef, bookId: r.bookId, status: r.status, progress: progressByBook.get(r.bookId) ?? null }]
    : []))
}

export async function getBook(bookId: string, userId: string) {
  const [[book], [progress], [libraryRef], assets] = await Promise.all([
    db.select().from(books).where(eq(books.id, bookId)).limit(1),
    db.select().from(bookProgress)
      .where(and(eq(bookProgress.userId, userId), eq(bookProgress.bookId, bookId))).limit(1),
    db.select({ status: bookLibrary.status }).from(bookLibrary)
      .where(and(eq(bookLibrary.userId, userId), eq(bookLibrary.bookId, bookId))).limit(1),
    db.select({ kind: mediaAssets.kind, format: mediaAssets.format, status: mediaAssets.status, error: mediaAssets.error })
      .from(mediaAssets).where(and(eq(mediaAssets.sourceType, 'book'), eq(mediaAssets.sourceId, bookId))),
  ])
  if (!book) return null

  // Multi-track (LibriVox) audiobooks have no mediaAssets row — synthesize one so
  // callers that check `assets.find(a => a.kind === 'audio' && a.status === 'ready')`
  // (BookDetailPage's Listen button, etc.) work unchanged for either kind of audiobook.
  if (!assets.some((a) => a.kind === 'audio')) {
    const [hasExternalAudio] = await db.select({ id: bookChapters.id }).from(bookChapters)
      .where(and(eq(bookChapters.bookId, bookId), isNotNull(bookChapters.externalAudioUrl))).limit(1)
    if (hasExternalAudio) assets.push({ kind: 'audio', format: 'mp3', status: 'ready', error: null })
  }

  return { ...book, progress: progress ?? null, assets, libraryStatus: libraryRef?.status ?? null }
}

export async function getChapters(bookId: string) {
  return db.select().from(bookChapters).where(eq(bookChapters.bookId, bookId)).orderBy(bookChapters.idx)
}

export async function upsertProgress(userId: string, bookId: string, update: {
  mode: 'reading' | 'listening'
  epubCfi?: string | null
  percent?: number
  audioPositionSec?: number | null
  audioChapterIdx?: number | null
  completed?: boolean
  /** Active reading/listening seconds since the last heartbeat (capped, best-effort). */
  elapsedDeltaSec?: number
}): Promise<void> {
  const now = new Date()
  const completed = update.completed ?? false
  // Cap the per-update delta so a client bug / long-idle tab can't inflate stats.
  const delta = Math.max(0, Math.min(update.elapsedDeltaSec ?? 0, 600))
  await db.insert(bookProgress).values({
    id: randomUUID(), userId, bookId,
    mode: update.mode, epubCfi: update.epubCfi ?? null, percent: update.percent ?? 0,
    audioPositionSec: update.audioPositionSec ?? null, audioChapterIdx: update.audioChapterIdx ?? null,
    completed,
    // Stats: first touch starts the clock; finishing stamps the finish date.
    startedAt: now, finishedAt: completed ? now : null, elapsedSec: delta,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [bookProgress.userId, bookProgress.bookId],
    set: {
      mode: update.mode,
      epubCfi: update.epubCfi ?? null,
      percent: update.percent ?? 0,
      audioPositionSec: update.audioPositionSec ?? null,
      audioChapterIdx: update.audioChapterIdx ?? null,
      completed,
      // Keep the original startedAt; stamp finishedAt only when finishing; accrue time.
      startedAt: sql`COALESCE(${bookProgress.startedAt}, ${now.getTime()})`,
      finishedAt: completed ? now : sql`${bookProgress.finishedAt}`,
      elapsedSec: sql`${bookProgress.elapsedSec} + ${delta}`,
      updatedAt: now,
    },
  })
}

export interface ReadingStats {
  finishedCount: number
  inProgressCount: number
  totalMinutes: number
  finishedThisYear: number
  recentFinished: { bookId: string; title: string; author: string | null; coverUrl: string | null; finishedAt: number }[]
}

/** Aggregate reading stats for the user's own progress rows. */
export async function getReadingStats(userId: string): Promise<ReadingStats> {
  const rows = await db.select({
    bookId: bookProgress.bookId, completed: bookProgress.completed, elapsedSec: bookProgress.elapsedSec,
    finishedAt: bookProgress.finishedAt, percent: bookProgress.percent,
    title: books.title, author: books.author, coverUrl: books.coverUrl,
  })
    .from(bookProgress)
    .innerJoin(books, eq(bookProgress.bookId, books.id))
    .where(eq(bookProgress.userId, userId))

  const yearStart = new Date(new Date().getFullYear(), 0, 1).getTime()
  const finished = rows.filter((r) => r.completed || r.percent >= 0.98)
  const totalSec = rows.reduce((sum, r) => sum + (r.elapsedSec ?? 0), 0)
  const recentFinished = finished
    .filter((r) => r.finishedAt)
    .sort((a, b) => (b.finishedAt!.getTime()) - (a.finishedAt!.getTime()))
    .slice(0, 12)
    .map((r) => ({ bookId: r.bookId, title: r.title, author: r.author, coverUrl: r.coverUrl, finishedAt: r.finishedAt!.getTime() }))
  return {
    finishedCount: finished.length,
    inProgressCount: rows.filter((r) => !r.completed && r.percent > 0 && r.percent < 0.98).length,
    totalMinutes: Math.round(totalSec / 60),
    finishedThisYear: finished.filter((r) => r.finishedAt && r.finishedAt.getTime() >= yearStart).length,
    recentFinished,
  }
}

/** Removes a book from ONE user's library — this is a shared household catalog
 *  (like Podcasts/Music/YouTube), so this only ever drops the calling user's
 *  bookLibrary ref + their own progress, never the shared `books`/`bookChapters`/
 *  `mediaAssets` rows another household member might still have in their library.
 *  The existing content-store gcSweep() reclaims the underlying blob automatically
 *  once no bookLibrary row anywhere still references it — no explicit blob release
 *  needed, matching how Podcasts/YouTube downloads already work. */
export async function removeFromLibrary(userId: string, bookId: string): Promise<void> {
  await Promise.all([
    db.delete(bookLibrary).where(and(eq(bookLibrary.userId, userId), eq(bookLibrary.bookId, bookId))),
    db.delete(bookProgress).where(and(eq(bookProgress.userId, userId), eq(bookProgress.bookId, bookId))),
  ])
}

/** Get the ready asset's blob hash + format for a book, or null if not present/ready. */
export async function getReadyAssetBlobHash(bookId: string, kind: 'ebook' | 'audio'): Promise<{ hash: string; format: string } | null> {
  const [asset] = await db.select({ blobHash: mediaAssets.blobHash, format: mediaAssets.format, status: mediaAssets.status })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.sourceType, 'book'), eq(mediaAssets.sourceId, bookId), eq(mediaAssets.kind, kind)))
    .limit(1)
  if (!asset || asset.status !== 'ready' || !asset.blobHash) return null
  return { hash: asset.blobHash, format: asset.format }
}
