import type { BookSearchResult, LibrivoxSearchResult } from '@/lib/books/api'

export type BookPreviewState =
  | { kind: 'ebook'; result: BookSearchResult }
  | { kind: 'librivox'; result: LibrivoxSearchResult }

const PREVIEW_PREFIX = 'loki-books-preview:'

function storageKey(pathname: string): string {
  return `${PREVIEW_PREFIX}${pathname}`
}

function normalizePath(to: string): string | null {
  try {
    return new URL(to, window.location.origin).pathname
  } catch {
    return null
  }
}

export function persistBookPreviewState(to: string, state: unknown): void {
  if (typeof window === 'undefined' || !state) return
  const pathname = normalizePath(to)
  if (!pathname || !pathname.startsWith('/books/preview/')) return
  try {
    window.sessionStorage.setItem(storageKey(pathname), JSON.stringify(state))
  } catch {
    // Session storage is best-effort only.
  }
}

export function readBookPreviewState(pathname: string): BookPreviewState | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(storageKey(pathname))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<BookPreviewState> | null
    if (!parsed || (parsed.kind !== 'ebook' && parsed.kind !== 'librivox')) return null
    if (!parsed.result || typeof parsed.result !== 'object') return null
    if (parsed.kind === 'ebook') {
      const result = parsed.result as Partial<{ source: string; previewId?: string | null }>
      if (result.source === 'openlibrary' && !result.previewId) return null
    }
    return parsed as BookPreviewState
  } catch {
    return null
  }
}
