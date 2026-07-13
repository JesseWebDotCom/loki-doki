// A smart shelf's contents: the user's library filtered by the shelf's saved rules
// (evaluated server-side). Same card grid as My Library.

import { useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { BookOpen, Headphones, LayoutGrid } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { Spinner } from '@/components/ui/spinner'
import { BookCard } from '@/components/books/BookCard'
import { proxyImg } from '@/lib/img'
import { getShelfItems, bookCoverUrl, type BookListItem } from '@/lib/books/api'

function coverSrcFor(b: BookListItem): string | null {
  if (b.hasEbook) return bookCoverUrl(b.id)
  return b.coverUrl ? proxyImg(b.coverUrl) : null
}

export function BookShelfPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { data, isLoading } = useQuery({ queryKey: ['books-shelf', id], queryFn: () => getShelfItems(id), staleTime: 60_000 })
  const books = useMemo(() => data?.books ?? [], [data])

  if (isLoading) return <div className="flex h-full items-center justify-center"><Spinner size="lg" /></div>

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer width="wide" className="py-6 pb-24">
        <PageHeader title={data?.shelf.name ?? 'Shelf'} subtitle={`${books.length} book${books.length === 1 ? '' : 's'}`} className="pt-0" />
        {books.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground">
            <LayoutGrid className="mb-3 size-8" />
            <p className="text-sm">Nothing matches this shelf's rules yet.</p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
            {books.map((b) => (
              <BookCard
                key={b.id}
                to={`/books/detail/${b.id}`}
                bookId={b.id}
                title={b.title}
                author={b.author}
                coverSrc={coverSrcFor(b)}
                progressPercent={b.progress?.percent}
                completed={b.progress?.completed}
                hasAudio={b.hasAudio}
                quickAction={{
                  icon: b.progress?.mode === 'listening' ? Headphones : BookOpen,
                  label: b.progress?.mode === 'listening' ? 'Continue listening' : 'Continue reading',
                  onClick: () => navigate(b.progress?.mode === 'listening' ? `/books/listen/${b.id}` : `/books/read/${b.id}`),
                }}
              />
            ))}
          </div>
        )}
      </PageContainer>
    </div>
  )
}
