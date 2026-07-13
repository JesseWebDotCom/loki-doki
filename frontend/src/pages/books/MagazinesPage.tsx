import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { Spinner } from '@/components/ui/spinner'
import { BookSearchCard } from '@/components/books/BookSearchCard'
import { BookResultTile } from '@/components/books/BookResultTile'
import { BookShelf, ShelfSlot } from '@/components/books/BookShelf'
import { proxyImg } from '@/lib/img'
import {
  browseAllMagazineCategories, searchBookCatalog,
  type BookSearchResult,
} from '@/lib/books/api'
import { publishedLabel } from '@/lib/books/format'

const SOURCE_LABEL: Record<BookSearchResult['source'], string> = {
  archiveorg: 'Internet Archive', gutenberg: 'Project Gutenberg', indexer: 'Indexer',
  wikisource: 'Wikisource', googlebooks: 'Google Books', openlibrary: 'Open Library',
  standardebooks: 'Standard Ebooks',
}

function resultKey(r: BookSearchResult): string {
  return `${r.source}:${r.sourceRef}`
}

function previewLink(r: BookSearchResult) {
  const key = resultKey(r)
  return { to: `/books/preview/ebook/${encodeURIComponent(key)}`, state: { kind: 'ebook' as const, result: r } }
}

export function MagazinesPage() {
  const [params] = useSearchParams()
  const query = params.get('q') ?? ''
  const [results, setResults] = useState<BookSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  // React Query so navigating away and back is instant (in-memory + IDB-persisted),
  // and the slow first fan-out to remote sources only happens once per stale window.
  const { data: shelves = null } = useQuery({
    // v2: cache-busted when results gained publish dates (IDB-persisted queries
    // would otherwise show the old date-less payload for up to the stale window).
    queryKey: ['books-magazine-shelves-v2'],
    queryFn: browseAllMagazineCategories,
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
  })

  useEffect(() => {
    if (!query) { setResults([]); return }
    let cancelled = false
    setSearching(true)
    void searchBookCatalog(query).then((r) => {
      if (cancelled) return
      setResults(r.ebooks.filter((item) => item.contentType === 'magazine'))
      setSearching(false)
    })
    return () => { cancelled = true }
  }, [query])

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer width="wide" className="space-y-9 py-6 pb-24">
        <PageHeader title="Magazine Store" subtitle="Magazines, journals, comics, and periodicals from enabled sources." className="pt-0 pb-0" />

        {query ? (
          searching ? (
            <div className="flex justify-center py-16"><Spinner size="lg" /></div>
          ) : results.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">No magazine results for "{query}".</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {results.map((r) => {
                const key = resultKey(r)
                const link = previewLink(r)
                return (
                  <BookSearchCard
                    key={key}
                    id={key}
                    to={link.to}
                    state={link.state}
                    title={r.title}
                    author={r.author}
                    description={r.description ?? null}
                    coverSrc={r.coverUrl ? proxyImg(r.coverUrl) : null}
                    mediaType="ebook"
                    sourceLabel={SOURCE_LABEL[r.source]}
                    formats={r.formats ?? ['EPUB']}
                    sizeBytes={r.sizeBytes ?? null}
                    publishedYear={r.publishedYear}
                    contentLabel="Magazine"
                    result={r}
                  />
                )
              })}
            </div>
          )
        ) : shelves === null ? (
          <div className="flex justify-center py-16"><Spinner size="lg" /></div>
        ) : (
          <>
            {shelves.filter((s) => s.results.length > 0).map((shelf) => (
              <BookShelf key={shelf.category.topic} title={shelf.category.label} to={`/books/category/magazine/${encodeURIComponent(shelf.category.topic)}`}>
                {shelf.results.map((r) => {
                  const key = resultKey(r)
                  const link = previewLink(r)
                  return (
                    <ShelfSlot key={key}>
                      <BookResultTile id={key} to={link.to} state={link.state} title={r.title} author={r.author} caption={publishedLabel(r)} coverSrc={r.coverUrl ? proxyImg(r.coverUrl) : null} result={r} />
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
