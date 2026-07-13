// Books app v1: upload EPUBs, browse the shared library, read via epub.js (raw file
// served here), track per-user progress. See backend/src/lib/books/library.ts for
// the ingestion/query logic and backend/src/lib/epub/parse.ts for EPUB parsing.

import { Hono } from 'hono'
import { createReadStream, statSync } from 'node:fs'
import { and, eq } from 'drizzle-orm'
import { requireAuth } from '@/middleware/auth'
import {
  uploadBookFile, listLibrary, listLibraryIndex, getBook, getChapters, upsertProgress, getReadyAssetBlobHash, addLibrivoxAudiobook,
  removeFromLibrary, getOrExtractBookCover, getReadingStats,
} from '@/lib/books/library'
import { acquireRead, blobAbsPath, releaseRead } from '@/lib/content/store'
import { searchBookCatalog, searchBooks } from '@/lib/books/search'
import { getBookSample } from '@/lib/books/preview'
import { addAndDownloadBook, downloadBookOffline, enqueueBookDownload, resolveDownloadUrl, saveBook } from '@/lib/books/offline'
import { createBookRequest, requestExistingBook, userMustRequestBooks } from '@/lib/books/requests'
import { getReaderSyncInfo, setKindleEmail, sendBookToKindle } from '@/lib/books/reader'
import { listShelves, createShelf, updateShelf, deleteShelf, resolveShelf, type ShelfRules } from '@/lib/books/shelves'
import { enqueueBookTtsRender } from '@/lib/books/tts'
import { searchLibrivox, browseLibrivoxByCategory, browseAllLibrivoxCategories, browseLibrivoxByCategoryFull, LIBRIVOX_CATEGORIES } from '@/lib/books/librivox'
import { browseGutenbergByTopic, browseAllGutenbergCategories, browseGutenbergByTopicFull } from '@/lib/books/gutenberg'
import { getStandardEbooksNewReleases } from '@/lib/books/standardEbooks'
import { getBuiltinSourceToggles } from '@/lib/books/sourceToggles'
import { listIndexers } from '@/lib/books/indexer'
import { safeFetch } from '@/lib/ssrfGuard'
import type { BookSearchResult } from '@/lib/books/types'
import { GUTENBERG_CATEGORIES } from '@/lib/books/types'
import { browseArchiveVisualBooks, VISUAL_BOOK_SECTIONS } from '@/lib/books/archiveOrg'
import type { BookContentType } from '@/lib/books/types'
import { browseGoogleBooks } from '@/lib/books/googleBooks'
import { browseOpenLibrary } from '@/lib/books/openLibrary'
import { browseAllMagazineCategories, browseMagazineByTopic, browseMagazineByTopicFull, MAGAZINE_CATEGORIES } from '@/lib/books/magazines'
import { mediaAssets, bookChapters, books as booksTable } from '@/db/schema'
import { db } from '@/db'
import type { AppEnv } from '@/types'

export const books = new Hono<AppEnv>()
books.use('*', requireAuth)

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024 // 500 MB — generous for an illustrated CBZ or audiobook file
const SUPPORTED_EXT = /\.(epub|pdf|cbz|cbr|mp3|m4a|m4b|aac)$/i

books.post('/upload', async (c) => {
  const user = c.get('user')
  const form = await c.req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File) || file.size === 0) return c.json({ code: 'file_required' }, 400)
  if (file.size > MAX_UPLOAD_BYTES) return c.json({ code: 'file_too_large' }, 413)
  if (!SUPPORTED_EXT.test(file.name)) {
    return c.json({ code: 'unsupported_format', error: 'Supported: .epub, .pdf, .cbz, .cbr, .mp3, .m4a, .m4b, .aac' }, 400)
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const { bookId } = await uploadBookFile(user.id, file.name, bytes)
    return c.json({ bookId })
  } catch (err) {
    return c.json({ code: 'upload_failed', error: String(err) }, 400)
  }
})

books.get('/library', async (c) => {
  const user = c.get('user')
  return c.json({ books: await listLibrary(user.id) })
})

