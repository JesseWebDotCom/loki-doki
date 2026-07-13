// The Book Store: curated genre shelves (Gutenberg bookshelves via /categories,
// see backend/src/lib/books/gutenberg.ts) on landing, replaced by a single results
// grid when a search is active. Search itself lives in the app-wide breadcrumb bar
// (BooksLayout's useAppHeader, submits to /books?q=...), not a second input on this
// page: it just reads the `q` param, matching Music's Browse page pattern.
// Tiles are bare cover art, no inline description/add button: tapping one opens
// BookPreviewPage, which is where all the detail (and the actual "Add to Library"
// action) lives. All 10 genre shelves load in ONE request (browseAllGutenbergCategories,
// server-fetched in parallel and cached per topic) instead of one request per
// shelf. Search fans out across the enabled catalogs. Standard Ebooks isn't
// included in search: their full catalog feed now
// requires an authenticated account, so there's no keyless way to search it (see
// backend/src/lib/books/standardEbooks.ts), but their public "New Releases" feed
// (no auth) still gets its own browse-only shelf below, the one place their
// catalog shows up. A self-hosted OPDS indexer (Admin > Integrations > Books)
// fans into search as a third source when configured.

import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { BookOpen } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { ArtBillboard, type ArtBillboardItem } from '@/components/shared/ArtBillboard'
import { Spinner } from '@/components/ui/spinner'
import { BookResultTile } from '@/components/books/BookResultTile'
import { BookSearchCard } from '@/components/books/BookSearchCard'
import { BookShelf, ShelfSlot } from '@/components/books/BookShelf'
import { proxyImg } from '@/lib/img'
import {
  searchBookCatalog, browseAllGutenbergCategories, browseVisualBookShelves, getStandardEbooksNewReleases,
  type BookCatalogSearch, type BookContentType, type BookSearchResult, type GutenbergShelf, type VisualBookShelf,
} from '@/lib/books/api'

const CONTENT_LABEL: Record<BookContentType, string> = {
  book: 'Book', magazine: 'Magazine', children: "Children's", comic: 'Comic', manga: 'Manga', coloring_book: 'Coloring Book',
}

