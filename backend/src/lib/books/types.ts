export interface BookSearchResult {
  source: 'gutenberg' | 'archiveorg' | 'standardebooks' | 'indexer' | 'wikisource' | 'googlebooks' | 'openlibrary'
  sourceRef: string
  title: string
  author: string | null
  language: string | null
  coverUrl: string | null
  description?: string | null
  /** Genre/category tags — Gutenberg's curated bookshelves, IA's subject field. */
  subjects?: string[]
  /** Gutenberg download count, used as a popularity signal (its API has no page-count field). */
  downloadCount?: number | null
  /** Media information exposed by the source. Search results only advertise
   * formats the Books app can read or play. */
  mediaType?: 'ebook'
  formats?: string[]
  sizeBytes?: number | null
  publishedYear?: number | null
  contentType?: BookContentType
  downloadFormat?: DownloadableBookFormat
  previewId?: string
  previewAvailable?: boolean
  pageCount?: number | null
  publishedDate?: string | null
  externalUrl?: string
}

export type BookContentType = 'book' | 'magazine' | 'children' | 'comic' | 'manga' | 'coloring_book'
export type DownloadableBookFormat = 'epub' | 'pdf' | 'cbz'

export interface GutenbergCategory {
  label: string
  topic: string
}

/** Curated genre shelves for the Book Store — Gutendex's `topic` filter matches
 *  against both `subjects` and `bookshelves` substrings. Each entry verified live
 *  to return a real, non-trivial result count before being added. */
export const GUTENBERG_CATEGORIES: GutenbergCategory[] = [
  { label: 'Classics', topic: 'classic' },
  { label: 'Mystery & Detective', topic: 'mystery' },
  { label: 'Science Fiction', topic: 'science fiction' },
  { label: 'Fantasy', topic: 'fantasy' },
  { label: 'Romance', topic: 'romance' },
  { label: 'Horror & Gothic', topic: 'horror' },
  { label: 'Adventure', topic: 'adventure' },
  { label: 'Drama & Plays', topic: 'drama' },
  { label: 'History', topic: 'history' },
  { label: 'Biography & Memoir', topic: 'biography' },
  { label: 'Philosophy', topic: 'philosophy' },
  { label: 'Poetry', topic: 'poetry' },
  { label: 'Essays', topic: 'essays' },
  { label: 'Humor', topic: 'humor' },
  { label: 'Travel & Exploration', topic: 'travel' },
  { label: 'Fairy Tales & Folklore', topic: 'fairy tales' },
  { label: "Children's Literature", topic: 'children' },
]

export interface ResolvedDownload {
  url: string
  format: DownloadableBookFormat
  /** Extra request headers needed to fetch the file (e.g. Basic auth for a
   *  self-hosted OPDS indexer). Undefined for keyless public sources. */
  headers?: Record<string, string>
}
