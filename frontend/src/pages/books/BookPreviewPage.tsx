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
import { ArrowLeft, Plus, Check } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { BookCover } from '@/components/books/BookCover'
import { BookShelf, ShelfSlot } from '@/components/books/BookShelf'
import { BookResultTile } from '@/components/books/BookResultTile'
import { toast } from '@/lib/toast'
import { proxyImg } from '@/lib/img'
import {
  downloadBook, searchBooks, searchLibrivox, addLibrivox,
  type BookSearchResult, type LibrivoxSearchResult,
} from '@/lib/books/api'

type PreviewKind = 'ebook' | 'librivox'
interface PreviewState { kind: PreviewKind; result: BookSearchResult | LibrivoxSearchResult }

const SOURCE_LABEL: Record<BookSearchResult['source'], string> = {
  gutenberg: 'Project Gutenberg',
  archiveorg: 'Internet Archive',
  indexer: 'Your indexer',
}

export function BookPreviewPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const state = location.state as PreviewState | null
  const [adding, setAdding] = useState(false)
  const [added, setAdded] = useState(false)
  const [more, setMore] = useState<(BookSearchResult | LibrivoxSearchResult)[]>([])

  const author = state?.result.author
  const currentId = state && state.kind === 'librivox' ? (state.result as LibrivoxSearchResult).identifier
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
        ? (await addLibrivox((state.result as LibrivoxSearchResult).identifier)).bookId
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
        <p className="text-sm">This preview isn't available directly, go back and open it from a shelf.</p>
        <Button variant="outline" onClick={() => navigate(-1)}><ArrowLeft className="mr-1.5 size-4" />Back</Button>
      </div>
    )
  }

  const r = state.result
  const isLibrivox = state.kind === 'librivox'
  const coverSrc = r.coverUrl ? proxyImg(r.coverUrl) : null
  const meta = isLibrivox
    ? [(r as LibrivoxSearchResult).runtime ? `${(r as LibrivoxSearchResult).runtime} runtime` : null, 'Audiobook']
    : [SOURCE_LABEL[(r as BookSearchResult).source], (r as BookSearchResult).language]

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
              <Button size="lg" disabled={adding || added} onClick={() => void add()}>
                {adding ? <Spinner size="sm" className="mr-2" /> : added ? <Check className="mr-2 size-4" /> : <Plus className="mr-2 size-4" />}
                {added ? 'Added' : `Add to Library`}
              </Button>
            </div>
          </div>
        </div>

        {more.length > 0 && (
          <BookShelf title={`More by ${author}`}>
            {more.map((item) => {
              const key = 'identifier' in item ? item.identifier : `${item.source}:${item.sourceRef}`
              return (
                <ShelfSlot key={key}>
                  <BookResultTile
                    id={key}
                    to={`/books/preview/${isLibrivox ? 'librivox' : 'ebook'}/${encodeURIComponent(key)}`}
                    state={{ kind: isLibrivox ? 'librivox' : 'ebook', result: item } satisfies PreviewState}
                    title={item.title}
                    author={item.author}
                    coverSrc={item.coverUrl ? proxyImg(item.coverUrl) : null}
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
