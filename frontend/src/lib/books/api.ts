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
