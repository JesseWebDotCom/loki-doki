export interface BookListItem {
  id: string
  title: string
  author: string | null
  narrator: string | null
  seriesName: string | null
  seriesIndex: number | null
  coverUrl: string | null
  sourceType: string
  libraryStatus: 'pending' | 'downloading' | 'ready' | 'failed'
  hasEbook: boolean
  hasAudio: boolean
  progress: { mode: string; percent: number; completed: boolean } | null
}

export interface BookSearchResult {
  source: 'gutenberg' | 'archiveorg' | 'indexer'
  sourceRef: string
  title: string
  author: string | null
  language: string | null
  coverUrl: string | null
  description?: string | null
  subjects?: string[]
  downloadCount?: number | null
}

export interface GutenbergCategory { label: string; topic: string }
export interface LibrivoxCategory { label: string; subject: string }

export interface BookDetail {
  id: string
  title: string
  author: string | null
  narrator: string | null
  description: string | null
  language: string | null
  coverUrl: string | null
  sourceType: string
  progress: { mode: string; epubCfi: string | null; percent: number; audioPositionSec: number | null; audioChapterIdx: number | null; completed: boolean } | null
  assets: { kind: string; format: string; status: string; error?: string | null }[]
  libraryStatus: 'pending' | 'downloading' | 'ready' | 'failed' | null
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

export async function downloadBook(result: BookSearchResult): Promise<{ bookId: string; jobId: string | null; ready: boolean }> {
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

export async function addLibrivox(identifier: string): Promise<{ bookId: string }> {
  const r = await fetch('/api/books/librivox/add', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
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

export type BuiltinSource = 'gutenberg' | 'archiveorg' | 'librivox'
export interface BuiltinSourceToggles { gutenberg: boolean; archiveorg: boolean; librivox: boolean }
export interface BookIndexer { id: string; label: string; baseUrl: string; username: string | null; hasPassword: boolean; enabled: boolean }

export async function getBookSources(): Promise<{ toggles: BuiltinSourceToggles; indexers: BookIndexer[] }> {
  const r = await fetch('/api/books/sources', { credentials: 'include' })
  if (!r.ok) return { toggles: { gutenberg: true, archiveorg: true, librivox: true }, indexers: [] }
  return r.json()
}

export async function setBookSourceToggle(source: BuiltinSource, enabled: boolean): Promise<void> {
  await fetch('/api/books/sources/toggle', {
    method: 'PUT', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, enabled }),
  })
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
