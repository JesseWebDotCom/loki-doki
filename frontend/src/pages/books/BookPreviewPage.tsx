// The "product page" for a book/audiobook NOT yet in the library, a Discover/
// Audiobook-Store shelf tile links here instead of adding inline, so all the
// detail (description, genre, format, length) that used to clutter the browsing
// tiles lives on one page, matching BookDetailPage's shape for an already-owned
// book. Sourced from router state (the search/category result the tile already
// had in hand, no extra fetch for the common click-through path); a direct link
// or refresh with no state falls back to "go back and browse" since there's no
// stable single-item lookup for an un-added Gutenberg/LibriVox/IA result yet.

import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, Check, Eye, Plus } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { BookCover } from '@/components/books/BookCover'
import { BookShelf, ShelfSlot } from '@/components/books/BookShelf'
import { BookResultTile } from '@/components/books/BookResultTile'
import { GoogleBooksPreview } from '@/components/books/GoogleBooksPreview'
import { ArchiveBookPreview } from '@/components/books/ArchiveBookPreview'
import { BookTextPreview } from '@/components/books/BookTextPreview'
import { LibraryActionButton } from '@/components/books/LibraryActionButton'
import { toast } from '@/lib/toast'
import { proxyImg } from '@/lib/img'
import {
  downloadBook, searchBooks, searchLibrivox, addLibrivox,
  type BookSearchResult, type LibrivoxSearchResult,
} from '@/lib/books/api'
import { readBookPreviewState, type BookPreviewState } from '@/lib/books/previewState'

const CONTENT_LABEL = { book: 'Book', magazine: 'Magazine', children: "Children's Book", comic: 'Comic', manga: 'Manga', coloring_book: 'Coloring Book' } as const

const SOURCE_LABEL: Record<BookSearchResult['source'], string> = {
  gutenberg: 'Project Gutenberg',
  archiveorg: 'Internet Archive',
  indexer: 'Your indexer',
  wikisource: 'Wikisource',
  googlebooks: 'Google Books',
  openlibrary: 'Open Library',
}

