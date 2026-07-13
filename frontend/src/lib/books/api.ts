export interface BookListItem {
  id: string
  title: string
  author: string | null
  narrator: string | null
  seriesName: string | null
  seriesIndex: number | null
  coverUrl: string | null
  sourceType: string
  contentType: BookContentType
  libraryStatus: BookLibraryStatus
  hasEbook: boolean
  hasAudio: boolean
  progress: { mode: string; percent: number; completed: boolean } | null
}

export interface BookSearchResult {
  source: 'gutenberg' | 'archiveorg' | 'standardebooks' | 'indexer' | 'wikisource' | 'googlebooks' | 'openlibrary'
  sourceRef: string
  title: string
  author: string | null
  language: string | null
  coverUrl: string | null
  description?: string | null
  subjects?: string[]
  downloadCount?: number | null
  mediaType?: 'ebook'
  formats?: string[]
  sizeBytes?: number | null
  publishedYear?: number | null
  contentType?: BookContentType
  downloadFormat?: 'epub' | 'pdf' | 'cbz'
  previewId?: string
  previewAvailable?: boolean
  pageCount?: number | null
  publishedDate?: string | null
  externalUrl?: string
}

export type BookContentType = 'book' | 'magazine' | 'children' | 'comic' | 'manga' | 'coloring_book'

// 'saved' = in your library, metadata only (no local copy). 'ready' = downloaded
// offline. pending/downloading = an offline download in flight.
export type BookLibraryStatus = 'requested' | 'saved' | 'pending' | 'downloading' | 'ready' | 'failed'

export interface GutenbergCategory { label: string; topic: string }
export interface LibrivoxCategory { label: string; subject: string }
export interface MagazineCategory { label: string; topic: string }

export interface BookDetail {
  id: string
  title: string
  author: string | null
  narrator: string | null
  description: string | null
  language: string | null
  publishedYear: number | null
  contentType: BookContentType
  coverUrl: string | null
  sourceType: string
  progress: { mode: string; epubCfi: string | null; percent: number; audioPositionSec: number | null; audioChapterIdx: number | null; completed: boolean } | null
  assets: { kind: string; format: string; status: string; error?: string | null }[]
  libraryStatus: BookLibraryStatus | null
}

export interface BookChapter {
  id: string
  idx: number
  title: string
  epubHref: string | null
  audioStartSec: number | null
  audioEndSec: number | null
  externalAudioUrl: string | null
  externalAudioDurationSec: number | null
}

export interface LibrivoxSearchResult {
  identifier: string
  title: string
  author: string | null
  language: string | null
  coverUrl: string | null
  runtime: string | null
  description?: string | null
  subjects?: string[]
  mediaType?: 'audiobook'
  formats?: string[]
  sizeBytes?: number | null
  publishedYear?: number | null
}

export interface WebBookSearchResult {
  source: 'web'
  sourceRef: string
  title: string
  author: null
  language: null
  coverUrl: null
  description: string | null
  mediaType: 'ebook' | 'audiobook'
  formats: string[]
  sizeBytes: number | null
  externalUrl: string
  siteName: string
}

export interface BookCatalogSearch {
  ebooks: BookSearchResult[]
  audiobooks: LibrivoxSearchResult[]
  web: WebBookSearchResult[]
}

export async function listLibrary(): Promise<BookListItem[]> {
  const r = await fetch('/api/books/library', { credentials: 'include' })
  if (!r.ok) return []
  const d = (await r.json()) as { books?: BookListItem[] }
  return d.books ?? []
}

export async function getBook(id: string): Promise<BookDetail | null> {
  const r = await fetch(`/api/books/${id}`, { credentials: 'include' })
  if (!r.ok) return null
  const d = (await r.json()) as { book: BookDetail }
  return d.book
}

export async function getChapters(id: string): Promise<BookChapter[]> {
  const r = await fetch(`/api/books/${id}/chapters`, { credentials: 'include' })
  if (!r.ok) return []
  const d = (await r.json()) as { chapters?: BookChapter[] }
  return d.chapters ?? []
}

export async function uploadBookFile(file: File): Promise<{ bookId: string }> {
  const form = new FormData()
  form.append('file', file)
  const r = await fetch('/api/books/upload', { method: 'POST', credentials: 'include', body: form })
  if (!r.ok) {
    const d = await r.json().catch(() => ({})) as { error?: string }
    throw new Error(d.error ?? 'Upload failed')
  }
  return r.json()
}