// Lightweight source-ref → {bookId, status} map so storefront tiles/cards can
// render Save/Download/Offline state without a lookup per result.
books.get('/library/index', async (c) => {
  const user = c.get('user')
  const [entries, mustRequest] = await Promise.all([listLibraryIndex(user.id), userMustRequestBooks(user.id)])
  return c.json({ entries, mustRequest })
})

// Bulk-capable from the start (Clear Selected/Clear All on Books' Offline view) —
// only ever removes the calling user's own library ref + progress, see
// lib/books/library.ts::removeFromLibrary for why the shared catalog row is untouched.
books.post('/library/remove', async (c) => {
  const user = c.get('user')
  const body = (await c.req.json().catch(() => null)) as { bookIds?: string[] } | null
  if (!body?.bookIds?.length) return c.json({ code: 'bad_request' }, 400)
  await Promise.all(body.bookIds.map((id) => removeFromLibrary(user.id, id)))
  return c.json({ ok: true })
})

// Fans out to the enabled book sources in parallel (see lib/books/search.ts).
books.get('/search', async (c) => {
  const q = c.req.query('q')?.trim()
  if (!q) return c.json({ results: [] })
  return c.json({ results: await searchBooks(q) })
})

// Unified title search for the storefront. It keeps downloadable IA/Gutenberg
// records separate from externally discovered web pages so licensing and ingest
// guarantees are explicit at the API boundary.
books.get('/search/catalog', async (c) => {
  const q = c.req.query('q') ?? ''
  if (!q.trim()) return c.json({ ebooks: [], audiobooks: [], web: [] })
  return c.json(await searchBookCatalog(q))
})

// A short reading sample for sources with no embeddable reader (Gutenberg,
// Standard Ebooks) — fetched + de-boilerplated server-side, see lib/books/preview.ts.
books.get('/sample', async (c) => {
  const source = c.req.query('source')?.trim()
  const ref = c.req.query('ref')?.trim()
  if (!source || !ref) return c.json({ code: 'bad_request' }, 400)
  const sample = await getBookSample(source, ref)
  if (!sample) return c.json({ code: 'no_sample' }, 404)
  return c.json(sample)
})

