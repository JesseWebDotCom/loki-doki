// "View by category": the full list behind a Book Store / Audiobook Store
// shelf's title (a shelf only ever shows 12 as a preview). One page for both
// kinds since the layout is identical; only which fetch function/preview route
// to use differs.

import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { Link } from 'react-router-dom'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { Spinner } from '@/components/ui/spinner'
import { BookResultTile } from '@/components/books/BookResultTile'
import { proxyImg } from '@/lib/img'
import {
  browseGutenbergCategoryFull, browseLibrivoxCategoryFull,
  type BookSearchResult, type LibrivoxSearchResult,
} from '@/lib/books/api'
import { GUTENBERG_CATEGORY_LABELS, LIBRIVOX_CATEGORY_LABELS } from '@/lib/books/categories'

type Kind = 'ebook' | 'audiobook'

export function BookCategoryPage() {
  const { kind = 'ebook', key = '' } = useParams<{ kind: Kind; key: string }>()
  const isAudiobook = kind === 'audiobook'
  const [results, setResults] = useState<(BookSearchResult | LibrivoxSearchResult)[] | null>(null)

  useEffect(() => {
    setResults(null)
    void (isAudiobook ? browseLibrivoxCategoryFull(key) : browseGutenbergCategoryFull(key)).then(setResults)
  }, [isAudiobook, key])

  const label = (isAudiobook ? LIBRIVOX_CATEGORY_LABELS : GUTENBERG_CATEGORY_LABELS)[key] ?? key

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer width="wide" className="pb-16">
        <Link to={isAudiobook ? '/books/audiobooks' : '/books'} className="mt-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" />{isAudiobook ? 'Audiobook Store' : 'Book Store'}
        </Link>

        <PageHeader title={label} eyebrow="Books" subtitle={isAudiobook ? 'Public-domain audiobooks via LibriVox.' : 'Public-domain books via Project Gutenberg.'} />

        {results === null ? (
          <div className="flex justify-center py-16"><Spinner size="lg" /></div>
        ) : results.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">No results in this category right now.</p>
        ) : (
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
            {results.map((r) => {
              const id = 'identifier' in r ? r.identifier : `${r.source}:${r.sourceRef}`
              const previewKind = 'identifier' in r ? 'librivox' : 'ebook'
              return (
                <BookResultTile
                  key={id}
                  id={id}
                  to={`/books/preview/${previewKind}/${encodeURIComponent(id)}`}
                  state={{ kind: previewKind, result: r }}
                  title={r.title}
                  author={r.author}
                  coverSrc={r.coverUrl ? proxyImg(r.coverUrl) : null}
                />
              )
            })}
          </div>
        )}
      </PageContainer>
    </div>
  )
}