export async function updateProgress(bookId: string, update: {
  mode: 'reading' | 'listening'
  epubCfi?: string | null
  percent?: number
  audioPositionSec?: number | null
  audioChapterIdx?: number | null
  completed?: boolean
  elapsedDeltaSec?: number
}): Promise<void> {
  await fetch(`/api/books/${bookId}/progress`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  })
}

export function bookFileUrl(bookId: string): string {
  return `/api/books/${bookId}/file`
}

export function bookCoverUrl(bookId: string): string {
  return `/api/books/${bookId}/cover`
}

export function bookAudioUrl(bookId: string): string {
  return `/api/books/${bookId}/audio`
}

export async function searchBooks(query: string): Promise<BookSearchResult[]> {
  if (!query.trim()) return []
  const r = await fetch(`/api/books/search?q=${encodeURIComponent(query)}`, { credentials: 'include' })
  if (!r.ok) return []
  const d = (await r.json()) as { results?: BookSearchResult[] }
  return d.results ?? []
}

export async function searchBookCatalog(query: string): Promise<BookCatalogSearch> {
  if (!query.trim()) return { ebooks: [], audiobooks: [], web: [] }
  const r = await fetch(`/api/books/search/catalog?q=${encodeURIComponent(query)}`, { credentials: 'include' })
  if (!r.ok) return { ebooks: [], audiobooks: [], web: [] }
  return r.json()
}

export async function downloadBook(result: BookSearchResult): Promise<{ bookId: string; jobId: string | null; ready: boolean; requested?: boolean }> {
  const r = await fetch('/api/books/download', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(result),
  })
  if (!r.ok) {
    const d = await r.json().catch(() => ({})) as { error?: string }
    throw new Error(d.error ?? 'Could not start the download')
  }
  return r.json()
}

/** Save a search hit to the library WITHOUT downloading (metadata only, status 'saved'). */
export async function saveBook(result: BookSearchResult): Promise<{ bookId: string }> {
  const r = await fetch('/api/books/save', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(result),
  })
  if (!r.ok) {
    const d = await r.json().catch(() => ({})) as { error?: string }
    throw new Error(d.error ?? 'Could not save this item')
  }
  return r.json()
}

/** Pull a local (offline) copy of a book already saved in the library. */
export async function downloadBookOffline(bookId: string): Promise<{ jobId: string | null; ready: boolean; requested?: boolean }> {
  const r = await fetch(`/api/books/${bookId}/download-offline`, { method: 'POST', credentials: 'include' })
  if (!r.ok) {
    const d = await r.json().catch(() => ({})) as { error?: string }
    throw new Error(d.error ?? 'Could not start the download')
  }
  return r.json()
}

export interface BookSample { paragraphs: string[]; sourceUrl: string; truncated: boolean }

/** A short reading sample for sources with no embeddable reader (Gutenberg,
 *  Standard Ebooks). Returns null when the source has no fetchable full text. */
export async function getBookSample(source: string, ref: string): Promise<BookSample | null> {
  const r = await fetch(`/api/books/sample?source=${encodeURIComponent(source)}&ref=${encodeURIComponent(ref)}`, { credentials: 'include' })
  if (!r.ok) return null
  return r.json()
}

export interface LibraryIndexEntry { source: string; sourceRef: string; bookId: string; status: BookLibraryStatus; progress?: number | null }

/** Lightweight source-ref → library-state map for storefront tiles/cards.
 *  `mustRequest` = kid-safe profile whose downloads become approval requests. */
export async function listLibraryIndex(): Promise<{ entries: LibraryIndexEntry[]; mustRequest: boolean }> {
  const r = await fetch('/api/books/library/index', { credentials: 'include' })
  if (!r.ok) return { entries: [], mustRequest: false }
  const d = (await r.json()) as { entries?: LibraryIndexEntry[]; mustRequest?: boolean }
  return { entries: d.entries ?? [], mustRequest: d.mustRequest === true }
}

/** "Download to this device" URL — serves the raw ebook file as a browser
 *  attachment (local blob when already offline, live source proxy otherwise). */
export function bookDeviceDownloadUrl(result: BookSearchResult): string {
  const params = new URLSearchParams({ source: result.source, ref: result.sourceRef, title: result.title })
  if (result.downloadFormat) params.set('format', result.downloadFormat)
  return `/api/books/download-file?${params.toString()}`
}