// Book Store landing shelves — one row per curated genre, Gutenberg only (Internet
// Archive/indexer have no comparable genre taxonomy to browse this way). The
// landing page calls browse-all (one round trip, server-side parallel + cached
// per topic — see gutenberg.ts) instead of hitting /categories/:topic ten times.
// All gated on the Gutenberg on/off toggle (Admin/Books Sources) — disabled means
// "don't show or fetch any of it", not just "hide the search results".
books.get('/categories', (c) => c.json({ categories: GUTENBERG_CATEGORIES }))
books.get('/visual-sections', (c) => c.json({ sections: VISUAL_BOOK_SECTIONS }))
books.get('/visual/:type', async (c) => {
  const toggles = await getBuiltinSourceToggles()
  const type = c.req.param('type') as BookContentType
  if (!VISUAL_BOOK_SECTIONS.some((section) => section.key === type) || type === 'book') return c.json({ code: 'bad_request' }, 400)
  const [google, openLibrary] = await Promise.all([
    toggles.googlebooks ? browseGoogleBooks(type) : Promise.resolve([]),
    toggles.openlibrary ? browseOpenLibrary(type) : Promise.resolve([]),
  ])
  const results = [...new Map([...google, ...openLibrary].map((item) => [item.title.toLowerCase(), item])).values()].slice(0, 30)
  if (results.length) return c.json({ results })
  return c.json({ results: toggles.archiveorg ? await browseArchiveVisualBooks(type) : [] })
})
// The full "view all" list behind a visual shelf (Comics/Manga/etc). Page 1
// blends the same modern-metadata sources the shelf preview uses with a bigger
// Internet Archive batch (IA items are the downloadable ones); later pages walk
// IA alone, since Google/Open Library browse endpoints here aren't pageable.
books.get('/visual/:type/full', async (c) => {
  const toggles = await getBuiltinSourceToggles()
  const type = c.req.param('type') as Exclude<BookContentType, 'book'>
  if (!VISUAL_BOOK_SECTIONS.some((section) => section.key === type)) return c.json({ code: 'bad_request' }, 400)
  const page = Math.min(20, Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1))
  const [google, openLibrary, archive] = await Promise.all([
    page === 1 && toggles.googlebooks ? browseGoogleBooks(type) : Promise.resolve([]),
    page === 1 && toggles.openlibrary ? browseOpenLibrary(type) : Promise.resolve([]),
    toggles.archiveorg ? browseArchiveVisualBooks(type, 30, undefined, page) : Promise.resolve([]),
  ])
  const results = [...new Map([...archive, ...google, ...openLibrary].map((item) => [`${item.source}:${item.sourceRef}`, item])).values()]
  return c.json({ results })
})
books.get('/magazines/categories', (c) => c.json({ categories: MAGAZINE_CATEGORIES }))
books.get('/magazines/categories/browse-all', async (c) => {
  const toggles = await getBuiltinSourceToggles()
  if (!toggles.archiveorg && !toggles.openlibrary) return c.json({ shelves: [] })
  return c.json({ shelves: await browseAllMagazineCategories({ archive: toggles.archiveorg, openLibrary: toggles.openlibrary }) })
})
books.get('/magazines/categories/:topic/full', async (c) => {
  const toggles = await getBuiltinSourceToggles()
  if (!toggles.archiveorg && !toggles.openlibrary) return c.json({ results: [] })
  const page = Math.min(20, Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1))
  return c.json({ results: await browseMagazineByTopicFull(c.req.param('topic'), { archive: toggles.archiveorg, openLibrary: toggles.openlibrary }, page) })
})
books.get('/magazines/categories/:topic', async (c) => {
  const toggles = await getBuiltinSourceToggles()
  if (!toggles.archiveorg && !toggles.openlibrary) return c.json({ results: [] })
  return c.json({ results: await browseMagazineByTopic(c.req.param('topic'), 12, { archive: toggles.archiveorg, openLibrary: toggles.openlibrary }) })
})
books.get('/categories/browse-all', async (c) => {
  if (!(await getBuiltinSourceToggles()).gutenberg) return c.json({ shelves: [] })
  return c.json({ shelves: await browseAllGutenbergCategories() })
})
books.get('/categories/:topic/full', async (c) => {
  if (!(await getBuiltinSourceToggles()).gutenberg) return c.json({ results: [] })
  return c.json({ results: await browseGutenbergByTopicFull(c.req.param('topic')) })
})
books.get('/categories/:topic', async (c) => {
  if (!(await getBuiltinSourceToggles()).gutenberg) return c.json({ results: [] })
  return c.json({ results: await browseGutenbergByTopic(c.req.param('topic')) })
})

// Standard Ebooks: browse-only (their full catalog feed now requires an account/API
// key), so just the public "New Releases" feed — no /search or /categories route.
books.get('/standardebooks/new-releases', async (c) => {
  if (!(await getBuiltinSourceToggles()).standardebooks) return c.json({ results: [] })
  return c.json({ results: await getStandardEbooksNewReleases() })
})

// LibriVox audiobooks, via Internet Archive's librivoxaudio collection (see
// lib/books/librivox.ts). Kept separate from /search + /download (which resolve
// EPUB sources) since adding one is synchronous — no download job, chapters stream
// straight from archive.org.
books.get('/search/librivox', async (c) => {
  const q = c.req.query('q')?.trim()
  if (!q || !(await getBuiltinSourceToggles()).librivox) return c.json({ results: [] })
  return c.json({ results: await searchLibrivox(q) })
})

books.get('/librivox/categories', (c) => c.json({ categories: LIBRIVOX_CATEGORIES }))
books.get('/librivox/categories/browse-all', async (c) => {
  if (!(await getBuiltinSourceToggles()).librivox) return c.json({ shelves: [] })
  return c.json({ shelves: await browseAllLibrivoxCategories() })
})
books.get('/librivox/categories/:subject/full', async (c) => {
  if (!(await getBuiltinSourceToggles()).librivox) return c.json({ results: [] })
  return c.json({ results: await browseLibrivoxByCategoryFull(c.req.param('subject')) })
})
books.get('/librivox/categories/:subject', async (c) => {
  if (!(await getBuiltinSourceToggles()).librivox) return c.json({ results: [] })
  return c.json({ results: await browseLibrivoxByCategory(c.req.param('subject')) })
})

