// The Audiobook Store: your own audiobooks (uploads/TTS conversions) up top when
// you have any, then curated LibriVox genre shelves, always visible immediately,
// same as the Book Store. (Previously this page led with a full-page "No
// audiobooks yet" empty state whenever your personal library was empty, which
// pushed the actual browsable LibriVox content below the fold and made the page
// look sparse/broken next to the Book Store, which never gates its shelves behind
// anything.) No search box here: the app-wide breadcrumb search already covers
// Books (BooksLayout's useAppHeader submits to /books?q=...), so this page is
// browse-only, matching the Book Store's landing state. Store tiles are bare
// cover art; tapping one opens BookPreviewPage for the description/runtime/
// add-to-library action, same split as the Book Store.

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { Spinner } from '@/components/ui/spinner'
import { BookCard } from '@/components/books/BookCard'
import { BookResultTile } from '@/components/books/BookResultTile'
import { BookShelf, ShelfSlot } from '@/components/books/BookShelf'
import { proxyImg } from '@/lib/img'
import { listLibrary, bookCoverUrl, browseAllLibrivoxCategories, type LibrivoxShelf } from '@/lib/books/api'

export function BooksAudiobooksPage() {
  const { data: books = [], isLoading: libraryLoading } = useQuery({ queryKey: ['books-library'], queryFn: listLibrary })
  const audiobooks = books.filter((b) => b.hasAudio)

  const [shelves, setShelves] = useState<LibrivoxShelf[] | null>(null)
  useEffect(() => { void browseAllLibrivoxCategories().then(setShelves) }, [])

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer width="wide" className="space-y-9 py-6 pb-24">
        <PageHeader title="Audiobook Store" subtitle="Everything you can listen to, plus public-domain titles you can add." className="pt-0 pb-0" />

        {!libraryLoading && audiobooks.length > 0 && (
          <section>
            <SectionHeader title="Your Audiobooks" count={audiobooks.length} className="mb-4" />
            <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
              {audiobooks.map((b) => (
                <BookCard
                  key={b.id}
                  to={`/books/detail/${b.id}`}
                  bookId={b.id}
                  title={b.title}
                  author={b.author}
                  coverSrc={b.hasEbook ? bookCoverUrl(b.id) : (b.coverUrl ? proxyImg(b.coverUrl) : null)}
                  progressPercent={b.progress?.mode === 'listening' ? b.progress.percent : 0}
                  completed={b.progress?.mode === 'listening' ? b.progress.completed : false}
                  hasAudio
                />
              ))}
            </div>
          </section>
        )}

        {shelves === null ? (
          <div className="flex justify-center py-16"><Spinner size="lg" /></div>
        ) : (
          shelves.filter((s) => s.results.length > 0).map((shelf) => (
            <BookShelf key={shelf.category.subject} title={shelf.category.label} to={`/books/category/audiobook/${encodeURIComponent(shelf.category.subject)}`}>
              {shelf.results.map((r) => {
                const key = r.identifier
                return (
                  <ShelfSlot key={key}>
                    <BookResultTile
                      id={key}
                      to={`/books/preview/librivox/${encodeURIComponent(key)}`}
                      state={{ kind: 'librivox' as const, result: r }}
                      title={r.title}
                      author={r.author}
                      coverSrc={r.coverUrl ? proxyImg(r.coverUrl) : null}
                    />
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