/** Re-enqueues a stuck/failed download for a book already in the library. */
export async function retryBookDownload(bookId: string): Promise<{ jobId: string | null; ready: boolean }> {
  const r = await fetch(`/api/books/${bookId}/retry-download`, { method: 'POST', credentials: 'include' })
  if (!r.ok) {
    const d = await r.json().catch(() => ({})) as { error?: string }
    throw new Error(d.error ?? 'Could not retry the download')
  }
  return r.json()
}

/** Removes one or more books from your library (Clear Selected/Clear All on the
 *  Offline view). Only your own library ref + progress are removed, see
 *  backend/src/lib/books/library.ts::removeFromLibrary. */
export async function removeBooksFromLibrary(bookIds: string[]): Promise<void> {
  const r = await fetch('/api/books/library/remove', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookIds }),
  })
  if (!r.ok) throw new Error('Could not remove from library')
}

export async function enqueueBookTts(bookId: string): Promise<{ ready: boolean }> {
  const r = await fetch(`/api/books/${bookId}/tts`, { method: 'POST', credentials: 'include' })
  if (!r.ok) {
    const d = await r.json().catch(() => ({})) as { error?: string }
    throw new Error(d.error ?? 'Could not start audiobook conversion')
  }
  return r.json()
}

export async function getBookTtsStatus(bookId: string): Promise<{ status: string; error?: string }> {
  const r = await fetch(`/api/books/${bookId}/tts/status`, { credentials: 'include' })
  if (!r.ok) return { status: 'pending' }
  return r.json()
}

export function chapterStreamUrl(bookId: string, idx: number): string {
  return `/api/books/${bookId}/chapters/${idx}/stream`
}

export async function searchLibrivox(query: string): Promise<LibrivoxSearchResult[]> {
  if (!query.trim()) return []
  const r = await fetch(`/api/books/search/librivox?q=${encodeURIComponent(query)}`, { credentials: 'include' })
  if (!r.ok) return []
  const d = (await r.json()) as { results?: LibrivoxSearchResult[] }
  return d.results ?? []
}

export async function addLibrivox(identifier: string, publishedYear?: number | null): Promise<{ bookId: string }> {
  const r = await fetch('/api/books/librivox/add', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, publishedYear }),
  })
  if (!r.ok) {
    const d = await r.json().catch(() => ({})) as { error?: string }
    throw new Error(d.error ?? 'Could not add this audiobook')
  }
  return r.json()
}

export interface ArchiveBrowseEntry { title: string; path: string }

export async function browseArchive(sourceId: string, opts: { start?: number; count?: number; q?: string } = {}): Promise<{ results: ArchiveBrowseEntry[]; total: number; unsupported?: boolean }> {
  const params = new URLSearchParams({
    start: String(opts.start ?? 0), count: String(opts.count ?? 30), q: opts.q ?? '',
  })
  const r = await fetch(`/api/archives/browse/${sourceId}?${params.toString()}`, { credentials: 'include' })
  if (!r.ok) return { results: [], total: 0 }
  return r.json()
}

export interface GutenbergShelf { category: GutenbergCategory; results: BookSearchResult[] }
export interface LibrivoxShelf { category: LibrivoxCategory; results: LibrivoxSearchResult[] }
export interface VisualBookShelf { key: Exclude<BookContentType, 'book'>; label: string; results: BookSearchResult[] }

/** All Book Store genre shelves in one round trip (server fetches/caches each
 *  topic in parallel) instead of one request per shelf. */
export async function browseAllGutenbergCategories(): Promise<GutenbergShelf[]> {
  const r = await fetch('/api/books/categories/browse-all', { credentials: 'include' })
  if (!r.ok) return []
  const d = (await r.json()) as { shelves?: GutenbergShelf[] }
  return d.shelves ?? []
}

/** All Audiobook Store genre shelves in one round trip, see browseAllGutenbergCategories. */
export async function browseAllLibrivoxCategories(): Promise<LibrivoxShelf[]> {
  const r = await fetch('/api/books/librivox/categories/browse-all', { credentials: 'include' })
  if (!r.ok) return []
  const d = (await r.json()) as { shelves?: LibrivoxShelf[] }
  return d.shelves ?? []
}

