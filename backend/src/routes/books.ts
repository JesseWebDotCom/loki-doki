// Books app v1: upload EPUBs, browse the shared library, read via epub.js (raw file
// served here), track per-user progress. See backend/src/lib/books/library.ts for
// the ingestion/query logic and backend/src/lib/epub/parse.ts for EPUB parsing.

import { Hono } from 'hono'
import { createReadStream, statSync } from 'node:fs'
import { and, eq } from 'drizzle-orm'
import { requireAuth } from '@/middleware/auth'
import {
  uploadBookFile, listLibrary, getBook, getChapters, upsertProgress, getReadyAssetBlobHash, addLibrivoxAudiobook,
  removeFromLibrary,
} from '@/lib/books/library'
import { openEpub, readMetadata } from '@/lib/epub/parse'
import { acquireRead, blobAbsPath, releaseRead } from '@/lib/content/store'
import { searchBooks } from '@/lib/books/search'
import { addAndDownloadBook, enqueueBookDownload } from '@/lib/books/offline'
import { enqueueBookTtsRender } from '@/lib/books/tts'
import { searchLibrivox, browseLibrivoxByCategory, browseAllLibrivoxCategories, browseLibrivoxByCategoryFull, LIBRIVOX_CATEGORIES } from '@/lib/books/librivox'
import { browseGutenbergByTopic, browseAllGutenbergCategories, browseGutenbergByTopicFull } from '@/lib/books/gutenberg'
import { getBuiltinSourceToggles, setBuiltinSourceToggle, type BuiltinSource } from '@/lib/books/sourceToggles'
import { listIndexers } from '@/lib/books/indexer'
import { safeFetch } from '@/lib/ssrfGuard'
import type { BookSearchResult } from '@/lib/books/types'
import { GUTENBERG_CATEGORIES } from '@/lib/books/types'
import { mediaAssets, bookChapters } from '@/db/schema'
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

// Fans out to Gutenberg + Internet Archive (public-domain only — see lib/books/search.ts).
books.get('/search', async (c) => {
  const q = c.req.query('q')?.trim()
  if (!q) return c.json({ results: [] })
  return c.json({ results: await searchBooks(q) })
})

// Book Store landing shelves — one row per curated genre, Gutenberg only (Internet
// Archive/indexer have no comparable genre taxonomy to browse this way). The
// landing page calls browse-all (one round trip, server-side parallel + cached
// per topic — see gutenberg.ts) instead of hitting /categories/:topic ten times.
// All gated on the Gutenberg on/off toggle (Admin/Books Sources) — disabled means
// "don't show or fetch any of it", not just "hide the search results".
books.get('/categories', (c) => c.json({ categories: GUTENBERG_CATEGORIES }))
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

// Sources: on/off for the built-in keyless catalogs (any household member can
// flip these), plus a read-only list of admin-managed custom OPDS indexers
// (adding/editing those needs credentials, so that stays in
// Admin > Integrations > Books — see routes/adminBooks.ts).
books.get('/sources', async (c) => {
  const [toggles, indexers] = await Promise.all([getBuiltinSourceToggles(), listIndexers()])
  return c.json({ toggles, indexers })
})
books.put('/sources/toggle', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { source?: BuiltinSource; enabled?: boolean } | null
  if (!body?.source || typeof body.enabled !== 'boolean' || !['gutenberg', 'archiveorg', 'librivox'].includes(body.source)) {
    return c.json({ code: 'bad_request' }, 400)
  }
  await setBuiltinSourceToggle(body.source, body.enabled)
  return c.json({ ok: true })
})

books.post('/librivox/add', async (c) => {
  const user = c.get('user')
  const body = (await c.req.json().catch(() => null)) as { identifier?: string } | null
  if (!body?.identifier) return c.json({ code: 'bad_request' }, 400)
  try {
    const { bookId } = await addLibrivoxAudiobook(user.id, body.identifier)
    return c.json({ bookId })
  } catch (err) {
    return c.json({ code: 'add_failed', error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

books.post('/download', async (c) => {
  const user = c.get('user')
  const result = (await c.req.json()) as BookSearchResult
  if (!result?.source || !result?.sourceRef || !result?.title) return c.json({ code: 'bad_request' }, 400)
  try {
    const { bookId, jobId } = await addAndDownloadBook(user.id, result)
    return c.json({ bookId, jobId, ready: jobId === null })
  } catch (err) {
    return c.json({ code: 'download_failed', error: String(err) }, 400)
  }
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
    audioPositionSec?: number | null; audioChapterIdx?: number | null; completed?: boolean
  }
  if (body.mode !== 'reading' && body.mode !== 'listening') return c.json({ code: 'bad_mode' }, 400)
  await upsertProgress(user.id, bookId, {
    mode: body.mode,
    epubCfi: body.epubCfi ?? null,
    percent: typeof body.percent === 'number' ? Math.max(0, Math.min(1, body.percent)) : 0,
    audioPositionSec: body.audioPositionSec ?? null,
    audioChapterIdx: body.audioChapterIdx ?? null,
    completed: body.completed ?? false,
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

const COVER_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
}

// Re-opens the EPUB and extracts the manifest's cover-image item. Cheap enough
// (single in-memory unzip) to do per-request for v1; revisit with a cached
// extraction-on-upload if book covers become a hot path. Only EPUB has this
// concept server-side — PDF/CBZ covers are just "the first page", which the
// client-side readers already show without a dedicated endpoint.
books.get('/:id/cover', async (c) => {
  const asset = await getReadyAssetBlobHash(c.req.param('id'), 'ebook')
  if (!asset || asset.format !== 'epub') return c.json({ code: 'no_cover' }, 404)
  const absPath = await blobAbsPath(asset.hash)
  acquireRead(asset.hash)
  try {
    const handle = await openEpub(absPath)
    const meta = readMetadata(handle)
    if (!meta.coverHref) return c.json({ code: 'no_cover' }, 404)
    const bytes = handle.entries[meta.coverHref]
    if (!bytes) return c.json({ code: 'no_cover' }, 404)
    const ext = meta.coverHref.split('.').pop()?.toLowerCase() ?? ''
    c.header('Content-Type', COVER_MIME[ext] ?? 'image/jpeg')
    c.header('Cache-Control', 'private, max-age=86400')
    return c.body(bytes as any)
  } catch {
    return c.json({ code: 'no_cover' }, 404)
  } finally {
    releaseRead(asset.hash)
  }
})
