// "View by category": the full list behind a Book Store / Audiobook Store /
// Magazine Store shelf's title (a shelf only ever shows 12 as a preview). One
// page for all kinds since the layout is identical; only which fetch function
// and preview route to use differs. Magazine categories and the visual shelves
// (Comics/Manga/Children's/Coloring) page through Internet Archive results via
// "Show more"; the other kinds return one fixed batch.

import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { Link } from 'react-router-dom'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { BookResultTile } from '@/components/books/BookResultTile'
import { proxyImg } from '@/lib/img'
import {
  browseGutenbergCategoryFull, browseLibrivoxCategoryFull, browseMagazineCategoryFull, browseVisualBooksFull,
  type BookContentType, type BookSearchResult, type LibrivoxSearchResult,
} from '@/lib/books/api'
import { publishedLabel } from '@/lib/books/format'
import { GUTENBERG_CATEGORY_LABELS, LIBRIVOX_CATEGORY_LABELS, MAGAZINE_CATEGORY_LABELS } from '@/lib/books/categories'

type Kind = 'ebook' | 'audiobook' | 'magazine' | 'visual'
type AnyResult = BookSearchResult | LibrivoxSearchResult
type VisualKey = Exclude<BookContentType, 'book'>

const VISUAL_LABELS: Record<string, string> = {
  magazine: 'Magazines', comic: 'Comics', manga: 'Manga', coloring_book: 'Coloring Books', children: "Children's Books",
}

function idOf(r: AnyResult): string {
  return 'identifier' in r ? r.identifier : `${r.source}:${r.sourceRef}`
}

export function BookCategoryPage() {
  const { kind = 'ebook', key = '' } = useParams<{ kind: Kind; key: string }>()
  const paged = kind === 'magazine' || kind === 'visual'
  const [results, setResults] = useState<AnyResult[] | null>(null)
  const [page, setPage] = useState(1)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)

  const fetchPage = (p: number): Promise<AnyResult[]> =>
    kind === 'audiobook'
      ? browseLibrivoxCategoryFull(key)
      : kind === 'magazine'
        ? browseMagazineCategoryFull(key, p)
        : kind === 'visual'
          ? browseVisualBooksFull(key as VisualKey, p)
          : browseGutenbergCategoryFull(key)

  useEffect(() => {
    setResults(null)
    setPage(1)
    setHasMore(paged)
    void fetchPage(1).then(setResults)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, key])

  const loadMore = async () => {
    setLoadingMore(true)
    try {
      const next = await fetchPage(page + 1)
      setPage(page + 1)
      setResults((prev) => {
        const seen = new Set((prev ?? []).map(idOf))
        const fresh = next.filter((r) => !seen.has(idOf(r)))
        if (!fresh.length) setHasMore(false)
        return [...(prev ?? []), ...fresh]
      })
    } finally {
      setLoadingMore(false)
    }
  }

  const label = (kind === 'audiobook'
    ? LIBRIVOX_CATEGORY_LABELS
    : kind === 'magazine'
      ? MAGAZINE_CATEGORY_LABELS
      : kind === 'visual'
        ? VISUAL_LABELS
        : GUTENBERG_CATEGORY_LABELS)[key] ?? key

  const backTo = kind === 'audiobook' ? '/books/audiobooks' : kind === 'magazine' ? '/books/magazines' : '/books'
  const backLabel = kind === 'audiobook' ? 'Audiobook Store' : kind === 'magazine' ? 'Magazine Store' : 'Book Store'

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer width="wide" className="pb-16">
        <Link to={backTo} className="mt-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" />{backLabel}
        </Link>

        <PageHeader
          title={label}
          eyebrow="Books"
          subtitle={kind === 'audiobook' ? 'Audiobooks from LibriVox.'
            : kind === 'magazine' ? 'Magazines and periodicals from enabled sources.'
              : kind === 'visual' ? `${label} from enabled sources.`
                : 'Books from Project Gutenberg.'}
        />

        {results === null ? (
          <div className="flex justify-center py-16"><Spinner size="lg" /></div>
        ) : results.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">No results in this category right now.</p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
              {results.map((r) => {
                const id = idOf(r)
                const previewKind = 'identifier' in r ? 'librivox' : 'ebook'
                return (
                  <BookResultTile
                    key={id}
                    id={id}
                    to={`/books/preview/${previewKind}/${encodeURIComponent(id)}`}
                    state={{ kind: previewKind, result: r }}
                    title={r.title}
                    author={r.author}
                    caption={kind === 'magazine' && previewKind === 'ebook' ? publishedLabel(r as BookSearchResult) : null}
                    coverSrc={r.coverUrl ? proxyImg(r.coverUrl) : null}
                    result={previewKind === 'ebook' ? (r as BookSearchResult) : undefined}
                  />
                )
              })}
            </div>
            {paged && hasMore && (
              <div className="mt-8 flex justify-center">
                <Button variant="outline" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore && <Spinner size="sm" className="mr-1.5" />}Show more
                </Button>
              </div>
            )}
          </>
        )}
      </PageContainer>
    </div>
  )
}