export async function browseAllMagazineCategories(): Promise<{ category: MagazineCategory; results: BookSearchResult[] }[]> {
  const r = await fetch('/api/books/magazines/categories/browse-all', { credentials: 'include' })
  if (!r.ok) return []
  const d = (await r.json()) as { shelves?: { category: MagazineCategory; results: BookSearchResult[] }[] }
  return d.shelves ?? []
}

export async function browseMagazineCategoryFull(topic: string, page = 1): Promise<BookSearchResult[]> {
  const r = await fetch(`/api/books/magazines/categories/${encodeURIComponent(topic)}/full?page=${page}`, { credentials: 'include' })
  if (!r.ok) return []
  const d = (await r.json()) as { results?: BookSearchResult[] }
  return d.results ?? []
}

export async function browseVisualBookShelves(): Promise<VisualBookShelf[]> {
  const sectionsResponse = await fetch('/api/books/visual-sections', { credentials: 'include' })
  if (!sectionsResponse.ok) return []
  const { sections = [] } = await sectionsResponse.json() as { sections?: Array<{ key: Exclude<BookContentType, 'book'>; label: string }> }
  return Promise.all(sections.map(async (section) => {
    const response = await fetch(`/api/books/visual/${section.key}`, { credentials: 'include' })
    const data = response.ok ? await response.json() as { results?: BookSearchResult[] } : {}
    return { ...section, results: data.results ?? [] }
  }))
}

/** The full "view all" list behind a visual shelf (Comics/Manga/Children's/
 *  Coloring Books). Page 1 blends all enabled sources; later pages walk
 *  Internet Archive alone. */
export async function browseVisualBooksFull(type: Exclude<BookContentType, 'book'>, page = 1): Promise<BookSearchResult[]> {
  const r = await fetch(`/api/books/visual/${type}/full?page=${page}`, { credentials: 'include' })
  if (!r.ok) return []
  const d = (await r.json()) as { results?: BookSearchResult[] }
  return d.results ?? []
}

/** The full "view all" list behind a Book Store shelf's title (a few pages, not
 *  just the 12-item preview). */
export async function browseGutenbergCategoryFull(topic: string): Promise<BookSearchResult[]> {
  const r = await fetch(`/api/books/categories/${encodeURIComponent(topic)}/full`, { credentials: 'include' })
  if (!r.ok) return []
  const d = (await r.json()) as { results?: BookSearchResult[] }
  return d.results ?? []
}

/** The full "view all" list behind an Audiobook Store shelf's title. */
export async function browseLibrivoxCategoryFull(subject: string): Promise<LibrivoxSearchResult[]> {
  const r = await fetch(`/api/books/librivox/categories/${encodeURIComponent(subject)}/full`, { credentials: 'include' })
  if (!r.ok) return []
  const d = (await r.json()) as { results?: LibrivoxSearchResult[] }
  return d.results ?? []
}

// ── Sources: on/off for built-ins (any user), custom OPDS indexers (admin CRUD) ──

export type BuiltinSource = 'gutenberg' | 'archiveorg' | 'librivox' | 'standardebooks' | 'wikisource' | 'googlebooks' | 'openlibrary' | 'web'
export interface BuiltinSourceToggles { gutenberg: boolean; archiveorg: boolean; librivox: boolean; standardebooks: boolean; wikisource: boolean; googlebooks: boolean; openlibrary: boolean; web: boolean }
export interface BookIndexer { id: string; label: string; baseUrl: string; username: string | null; hasPassword: boolean; enabled: boolean }

export async function getBookSources(): Promise<{ toggles: BuiltinSourceToggles; indexers: BookIndexer[] }> {
  const r = await fetch('/api/books/sources', { credentials: 'include' })
  if (!r.ok) return { toggles: { gutenberg: true, archiveorg: true, librivox: true, standardebooks: true, wikisource: true, googlebooks: true, openlibrary: true, web: true }, indexers: [] }
  return r.json()
}

/** Standard Ebooks' latest ~15 releases. Browse-only (no keyword search), see
 *  backend/src/lib/books/standardEbooks.ts for why. */
export async function getStandardEbooksNewReleases(): Promise<BookSearchResult[]> {
  const r = await fetch('/api/books/standardebooks/new-releases', { credentials: 'include' })
  if (!r.ok) return []
  const d = (await r.json()) as { results?: BookSearchResult[] }
  return d.results ?? []
}