// Reading-sync settings: the user's OPDS + KOSync URLs and their Send-to-Kindle
// address, for the Books settings surface.
books.get('/reader-sync', async (c) => {
  const user = c.get('user')
  return c.json(await getReaderSyncInfo(user.id))
})

books.put('/kindle-email', async (c) => {
  const user = c.get('user')
  const body = (await c.req.json().catch(() => null)) as { email?: string } | null
  const email = body?.email?.trim()
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ code: 'bad_email' }, 400)
  await setKindleEmail(user.id, email)
  return c.json({ ok: true })
})

books.post('/:id/send-to-kindle', async (c) => {
  const user = c.get('user')
  const result = await sendBookToKindle(user.id, c.req.param('id'))
  if (!result.ok) return c.json({ code: 'send_failed', error: result.error }, 400)
  return c.json({ ok: true })
})

// Read-only source status for the in-app settings page. Mutations are admin-only
// under /api/admin/books/sources.
books.get('/sources', async (c) => {
  const [toggles, indexers] = await Promise.all([getBuiltinSourceToggles(), listIndexers()])
  return c.json({ toggles, indexers })
})

books.post('/librivox/add', async (c) => {
  const user = c.get('user')
  const body = (await c.req.json().catch(() => null)) as { identifier?: string; publishedYear?: number | null } | null
  if (!body?.identifier) return c.json({ code: 'bad_request' }, 400)
  try {
    const { bookId } = await addLibrivoxAudiobook(user.id, body.identifier, body.publishedYear)
    return c.json({ bookId })
  } catch (err) {
    return c.json({ code: 'add_failed', error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

// "Save" — add to library with metadata only, no bytes downloaded (status 'saved').
books.post('/save', async (c) => {
  const user = c.get('user')
  const result = (await c.req.json()) as BookSearchResult
  if (!result?.source || !result?.sourceRef || !result?.title) return c.json({ code: 'bad_request' }, 400)
  try {
    const { bookId } = await saveBook(user.id, result)
    return c.json({ bookId })
  } catch (err) {
    return c.json({ code: 'save_failed', error: String(err) }, 400)
  }
})

// "Download offline" (Save + Download in one step from a search hit). Kid-safe
// profiles can't pull bytes directly — their download becomes an admin-approved
// request instead (see lib/books/requests.ts). Admins are never gated.
books.post('/download', async (c) => {
  const user = c.get('user')
  const result = (await c.req.json()) as BookSearchResult
  if (!result?.source || !result?.sourceRef || !result?.title) return c.json({ code: 'bad_request' }, 400)
  try {
    if (user.role !== 'admin' && await userMustRequestBooks(user.id)) {
      const { bookId, requested } = await createBookRequest(user.id, result)
      return c.json({ bookId, requested, jobId: null, ready: false })
    }
    const { bookId, jobId } = await addAndDownloadBook(user.id, result)
    return c.json({ bookId, jobId, ready: jobId === null })
  } catch (err) {
    return c.json({ code: 'download_failed', error: String(err) }, 400)
  }
})

// "Download" (to this device): serve the raw file as a browser attachment for use
// outside the app. Prefers an already-downloaded local blob for the same
// source/ref; otherwise resolves the source URL live and proxies it through.
// Registered before the /:id routes so the static segment wins. Kid-safe profiles
// are gated the same way /download is (no bytes without approval).
const FILE_DOWNLOAD_SOURCES = ['gutenberg', 'archiveorg', 'indexer', 'wikisource', 'standardebooks'] as const
books.get('/download-file', async (c) => {
  const user = c.get('user')
  const source = c.req.query('source') as (typeof FILE_DOWNLOAD_SOURCES)[number]
  const ref = c.req.query('ref')
  const format = (c.req.query('format') ?? 'epub') as 'epub' | 'pdf' | 'cbz'
  if (!FILE_DOWNLOAD_SOURCES.includes(source) || !ref || !EBOOK_CONTENT_TYPE[format]) return c.json({ code: 'bad_request' }, 400)
  if (user.role !== 'admin' && await userMustRequestBooks(user.id)) {
    return c.json({ code: 'approval_required', error: 'Downloads need an admin approval on this profile' }, 403)
  }

  const [book] = await db.select({ id: booksTable.id, title: booksTable.title }).from(booksTable)
    .where(and(eq(booksTable.sourceType, source), eq(booksTable.sourceRef, ref))).limit(1)
  const title = (c.req.query('title') || book?.title || ref).slice(0, 120)
  const asFilename = (ext: string) => `${title.replace(/[/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'book'}.${ext}`
  const disposition = (name: string) => `attachment; filename="${name.replace(/[^\x20-\x7e]+/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`

  // Already downloaded for someone's offline library — serve the local blob.
  const asset = book ? await getReadyAssetBlobHash(book.id, 'ebook') : null
  if (asset) {
    const absPath = await blobAbsPath(asset.hash)
    const response = streamBlob(c, absPath, EBOOK_CONTENT_TYPE[asset.format] ?? 'application/octet-stream', asset.hash)
    response.headers.set('Content-Disposition', disposition(asFilename(asset.format)))
    return response
  }

  // No local copy: resolve the source's direct URL and pass the bytes through.
  try {
    const resolved = await resolveDownloadUrl(source, ref, format)
    const headers = { 'User-Agent': 'LokiDoki/3.0 books', Accept: '*/*', 'Accept-Encoding': 'identity', ...resolved.headers }
    const upstream = source === 'indexer'
      ? await fetch(resolved.url, { headers, signal: AbortSignal.timeout(30_000) })
      : await safeFetch(resolved.url, { headers }, { timeoutMs: 30_000, maxRedirects: 8 })
    if (!upstream.ok || !upstream.body) {
      upstream.body?.cancel().catch(() => {})
      return c.json({ code: 'upstream_error', error: `Source responded ${upstream.status}` }, 502)
    }
    const responseHeaders = new Headers({
      'Content-Type': EBOOK_CONTENT_TYPE[resolved.format] ?? 'application/octet-stream',
      'Content-Disposition': disposition(asFilename(resolved.format)),
    })
    const length = upstream.headers.get('content-length')
    if (length) responseHeaders.set('Content-Length', length)
    return new Response(upstream.body, { headers: responseHeaders })
  } catch (err) {
    return c.json({ code: 'download_failed', error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

// "Download offline" for a book already saved in the library (by bookId).
books.post('/:id/download-offline', async (c) => {
  const user = c.get('user')
  try {
    if (user.role !== 'admin' && await userMustRequestBooks(user.id)) {
      const { requested } = await requestExistingBook(user.id, c.req.param('id'))
      return c.json({ requested, jobId: null, ready: false })
    }
    const { jobId } = await downloadBookOffline(user.id, c.req.param('id'))
    return c.json({ jobId, ready: jobId === null })
  } catch (err) {
    return c.json({ code: 'download_failed', error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

// Personal reading stats (finished count, time read, recent finishes).
books.get('/stats', async (c) => {
  const user = c.get('user')
  return c.json(await getReadingStats(user.id))
})

// Smart shelves: saved AND/OR filters over the user's library.
books.get('/shelves', async (c) => c.json({ shelves: await listShelves(c.get('user').id) }))

books.post('/shelves', async (c) => {
  const user = c.get('user')
  const body = (await c.req.json().catch(() => null)) as { name?: string; icon?: string | null; rules?: ShelfRules; pinned?: boolean } | null
  if (!body?.name?.trim() || !body.rules) return c.json({ code: 'bad_request' }, 400)
  return c.json({ shelf: await createShelf(user.id, { name: body.name, icon: body.icon, rules: body.rules, pinned: body.pinned }) })
})

books.put('/shelves/:id', async (c) => {
  const user = c.get('user')
  const body = (await c.req.json().catch(() => null)) as { name?: string; icon?: string | null; rules?: ShelfRules; pinned?: boolean } | null
  if (!body) return c.json({ code: 'bad_request' }, 400)
  const shelf = await updateShelf(user.id, c.req.param('id'), body)
  if (!shelf) return c.json({ code: 'not_found' }, 404)
  return c.json({ shelf })
})

books.delete('/shelves/:id', async (c) => {
  await deleteShelf(c.get('user').id, c.req.param('id'))
  return c.json({ ok: true })
})

books.get('/shelves/:id/items', async (c) => {
  const resolved = await resolveShelf(c.get('user').id, c.req.param('id'))
  if (!resolved) return c.json({ code: 'not_found' }, 404)
  return c.json({ shelf: resolved.shelf, books: resolved.items })
})

books.get('/:id', async (c) => {
  const user = c.get('user')
  const book = await getBook(c.req.param('id'), user.id)
  if (!book) return c.json({ code: 'not_found' }, 404)
  return c.json({ book })
})

// Retry a stuck/failed download for a book already in the library — reuses the same
// get-or-create-job logic a fresh add uses (no-ops back to "ready" if it already
// finished behind the scenes).
books.post('/:id/retry-download', async (c) => {
  try {
    const { jobId } = await enqueueBookDownload(c.req.param('id'))
    return c.json({ jobId, ready: jobId === null })
  } catch (err) {
    return c.json({ code: 'retry_failed', error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

books.get('/:id/chapters', async (c) => {
  return c.json({ chapters: await getChapters(c.req.param('id')) })
})

// Convert an EPUB to an audiobook via the narration engine's speaker-detection +
// multi-voice synthesis (backend/src/lib/books/tts.ts). Long-running — enqueues a
// download_jobs row; poll /:id/tts/status.
books.post('/:id/tts', async (c) => {
  try {
    const { assetId, jobId } = await enqueueBookTtsRender(c.req.param('id'))
    return c.json({ assetId, jobId, ready: jobId === null })
  } catch (err) {
    return c.json({ code: 'tts_failed', error: String(err) }, 400)
  }
})

books.get('/:id/tts/status', async (c) => {
  const [asset] = await db.select({ status: mediaAssets.status, error: mediaAssets.error }).from(mediaAssets)
    .where(and(eq(mediaAssets.sourceType, 'book'), eq(mediaAssets.sourceId, c.req.param('id')), eq(mediaAssets.kind, 'audio'), eq(mediaAssets.format, 'mp3')))
    .limit(1)
  if (!asset) return c.json({ status: 'pending' })
  return c.json({ status: asset.status, error: asset.error })
})

books.put('/:id/progress', async (c) => {
  const user = c.get('user')
  const bookId = c.req.param('id')
  const body = await c.req.json() as {
    mode?: 'reading' | 'listening'; epubCfi?: string | null; percent?: number
    audioPositionSec?: number | null; audioChapterIdx?: number | null; completed?: boolean; elapsedDeltaSec?: number
  }
  if (body.mode !== 'reading' && body.mode !== 'listening') return c.json({ code: 'bad_mode' }, 400)
  await upsertProgress(user.id, bookId, {
    mode: body.mode,
    epubCfi: body.epubCfi ?? null,
    percent: typeof body.percent === 'number' ? Math.max(0, Math.min(1, body.percent)) : 0,
    audioPositionSec: body.audioPositionSec ?? null,
    audioChapterIdx: body.audioChapterIdx ?? null,
    completed: body.completed ?? false,
    elapsedDeltaSec: typeof body.elapsedDeltaSec === 'number' ? body.elapsedDeltaSec : 0,
  })
  return c.json({ ok: true })
})

// Serve the raw ebook bytes with clamped Range support — epub.js fetches this
// directly and handles the zip/CFI/pagination itself; the server never renders HTML.
function streamBlob(c: { req: { header(name: string): string | undefined } }, absPath: string, contentType: string, pin: string): Response {
  let stat: ReturnType<typeof statSync>
  try { stat = statSync(absPath) } catch { return Response.json({ error: 'File missing' }, { status: 404 }) }

  const attach = (stream: ReturnType<typeof createReadStream>) => {
    acquireRead(pin)
    const release = () => releaseRead(pin)
    stream.once('close', release)
    stream.once('error', release)
    return stream
  }

  const rangeHeader = c.req.header('range')
  const rangeMatch = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null
  if (rangeMatch) {
    const size = stat.size
    let start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0
    let end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : size - 1
    if (Number.isNaN(start) || start < 0) start = 0
    if (Number.isNaN(end) || end >= size) end = size - 1
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    }
    return new Response(attach(createReadStream(absPath, { start, end })) as any, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Content-Type': contentType,
      },
    })
  }

  return new Response(attach(createReadStream(absPath)) as any, {
    headers: { 'Content-Type': contentType, 'Content-Length': String(stat.size), 'Accept-Ranges': 'bytes' },
  })
}

const EBOOK_CONTENT_TYPE: Record<string, string> = {
  epub: 'application/epub+zip', pdf: 'application/pdf', cbz: 'application/vnd.comicbook+zip', cbr: 'application/x-rar-compressed',
}
const AUDIO_CONTENT_TYPE: Record<string, string> = { mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac' }

books.get('/:id/file', async (c) => {
  const asset = await getReadyAssetBlobHash(c.req.param('id'), 'ebook')
  if (!asset) return c.json({ code: 'not_ready' }, 404)
  const absPath = await blobAbsPath(asset.hash)
  return streamBlob(c, absPath, EBOOK_CONTENT_TYPE[asset.format] ?? 'application/octet-stream', asset.hash)
})

books.get('/:id/audio', async (c) => {
  const asset = await getReadyAssetBlobHash(c.req.param('id'), 'audio')
  if (!asset) return c.json({ code: 'not_ready' }, 404)
  const absPath = await blobAbsPath(asset.hash)
  return streamBlob(c, absPath, AUDIO_CONTENT_TYPE[asset.format] ?? 'audio/mpeg', asset.hash)
})

// Multi-track (LibriVox) audiobook chapter: proxies the chapter's external URL with
// Range passthrough instead of serving a local blob — same fallback-chain idea as
// the podcast episode streamer (routes/podcasts.ts), minus the local-cache branches
// since these are never downloaded locally in v1.
books.get('/:id/chapters/:idx/stream', async (c) => {
  const idx = parseInt(c.req.param('idx'), 10)
  const [chapter] = await db.select().from(bookChapters)
    .where(and(eq(bookChapters.bookId, c.req.param('id')), eq(bookChapters.idx, idx))).limit(1)
  if (!chapter?.externalAudioUrl) return c.json({ code: 'not_found' }, 404)

  const range = c.req.header('range')
  let upstream: Response
  try {
    upstream = await safeFetch(chapter.externalAudioUrl, range ? { headers: { Range: range } } : {}, { timeoutMs: 30_000, maxRedirects: 8 })
  } catch {
    return c.json({ code: 'upstream_unreachable' }, 502)
  }
  if (!upstream.ok && upstream.status !== 206) return c.json({ code: 'upstream_error' }, 502)

  const headers = new Headers({ 'content-type': upstream.headers.get('content-type') ?? 'audio/mpeg', 'cache-control': 'public, max-age=86400' })
  for (const h of ['content-length', 'content-range', 'accept-ranges']) {
    const v = upstream.headers.get(h)
    if (v) headers.set(h, v)
  }
  return new Response(upstream.body, { status: upstream.status, headers })
})

// Serves the EPUB's cover image. Extraction happens once (at ingest/download, or
// lazily on the first request for books added before covers were cached) and is
// stored as a kind:'cover' media-asset blob — see lib/books/library.ts. Only EPUB
// has this concept server-side; PDF/CBZ covers are just "the first page", which
// the client-side readers already show without a dedicated endpoint.
books.get('/:id/cover', async (c) => {
  const cover = await getOrExtractBookCover(c.req.param('id'))
  if (cover) {
    c.header('Content-Type', cover.mime)
    c.header('Cache-Control', 'private, max-age=86400')
    return c.body(cover.bytes as any)
  }
  // Covers only extract from EPUBs — a downloaded PDF/CBZ still has the catalog's
  // remote cover art, so bounce those to the cached image proxy instead of 404ing
  // (the Offline/Library pages always ask here when an ebook asset exists).
  const [book] = await db.select({ coverUrl: booksTable.coverUrl }).from(booksTable)
    .where(eq(booksTable.id, c.req.param('id'))).limit(1)
  if (book?.coverUrl) return c.redirect(`/api/img?u=${encodeURIComponent(book.coverUrl)}`, 302)
  return c.json({ code: 'no_cover' }, 404)
})
