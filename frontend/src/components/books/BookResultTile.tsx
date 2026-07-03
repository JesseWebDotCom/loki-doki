// Bare storefront tile for a not-yet-added book/audiobook (Gutenberg, Internet
// Archive, or LibriVox search/category result): cover art + title/author only,
// same as BookCard's shape. No description/genre/add-button on the tile itself:
// all of that (and the actual "Add to Library" action) lives on BookPreviewPage,
// which this links to. Browsing shelves show covers; details show on their own page.

import { Link } from 'react-router-dom'
import { BookCover } from './BookCover'

export interface BookResultTileProps {
  id: string
  to: string
  state?: unknown
  title: string
  author?: string | null
  coverSrc?: string | null
}

export function BookResultTile({ id, to, state, title, author, coverSrc }: BookResultTileProps) {
  return (
    <Link to={to} state={state} className="group block">
      <div className="aspect-[2/3] w-full overflow-hidden rounded-card shadow-sm transition-shadow group-hover:shadow-lg">
        <BookCover bookId={id} title={title} author={author} coverSrc={coverSrc} fill size={220} className="transition-transform group-hover:scale-[1.02]" />
      </div>
      <div className="mt-2">
        <p className="truncate text-sm font-semibold">{title}</p>
        {author && <p className="truncate text-xs text-muted-foreground">{author}</p>}
      </div>
    </Link>
  )
}