export function BookPreviewPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const [state, setState] = useState<BookPreviewState | null>(() => (
    (location.state as BookPreviewState | null) ?? readBookPreviewState(location.pathname)
  ))
  const [adding, setAdding] = useState(false)
  const [added, setAdded] = useState(false)
  const [more, setMore] = useState<(BookSearchResult | LibrivoxSearchResult)[]>([])

  useEffect(() => {
    const nextState = (location.state as BookPreviewState | null) ?? readBookPreviewState(location.pathname)
    setState(nextState)
  }, [location.pathname, location.state])

  const author = state?.result.author
  const currentId = state && state.kind === 'librivox'
    ? (state.result as LibrivoxSearchResult).identifier
    : state ? `${(state.result as BookSearchResult).source}:${(state.result as BookSearchResult).sourceRef}` : null

  useEffect(() => {
    if (!state || !author) return
    let cancelled = false
    void (state.kind === 'librivox' ? searchLibrivox(author) : searchBooks(author)).then((results) => {
      if (cancelled) return
      const key = (r: BookSearchResult | LibrivoxSearchResult) =>
        'identifier' in r ? r.identifier : `${r.source}:${r.sourceRef}`
      setMore(results.filter((r) => key(r) !== currentId).slice(0, 8))
    })
    return () => { cancelled = true }
  }, [state, author, currentId])

  const add = useCallback(async () => {
    if (!state) return
    setAdding(true)
    try {
      const bookId = state.kind === 'librivox'
        ? (await addLibrivox((state.result as LibrivoxSearchResult).identifier, state.result.publishedYear)).bookId
        : (await downloadBook(state.result as BookSearchResult)).bookId
      setAdded(true)
      toast.success('Added to your library')
      navigate(`/books/detail/${bookId}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add this item')
    } finally {
      setAdding(false)
    }
  }, [state, navigate])

  if (!state) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
        <p className="text-sm">This preview needs the item state from a shelf click, refresh the shelf and open it again.</p>
        <Button variant="outline" onClick={() => navigate(-1)}><ArrowLeft className="mr-1.5 size-4" />Back</Button>
      </div>
    )
  }

  const r = state.result
  const isLibrivox = state.kind === 'librivox'
  const isGoogleBooks = !isLibrivox && (r as BookSearchResult).source === 'googlebooks'
  const googlePreviewId = isGoogleBooks ? (r as BookSearchResult).previewId : undefined
  const isOpenLibrary = !isLibrivox && (r as BookSearchResult).source === 'openlibrary'
  const openLibraryPreviewId = isOpenLibrary ? (r as BookSearchResult).previewId : undefined
  const archivePreviewId = !isLibrivox && (r as BookSearchResult).source === 'archiveorg'
    ? (r as BookSearchResult).sourceRef : undefined
  // Gutenberg / Standard Ebooks have no embeddable reader, so we render a server-fetched text sample instead.
  const textPreviewSource = !isLibrivox && ['gutenberg', 'standardebooks'].includes((r as BookSearchResult).source)
    ? (r as BookSearchResult).source : undefined
  const coverSrc = r.coverUrl ? proxyImg(r.coverUrl) : null
  const meta = isLibrivox
    ? [(r as LibrivoxSearchResult).runtime ? `${(r as LibrivoxSearchResult).runtime} runtime` : null, 'Audiobook', r.publishedYear]
    : [SOURCE_LABEL[(r as BookSearchResult).source], CONTENT_LABEL[(r as BookSearchResult).contentType ?? 'book'],
        ...((r as BookSearchResult).formats ?? []), (r as BookSearchResult).pageCount ? `${(r as BookSearchResult).pageCount} pages` : null,
        (r as BookSearchResult).language, r.publishedYear]

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer width="wide" className="space-y-9 pb-24">
        <Button variant="ghost" className="mt-4" onClick={() => navigate(-1)}>
          <ArrowLeft className="mr-1.5 size-4" />Back
        </Button>

        <div className="flex flex-col gap-8 sm:flex-row">
          <div className="mx-auto w-48 shrink-0 sm:mx-0 sm:w-56">
            <div className="aspect-[2/3] overflow-hidden rounded-card shadow-lg">
              <BookCover bookId={currentId ?? r.title} title={r.title} author={r.author} coverSrc={coverSrc} fill size={320} />
            </div>
          </div>

          <div className="min-w-0 flex-1">
            {/* design-ok(raw-h1-in-pages): custom two-column product hero, PageHeader's icon-tile layout doesn't fit */}
            <h1 className="text-display">{r.title}</h1>
            {r.author && <p className="mt-1 text-lg text-muted-foreground">{r.author}</p>}

            <div className="mt-3 flex flex-wrap gap-2">
              {meta.filter(Boolean).map((m) => (
                <span key={m} className="rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-muted-foreground">{m}</span>
              ))}
              {!isLibrivox && !!(r as BookSearchResult).subjects?.length && (r as BookSearchResult).subjects!.slice(0, 3).map((s) => (
                <span key={s} className="rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-muted-foreground">{s}</span>
              ))}
              {isLibrivox && !!(r as LibrivoxSearchResult).subjects?.length && (r as LibrivoxSearchResult).subjects!.slice(0, 3).map((s) => (
                <span key={s} className="rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-muted-foreground">{s}</span>
              ))}
            </div>

            {r.description && (
              <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">{r.description}</p>
            )}

            <div className="mt-6">
              {isGoogleBooks ? (
                <Button size="lg" asChild><a href="#book-sample"><Eye className="mr-2 size-4" />Read sample</a></Button>
              ) : isOpenLibrary ? (
                <Button size="lg" asChild><a href="#book-sample"><Eye className="mr-2 size-4" />Preview</a></Button>
              ) : isLibrivox ? (
                <Button size="lg" disabled={adding || added} onClick={() => void add()}>
                  {adding ? <Spinner size="sm" className="mr-2" /> : added ? <Check className="mr-2 size-4" /> : <Plus className="mr-2 size-4" />}
                  {added ? 'Added' : 'Add to Library'}
                </Button>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  {(archivePreviewId || textPreviewSource) && <Button size="lg" variant="outline" asChild><a href="#book-sample"><Eye className="mr-2 size-4" />Preview</a></Button>}
                  <LibraryActionButton result={r as BookSearchResult} variant="inline" />
                </div>
              )}
            </div>
          </div>
        </div>

        {googlePreviewId && (
          <div id="book-sample"><GoogleBooksPreview volumeId={googlePreviewId} title={r.title} /></div>
        )}
        {archivePreviewId && (
          <div id="book-sample"><ArchiveBookPreview identifier={archivePreviewId} title={r.title} /></div>
        )}
        {openLibraryPreviewId && (
          <div id="book-sample"><ArchiveBookPreview identifier={openLibraryPreviewId} title={r.title} /></div>
        )}
        {textPreviewSource && (
          <div id="book-sample"><BookTextPreview source={textPreviewSource} sourceRef={(r as BookSearchResult).sourceRef} title={r.title} /></div>
        )}

        {more.length > 0 && (
          <BookShelf title={`More by ${author}`}>
            {more.map((item) => {
              const key = 'identifier' in item ? item.identifier : `${item.source}:${item.sourceRef}`
              return (
                <ShelfSlot key={key}>
                  <BookResultTile
                    id={key}
                    to={`/books/preview/${isLibrivox ? 'librivox' : 'ebook'}/${encodeURIComponent(key)}`}
                    state={(isLibrivox
                      ? { kind: 'librivox', result: item as LibrivoxSearchResult }
                      : { kind: 'ebook', result: item as BookSearchResult }) satisfies BookPreviewState}
                    title={item.title}
                    author={item.author}
                    coverSrc={item.coverUrl ? proxyImg(item.coverUrl) : null}
                    result={isLibrivox ? undefined : (item as BookSearchResult)}
                  />
                </ShelfSlot>
              )
            })}
          </BookShelf>
        )}
      </PageContainer>
    </div>
  )
}
