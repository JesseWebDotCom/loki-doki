export interface BookSearchResult {
  source: 'gutenberg' | 'archiveorg' | 'standardebooks' | 'indexer'
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
}

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
  format: 'epub'
  /** Extra request headers needed to fetch the file (e.g. Basic auth for a
   *  self-hosted OPDS indexer). Undefined for keyless public sources. */
  headers?: Record<string, string>
}
