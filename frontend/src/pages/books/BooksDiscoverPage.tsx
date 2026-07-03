// The Book Store: curated genre shelves (Gutenberg bookshelves via /categories,
// see backend/src/lib/books/gutenberg.ts) on landing, replaced by a single results
// grid when a search is active. Search itself lives in the app-wide breadcrumb bar
// (BooksLayout's useAppHeader, submits to /books?q=...), not a second input on this
// page: it just reads the `q` param, matching Music's Browse page pattern.
// Tiles are bare cover art, no inline description/add button: tapping one opens
// BookPreviewPage, which is where all the detail (and the actual "Add to Library"
// action) lives. All 10 genre shelves load in ONE request (browseAllGutenbergCategories,
// server-fetched in parallel and cached per topic) instead of one request per
// shelf. Search fans out to Project Gutenberg + Internet Archive (public-domain
// only). Standard Ebooks isn't included: their catalog requires an authenticated
// account, so there's no keyless way to search it (see backend/src/lib/books/search.ts).
// A self-hosted OPDS indexer (Admin > Integrations > Books) fans in as a third
// source when configured.

import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { Spinner } from '@/components/ui/spinner'
import { BookResultTile } from '@/components/books/BookResultTile'
import { BookShelf, ShelfSlot } from '@/components/books/BookShelf'
import { proxyImg } from '@/lib/img'
import {
  searchBooks, browseAllGutenbergCategories,
  type BookSearchResult, type GutenbergShelf,
} from '@/lib/books/api'

function resultKey(r: BookSearchResult): string {
  return `${r.source}:${r.sourceRef}`
}

function previewLink(r: BookSearchResult) {
  const key = resultKey(r)
  return { to: `/books/preview/ebook/${encodeURIComponent(key)}`, state: { kind: 'ebook' as const, result: r } }
}

export function BooksDiscoverPage() {
  const [params] = useSearchParams()
  const query = params.get('q') ?? ''
  const [results, setResults] = useState<BookSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [shelves, setShelves] = useState<GutenbergShelf[] | null>(null)

  useEffect(() => { void browseAllGutenbergCategories().then(setShelves) }, [])

  useEffect(() => {
    if (!query) { setResults([]); return }
    let cancelled = false
    setSearching(true)
    void searchBooks(query).then((r) => { if (!cancelled) { setResults(r); setSearching(false) } })
    return () => { cancelled = true }
  }, [query])

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer width="wide" className="space-y-9 py-6 pb-24">
        <PageHeader title="Book Store" subtitle="Public-domain books from Project Gutenberg and the Internet Archive." className="pt-0 pb-0" />

        {query ? (
          searching ? (
            <div className="flex justify-center py-16"><Spinner size="lg" /></div>
          ) : results.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">No public-domain results for "{query}".</p>
          ) : (
            <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
              {results.map((r) => {
                const key = resultKey(r)
                const link = previewLink(r)
                return (
                  <BookResultTile key={key} id={key} to={link.to} state={link.state} title={r.title} author={r.author} coverSrc={r.coverUrl ? proxyImg(r.coverUrl) : null} />
                )
              })}
            </div>
          )
        ) : shelves === null ? (
          <div className="flex justify-center py-16"><Spinner size="lg" /></div>
        ) : (
          shelves.filter((s) => s.results.length > 0).map((shelf) => (
            <BookShelf key={shelf.category.topic} title={shelf.category.label}>
              {shelf.results.map((r) => {
                const key = resultKey(r)
                const link = previewLink(r)
                return (
                  <ShelfSlot key={key}>
                    <BookResultTile id={key} to={link.to} state={link.state} title={r.title} author={r.author} coverSrc={r.coverUrl ? proxyImg(r.coverUrl) : null} />
                  </ShelfSlot>
                )
              })}
            </BookShelf>
          ))
        )}
      </PageContainer>
    </div>
  )
}