const SOURCE_LABEL: Record<BookSearchResult['source'], string> = {
  archiveorg: 'Internet Archive', gutenberg: 'Project Gutenberg', indexer: 'Indexer',
  wikisource: 'Wikisource', googlebooks: 'Google Books', openlibrary: 'Open Library',
}

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
  const [results, setResults] = useState<BookCatalogSearch>({ ebooks: [], audiobooks: [], web: [] })
  const [searching, setSearching] = useState(false)
  const [shelves, setShelves] = useState<GutenbergShelf[] | null>(null)
  const [newReleases, setNewReleases] = useState<BookSearchResult[]>([])
  const [visualShelves, setVisualShelves] = useState<VisualBookShelf[]>([])
  const bookResults = results.ebooks.filter((r) => r.contentType !== 'magazine')
  const bookShelves = visualShelves.filter((shelf) => shelf.key !== 'magazine')

  useEffect(() => { void browseAllGutenbergCategories().then(setShelves) }, [])
  useEffect(() => { void getStandardEbooksNewReleases().then(setNewReleases) }, [])
  useEffect(() => { void browseVisualBookShelves().then(setVisualShelves) }, [])

  useEffect(() => {
    if (!query) { setResults({ ebooks: [], audiobooks: [], web: [] }); return }
    let cancelled = false
    setSearching(true)
    void searchBookCatalog(query).then((r) => { if (!cancelled) { setResults(r); setSearching(false) } })
    return () => { cancelled = true }
  }, [query])

  return (
    <div className="h-full overflow-y-auto">
      {/* No PageHeader: the rail states where we are and the billboard is the focal point. */}
      <PageContainer width="wide" className="space-y-9 py-6 pb-24">
        {query ? (
          searching ? (
            <div className="flex justify-center py-16"><Spinner size="lg" /></div>
          ) : bookResults.length + results.audiobooks.length + results.web.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">No results for "{query}".</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {bookResults.map((r) => {
                const key = resultKey(r)
                const link = previewLink(r)
                return (
                  <BookSearchCard key={key} id={key} to={link.to} state={link.state} title={r.title} author={r.author}
                    description={r.description ?? null} coverSrc={r.coverUrl ? proxyImg(r.coverUrl) : null}
                    mediaType="ebook" sourceLabel={SOURCE_LABEL[r.source]}
                    formats={r.formats ?? ['EPUB']} sizeBytes={r.sizeBytes ?? null} publishedYear={r.publishedYear}
                    contentLabel={CONTENT_LABEL[r.contentType ?? 'book']} result={r} />
                )
              })}
              {results.audiobooks.map((r) => (
                <BookSearchCard key={r.identifier} id={r.identifier} to={`/books/preview/librivox/${encodeURIComponent(r.identifier)}`}
                  state={{ kind: 'librivox' as const, result: r }} title={r.title} author={r.author}
                  description={r.description ?? null} coverSrc={r.coverUrl ? proxyImg(r.coverUrl) : null}
                  mediaType="audiobook" sourceLabel="Internet Archive / LibriVox" formats={r.formats ?? ['MP3']} sizeBytes={r.sizeBytes ?? null} publishedYear={r.publishedYear} />
              ))}
              {results.web.map((r) => (
                <BookSearchCard key={r.sourceRef} id={r.sourceRef} title={r.title} author={null} description={r.description}
                  coverSrc={null} mediaType={r.mediaType} sourceLabel={`Web: ${r.siteName}`} formats={r.formats}
                  sizeBytes={r.sizeBytes} externalUrl={r.externalUrl} />
              ))}
            </div>
          )
        ) : shelves === null ? (
          <div className="flex justify-center py-16"><Spinner size="lg" /></div>
        ) : (
          <>
            {/* Featured billboard: top covers of the first stocked genre shelf. */}
            {(() => {
              const featured = shelves.find((sh) => sh.results.some((r) => r.coverUrl))
              if (!featured) return null
              const items = featured.results.filter((r) => r.coverUrl).slice(0, 5).map((r): ArtBillboardItem => {
                const link = previewLink(r)
                return {
                  key: resultKey(r),
                  title: r.title,
                  subtitle: r.author,
                  art: r.coverUrl ? proxyImg(r.coverUrl) : null,
                  to: link.to,
                  state: link.state,
                  pillLabel: 'Preview',
                  PillIcon: BookOpen,
                }
              })
              return <ArtBillboard items={items} eyebrow={featured.category.label} />
            })()}
            {bookShelves.map((shelf) => (
              <BookShelf key={shelf.key} title={shelf.label}
                empty={shelf.results.length === 0 ? `No ${shelf.label.toLowerCase()} are available from enabled sources right now.` : undefined}>
                {shelf.results.map((r) => {
                  const key = resultKey(r)
                  const link = previewLink(r)
                  return (
                    <ShelfSlot key={key}>
                      <BookResultTile id={key} to={link.to} state={link.state} title={r.title} author={r.author} coverSrc={r.coverUrl ? proxyImg(r.coverUrl) : null} result={r} />
                  </ShelfSlot>
                )
              })}
              </BookShelf>
            ))}
            {newReleases.length > 0 && (
              <BookShelf title="New from Standard Ebooks">
                {newReleases.map((r) => {
                  const key = resultKey(r)
                  const link = previewLink(r)
                  return (
                    <ShelfSlot key={key}>
                      <BookResultTile id={key} to={link.to} state={link.state} title={r.title} author={r.author} coverSrc={r.coverUrl ? proxyImg(r.coverUrl) : null} result={r} />
                    </ShelfSlot>
                  )
                })}
              </BookShelf>
            )}
            {shelves.filter((s) => s.results.length > 0).map((shelf) => (
            <BookShelf key={shelf.category.topic} title={shelf.category.label} to={`/books/category/ebook/${encodeURIComponent(shelf.category.topic)}`}>
              {shelf.results.map((r) => {
                const key = resultKey(r)
                const link = previewLink(r)
                return (
                  <ShelfSlot key={key}>
                    <BookResultTile id={key} to={link.to} state={link.state} title={r.title} author={r.author} coverSrc={r.coverUrl ? proxyImg(r.coverUrl) : null} result={r} />
                  </ShelfSlot>
                )
              })}
            </BookShelf>
            ))}
          </>
        )}
      </PageContainer>
    </div>
  )
}