export async function setBookSourceToggle(source: BuiltinSource, enabled: boolean): Promise<void> {
  const r = await fetch(`/api/admin/books/sources/${source}`, {
    method: 'PUT', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, enabled }),
  })
  if (!r.ok) throw new Error('Could not update the book source')
}

/** Admin debug switch: the Internet Archive publicdomain-license download gate. */
export async function getIaLicenseCheck(): Promise<boolean> {
  const r = await fetch('/api/admin/books/ia-license-check', { credentials: 'include' })
  if (!r.ok) return true
  return ((await r.json()) as { enabled?: boolean }).enabled !== false
}

export async function setIaLicenseCheck(enabled: boolean): Promise<void> {
  const r = await fetch('/api/admin/books/ia-license-check', {
    method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
  })
  if (!r.ok) throw new Error('Could not update the license check')
}

export async function getGoogleBooksKeyStatus(): Promise<boolean> {
  const response = await fetch('/api/admin/books/google-books-key', { credentials: 'include' })
  if (!response.ok) return false
  return ((await response.json()) as { configured?: boolean }).configured === true
}

export async function setGoogleBooksApiKey(apiKey: string): Promise<void> {
  const response = await fetch('/api/admin/books/google-books-key', {
    method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey }),
  })
  if (!response.ok) throw new Error('Could not save the Google Books API key')
}

// ── Kid-safe acquisition requests (admin) ────────────────────────────────────────
export interface BookRequest {
  bookId: string; userId: string; userName: string | null
  title: string; author: string | null; coverUrl: string | null; sourceType: string; requestedAt: number | null
}

export async function listBookRequests(): Promise<BookRequest[]> {
  const r = await fetch('/api/admin/books/requests', { credentials: 'include' })
  if (!r.ok) return []
  return ((await r.json()) as { requests?: BookRequest[] }).requests ?? []
}

export async function approveBookRequest(userId: string, bookId: string): Promise<void> {
  const r = await fetch('/api/admin/books/requests/approve', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, bookId }),
  })
  if (!r.ok) throw new Error('Could not approve the request')
}

export async function denyBookRequest(userId: string, bookId: string): Promise<void> {
  const r = await fetch('/api/admin/books/requests/deny', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, bookId }),
  })
  if (!r.ok) throw new Error('Could not decline the request')
}

// ── Reading sync (OPDS / KOReader / Send-to-Kindle) ──────────────────────────────
export interface ReaderSyncInfo { opdsPath: string; kosyncPath: string; kindleEmail: string | null }

export async function getReaderSync(): Promise<ReaderSyncInfo> {
  const r = await fetch('/api/books/reader-sync', { credentials: 'include' })
  if (!r.ok) return { opdsPath: '', kosyncPath: '/api/kosync', kindleEmail: null }
  return r.json()
}

export async function setKindleEmail(email: string): Promise<void> {
  const r = await fetch('/api/books/kindle-email', {
    method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
  })
  if (!r.ok) throw new Error('Could not save the email address')
}

export async function sendBookToKindle(bookId: string): Promise<void> {
  const r = await fetch(`/api/books/${bookId}/send-to-kindle`, { method: 'POST', credentials: 'include' })
  if (!r.ok) {
    const d = await r.json().catch(() => ({})) as { error?: string }
    throw new Error(d.error ?? 'Could not send the book')
  }
}

// ── Reading stats ────────────────────────────────────────────────────────────────
export interface ReadingStats {
  finishedCount: number; inProgressCount: number; totalMinutes: number; finishedThisYear: number
  recentFinished: { bookId: string; title: string; author: string | null; coverUrl: string | null; finishedAt: number }[]
}

export async function getReadingStats(): Promise<ReadingStats> {
  const r = await fetch('/api/books/stats', { credentials: 'include' })
  if (!r.ok) return { finishedCount: 0, inProgressCount: 0, totalMinutes: 0, finishedThisYear: 0, recentFinished: [] }
  return r.json()
}

// ── Smart shelves ────────────────────────────────────────────────────────────────
export type ShelfField = 'title' | 'author' | 'contentType' | 'sourceType' | 'status' | 'format' | 'finished'
export type ShelfOp = 'contains' | 'is' | 'isNot'
export interface ShelfRule { field: ShelfField; op: ShelfOp; value: string }
export interface ShelfRules { match: 'all' | 'any'; rules: ShelfRule[] }
export interface Shelf { id: string; name: string; icon: string | null; rules: ShelfRules; pinned: boolean; sortOrder: number }

