// Book ingestion: validate + land an uploaded file in the content store (EPUB
// parsed for metadata/chapters; PDF/CBZ stored as-is for their client-side
// renderers; CBR transparently converted to CBZ so the reader only handles one
// comic format; audio files land as a 'audio' kind asset for direct playback),
// and auto-add the result to the uploader's library.

import { randomUUID } from 'node:crypto'
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { eq, and, desc, isNotNull } from 'drizzle-orm'
import { db } from '@/db'
import { books, bookChapters, bookLibrary, bookProgress, mediaAssets } from '@/db/schema'
import { contentTmpDir, markBlobLive, putBlobFromFile, withLock } from '@/lib/content/store'
import { openEpub, readMetadata, readSpineChapters, type EpubHandle } from '@/lib/epub/parse'
import { convertCbrToCbz } from './comic'
import { getLibrivoxAudiobook } from './librivox'

const lockKey = (bookId: string) => `book:${bookId}:ebook`

export interface BookListItem {
  id: string
  title: string
  author: string | null
  narrator: string | null
  seriesName: string | null
  seriesIndex: number | null
  coverUrl: string | null
  sourceType: string
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
      metadataJson: coverHref ? JSON.stringify({ coverHref }) : null,
      addedByUserId: userId, createdAt: now, updatedAt: now,
    })

    for (const [i, ch] of chapters.entries()) {
      await db.insert(bookChapters).values({ id: randomUUID(), bookId, idx: i, title: ch.title, epubHref: ch.href })
    }

    await db.insert(bookLibrary).values({ id: randomUUID(), userId, bookId, status: 'ready', addedAt: now })
  })

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
export async function addLibrivoxAudiobook(userId: string, identifier: string): Promise<{ bookId: string }> {
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
      language: audiobook.language, sourceType: 'librivox', sourceRef: identifier,
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
    sourceType: books.sourceType, addedAt: bookLibrary.addedAt, libraryStatus: bookLibrary.status,
  })
    .from(bookLibrary)
    .innerJoin(books, eq(bookLibrary.bookId, books.id))
    .where(eq(bookLibrary.userId, userId))
    .orderBy(desc(bookLibrary.addedAt))

  if (!rows.length) return []
  const bookIds = rows.map((r) => r.id)

  // Only a READY asset counts as "available" — a book mid-download shouldn't
  // claim to have an ebook/audio yet.
  const assets = await db.select({ sourceId: mediaAssets.sourceId, kind: mediaAssets.kind })
    .from(mediaAssets).where(and(eq(mediaAssets.sourceType, 'book'), eq(mediaAssets.status, 'ready')))
  const kindsByBook = new Map<string, Set<string>>()
  for (const a of assets) {
    if (!bookIds.includes(a.sourceId)) continue
    if (!kindsByBook.has(a.sourceId)) kindsByBook.set(a.sourceId, new Set())
    kindsByBook.get(a.sourceId)!.add(a.kind)
  }

  const progressRows = await db.select().from(bookProgress).where(eq(bookProgress.userId, userId))
  const progressByBook = new Map(progressRows.map((p) => [p.bookId, p]))

  // Multi-track (LibriVox) audiobooks have no mediaAssets row at all — their
  // chapters stream directly from an external URL — so "has audio" also needs to
  // check bookChapters for at least one externalAudioUrl.
  const externalAudioBookIds = new Set(
    (await db.selectDistinct({ bookId: bookChapters.bookId }).from(bookChapters)
      .where(isNotNull(bookChapters.externalAudioUrl)))
      .map((r) => r.bookId)
      .filter((id) => bookIds.includes(id)),
  )

  return rows.map((r) => {
    const kinds = kindsByBook.get(r.id)
    const p = progressByBook.get(r.id)
    return {
      id: r.id, title: r.title, author: r.author, narrator: r.narrator,
      seriesName: r.seriesName, seriesIndex: r.seriesIndex, coverUrl: r.coverUrl,
      sourceType: r.sourceType, libraryStatus: r.libraryStatus,
      hasEbook: kinds?.has('ebook') ?? false,
      hasAudio: (kinds?.has('audio') ?? false) || externalAudioBookIds.has(r.id),
      progress: p ? { mode: p.mode, percent: p.percent, completed: p.completed } : null,
    }
  })
}

export async function getBook(bookId: string, userId: string) {
  const [book] = await db.select().from(books).where(eq(books.id, bookId)).limit(1)
  if (!book) return null
  const [progress] = await db.select().from(bookProgress)
    .where(and(eq(bookProgress.userId, userId), eq(bookProgress.bookId, bookId))).limit(1)
  const [libraryRef] = await db.select({ status: bookLibrary.status }).from(bookLibrary)
    .where(and(eq(bookLibrary.userId, userId), eq(bookLibrary.bookId, bookId))).limit(1)
  const assets = await db.select({ kind: mediaAssets.kind, format: mediaAssets.format, status: mediaAssets.status, error: mediaAssets.error })
    .from(mediaAssets).where(and(eq(mediaAssets.sourceType, 'book'), eq(mediaAssets.sourceId, bookId)))

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
}): Promise<void> {
  const now = new Date()
  await db.insert(bookProgress).values({
    id: randomUUID(), userId, bookId,
    mode: update.mode, epubCfi: update.epubCfi ?? null, percent: update.percent ?? 0,
    audioPositionSec: update.audioPositionSec ?? null, audioChapterIdx: update.audioChapterIdx ?? null,
    completed: update.completed ?? false,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [bookProgress.userId, bookProgress.bookId],
    set: {
      mode: update.mode,
      epubCfi: update.epubCfi ?? null,
      percent: update.percent ?? 0,
      audioPositionSec: update.audioPositionSec ?? null,
      audioChapterIdx: update.audioChapterIdx ?? null,
      completed: update.completed ?? false,
      updatedAt: now,
    },
  })
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
