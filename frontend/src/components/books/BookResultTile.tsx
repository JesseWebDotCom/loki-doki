// Bare storefront tile for a not-yet-added book/audiobook (Gutenberg, Internet
// Archive, or LibriVox search/category result): cover art + title/author only,
// same as BookCard's shape. No description/genre/add-button on the tile itself:
// all of that (and the actual "Add to Library" action) lives on BookPreviewPage,
// which this links to. Browsing shelves show covers; details show on their own page.

import { Link } from 'react-router-dom'
import { BookCover } from './BookCover'
import { LibraryActionButton } from './LibraryActionButton'
import { persistBookPreviewState } from '@/lib/books/previewState'
import type { BookSearchResult } from '@/lib/books/api'

export interface BookResultTileProps {
  id: string
  to: string
  state?: unknown
  title: string
  author?: string | null
  coverSrc?: string | null
  // When provided (a downloadable ebook/magazine result), a Save/Download overlay
  // is shown on the cover so the user can add it without opening the preview page.
  result?: BookSearchResult
}

export function BookResultTile({ id, to, state, title, author, coverSrc, result }: BookResultTileProps) {
  function handleClick() {
    persistBookPreviewState(to, state)
  }

  return (
    <Link to={to} state={state} onClick={handleClick} className="group block">
      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-card shadow-sm transition-shadow group-hover:shadow-lg">
        <BookCover bookId={id} title={title} author={author} coverSrc={coverSrc} fill size={220} className="transition-transform group-hover:scale-[1.02]" />
        {result && <LibraryActionButton result={result} variant="overlay" />}
      </div>
      <div className="mt-2">
        <p className="truncate text-sm font-semibold">{title}</p>
        {author && <p className="truncate text-xs text-muted-foreground">{author}</p>}
      </div>
    </Link>
  )
}