export async function listShelves(): Promise<Shelf[]> {
  const r = await fetch('/api/books/shelves', { credentials: 'include' })
  if (!r.ok) return []
  return ((await r.json()) as { shelves?: Shelf[] }).shelves ?? []
}

export async function createShelf(input: { name: string; icon?: string | null; rules: ShelfRules; pinned?: boolean }): Promise<Shelf> {
  const r = await fetch('/api/books/shelves', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  })
  if (!r.ok) throw new Error('Could not create the shelf')
  return ((await r.json()) as { shelf: Shelf }).shelf
}

export async function updateShelf(id: string, patch: { name?: string; icon?: string | null; rules?: ShelfRules; pinned?: boolean }): Promise<void> {
  const r = await fetch(`/api/books/shelves/${id}`, {
    method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  })
  if (!r.ok) throw new Error('Could not update the shelf')
}

export async function deleteShelf(id: string): Promise<void> {
  const r = await fetch(`/api/books/shelves/${id}`, { method: 'DELETE', credentials: 'include' })
  if (!r.ok) throw new Error('Could not delete the shelf')
}

export async function getShelfItems(id: string): Promise<{ shelf: Shelf; books: BookListItem[] }> {
  const r = await fetch(`/api/books/shelves/${id}/items`, { credentials: 'include' })
  if (!r.ok) throw new Error('Shelf not found')
  return r.json()
}

export async function listBookIndexers(): Promise<BookIndexer[]> {
  const r = await fetch('/api/admin/books/indexers', { credentials: 'include' })
  if (!r.ok) return []
  const d = (await r.json()) as { indexers?: BookIndexer[] }
  return d.indexers ?? []
}

export async function createBookIndexer(input: { label: string; baseUrl: string; username?: string; password?: string; enabled?: boolean }): Promise<BookIndexer> {
  const r = await fetch('/api/admin/books/indexers', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const d = await r.json() as { indexer: BookIndexer }
  return d.indexer
}

export async function updateBookIndexer(id: string, patch: { label?: string; baseUrl?: string; username?: string | null; password?: string; enabled?: boolean }): Promise<void> {
  await fetch(`/api/admin/books/indexers/${id}`, {
    method: 'PUT', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

export async function deleteBookIndexer(id: string): Promise<void> {
  await fetch(`/api/admin/books/indexers/${id}`, { method: 'DELETE', credentials: 'include' })
}

export async function testBookIndexer(id: string): Promise<{ ok: boolean; resultCount?: number; error?: string }> {
  const r = await fetch(`/api/admin/books/indexers/${id}/test`, { method: 'POST', credentials: 'include' })
  return r.json()
}

// ── AI book creation (Phase 1: write a book from scratch) ──────────────────────

export interface BookProjectBrief { premise: string; genre?: string; tone?: string; pov?: string; chapterCount?: number; wordsPerChapter?: number; title?: string }
export interface StoryBibleCharacter { name: string; role: string; traits: string }
export interface StoryBible { premise: string; genre: string; tone: string; pov: string; setting: string; characters: StoryBibleCharacter[]; themes: string[] }
export interface ChapterOutlineEntry { idx: number; title: string; summary: string; targetWords: number }

export type BookProjectStatus =
  | 'drafting_bible' | 'pending_bible_approval' | 'pending_sample' | 'pending_sample_approval'
  | 'generating' | 'pending_reshape_review' | 'completed' | 'failed' | 'cancelled'

export interface BookProject {
  id: string
  mode: 'create' | 'continue' | 'reshape'
  sourceBookId: string | null
  resultBookId: string | null
  title: string | null
  status: BookProjectStatus
  error: string | null
  prompt: BookProjectBrief | null
  storyBible: StoryBible | null
  outline: ChapterOutlineEntry[] | null
  currentChapterIdx: number
  targetChapterCount: number | null
  targetWordsPerChapter: number | null
  createdAt: string
  updatedAt: string
}

export interface BookProjectChapterSummary {
  idx: number
  title: string | null
  wordCount: number | null
  status: 'pending' | 'generating' | 'sample_ready' | 'approved' | 'failed'
  isSample: boolean
  diffStatus: string | null
  hasDraft: boolean
  hasAlternate: boolean
}

export async function createBookProject(brief: BookProjectBrief): Promise<BookProject> {
  const r = await fetch('/api/books/generate/projects', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(brief),
  })
  if (!r.ok) throw new Error('Could not start this book project')
  const d = await r.json() as { project: BookProject }
  return d.project
}

export async function listBookProjects(): Promise<BookProject[]> {
  const r = await fetch('/api/books/generate/projects', { credentials: 'include' })
  if (!r.ok) return []
  const d = await r.json() as { projects?: BookProject[] }
  return d.projects ?? []
}

export async function getBookProject(id: string): Promise<{ project: BookProject; chapters: BookProjectChapterSummary[] } | null> {
  const r = await fetch(`/api/books/generate/projects/${id}`, { credentials: 'include' })
  if (!r.ok) return null
  return r.json()
}

export async function updateBookProjectBible(id: string, patch: { storyBible?: StoryBible; outline?: ChapterOutlineEntry[] }): Promise<void> {
  const r = await fetch(`/api/books/generate/projects/${id}/bible`, {
    method: 'PUT', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!r.ok) throw new Error('Could not save your edits')
}

export async function approveBookProjectBible(id: string): Promise<{ jobId: string | null }> {
  const r = await fetch(`/api/books/generate/projects/${id}/approve-bible`, { method: 'POST', credentials: 'include' })
  if (!r.ok) throw new Error('Could not start writing the sample chapter')
  return r.json()
}

export async function regenerateBookProjectSample(id: string): Promise<{ jobId: string | null }> {
  const r = await fetch(`/api/books/generate/projects/${id}/regenerate-sample`, { method: 'POST', credentials: 'include' })
  if (!r.ok) throw new Error('Could not regenerate the sample chapter')
  return r.json()
}

export async function approveBookProjectSample(id: string): Promise<{ jobId: string | null; committed?: boolean }> {
  const r = await fetch(`/api/books/generate/projects/${id}/approve-sample`, { method: 'POST', credentials: 'include' })
  if (!r.ok) throw new Error('Could not start writing the rest of the book')
  return r.json()
}

export async function rejectBookProject(id: string): Promise<void> {
  const r = await fetch(`/api/books/generate/projects/${id}/reject`, { method: 'POST', credentials: 'include' })
  if (!r.ok) throw new Error('Could not discard this project')
}

export async function deleteBookProject(id: string): Promise<void> {
  await fetch(`/api/books/generate/projects/${id}`, { method: 'DELETE', credentials: 'include' })
}

export interface BookProjectStatusResponse {
  status: BookProjectStatus
  error: string | null
  currentChapterIdx: number
  totalChapters: number
  resultBookId: string | null
  job: { status: string; progress: { completed: number; total: number; note?: string } | null; lastError: string | null } | null
}

export async function getBookProjectStatus(id: string): Promise<BookProjectStatusResponse | null> {
  const r = await fetch(`/api/books/generate/projects/${id}/status`, { credentials: 'include' })
  if (!r.ok) return null
  return r.json()
}

export interface BookProjectChapterDetail {
  idx: number
  title: string | null
  draftText: string | null
  alternateText: string | null
  wordCount: number | null
  status: 'pending' | 'generating' | 'sample_ready' | 'approved' | 'failed'
  isSample: boolean
  diffStatus: string | null
}

export async function getBookProjectChapter(id: string, idx: number): Promise<BookProjectChapterDetail | null> {
  const r = await fetch(`/api/books/generate/projects/${id}/chapters/${idx}`, { credentials: 'include' })
  if (!r.ok) return null
  const d = await r.json() as { chapter: BookProjectChapterDetail }
  return d.chapter
}

/** Where a project's detail route (`/books/generate/:id`) should redirect to given its
 *  current status — lets any entry point (the projects list, a stale bookmark, a refresh
 *  mid-generation) land on the right stage instead of a dead bible-review screen. */
export function stageRouteForProject(project: BookProject): string {
  switch (project.status) {
    case 'pending_sample':
    case 'pending_sample_approval':
      return `/books/generate/${project.id}/sample`
    case 'generating':
      return `/books/generate/${project.id}/progress`
    case 'completed':
      return project.resultBookId ? `/books/detail/${project.resultBookId}` : '/books/generate'
    case 'cancelled':
      return '/books/generate'
    default:
      return `/books/generate/${project.id}/bible`
  }
}
