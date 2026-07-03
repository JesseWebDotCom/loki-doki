import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { Archive, BookAudio, BookOpen, Compass, Headphones, Sparkles, Upload } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { Spinner } from '@/components/ui/spinner'
import { BookCard } from '@/components/books/BookCard'
import { BookCover } from '@/components/books/BookCover'
import { BookShelf, ShelfSlot } from '@/components/books/BookShelf'
import { useInstalledArchives } from '@/hooks/useInstalledArchives'
import { listLibrary, bookCoverUrl, type BookListItem } from '@/lib/books/api'
import { getAppByPath } from '@/lib/appCategories'
import { proxyImg } from '@/lib/img'

const BOOKS_GRADIENT = getAppByPath('/books')?.gradient

function coverSrcFor(b: BookListItem): string | null {
  if (b.hasEbook) return bookCoverUrl(b.id)
  return b.coverUrl ? proxyImg(b.coverUrl) : null
}

function Row({ title, books }: { title: string; books: BookListItem[] }) {
  const navigate = useNavigate()
  if (!books.length) return null
  return (
    <BookShelf title={title}>
      {books.map((b) => (
        <ShelfSlot key={b.id}>
          <BookCard
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
        </ShelfSlot>
      ))}
    </BookShelf>
  )
}

// Every installed Books-category ZIM pack, front and center on Home instead of
// hidden behind a separate "Offline Archives" click: this was the actual
// complaint, offline content existed but nothing on the main page showed it.
function OfflineLibrariesShelf() {
  const { data: archives = [], isLoading } = useInstalledArchives()
  const bookPacks = archives.filter((a) => a.category === 'Books')
  if (!isLoading && !bookPacks.length) return null

  return (
    <BookShelf title="Offline Libraries" loading={isLoading}>
      {bookPacks.map((a) => (
        <ShelfSlot key={a.id}>
          <Link to={`/books/archives/${a.sourceId}`} className="group block">
            <div className="relative aspect-[2/3] w-full overflow-hidden rounded-card shadow-sm transition-shadow group-hover:shadow-lg">
              <BookCover bookId={a.sourceId} title={a.label} coverSrc={a.zimIconUrl} fill size={220} className="transition-transform group-hover:scale-[1.02]" />
            </div>
            <div className="mt-2">
              <p className="truncate text-sm font-semibold">{a.label}</p>
              <p className="truncate text-xs text-muted-foreground">Offline library</p>
            </div>
          </Link>
        </ShelfSlot>
      ))}
    </BookShelf>
  )
}

export function BooksLibraryPage() {
  const navigate = useNavigate()
  const { data: books = [], isLoading } = useQuery({
    queryKey: ['books-library'],
    queryFn: listLibrary,
    refetchInterval: (query) => (query.state.data ?? []).some((b) => b.libraryStatus === 'pending' || b.libraryStatus === 'downloading') ? 3000 : false,
  })
  const { data: archives = [], isLoading: archivesLoading } = useInstalledArchives()
  const hasOfflineLibraries = archives.some((a) => a.category === 'Books')

  if (isLoading || archivesLoading) {
    return <div className="flex h-full items-center justify-center py-24"><Spinner size="lg" /></div>
  }

  if (!books.length && !hasOfflineLibraries) {
    return (
      <div className="h-full overflow-y-auto">
        <PageContainer width="wide" className="py-6 pb-24">
          <PageHeader className="pt-0 pb-0" />
          <EmptyAppState
            icon={BookAudio}
            title="Your library is empty"
            tagline="Upload your own EPUBs, find public-domain classics, or read offline ZIM book packs, all in one place."
            gradient={BOOKS_GRADIENT}
            actions={(
              <>
                <button onClick={() => navigate('/books/upload')} className="rounded-full bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover">Upload a book</button>
                <button onClick={() => navigate('/books')} className="rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-accent/50">Browse the Book Store</button>
              </>
            )}
            features={[
              { icon: Upload, title: 'Upload your own', desc: 'EPUB, PDF, CBZ, CBR, and audiobook files (MP3/M4A/M4B).' },
              { icon: Compass, title: 'Discover public domain', desc: 'Search Project Gutenberg and the Internet Archive directly.' },
              { icon: Sparkles, title: 'Convert to audiobook', desc: 'AI narration with a distinct voice per character.' },
              { icon: Archive, title: 'Offline libraries', desc: 'Read bulk book packs like Gutenberg and Wikisource fully offline.' },
            ]}
          />
        </PageContainer>
      </div>
    )
  }

  const continuing = books.filter((b) => b.progress && b.progress.percent > 0 && !b.progress.completed)
  const reading = continuing.filter((b) => b.progress?.mode === 'reading')
  const listening = continuing.filter((b) => b.progress?.mode === 'listening')

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer width="wide" className="space-y-9 py-6 pb-24">
        <PageHeader subtitle="Your EPUBs, audiobooks, and offline libraries in one place." className="pt-0 pb-0" />

        <Row title="Continue Reading" books={reading} />
        <Row title="Continue Listening" books={listening} />
        <OfflineLibrariesShelf />

        {books.length > 0 && (
          <section>
            <SectionHeader title="Your Library" count={books.length} className="mb-4" />
            <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
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
                  pending={b.libraryStatus === 'pending' || b.libraryStatus === 'downloading'}
                  failed={b.libraryStatus === 'failed'}
                />
              ))}
            </div>
          </section>
        )}
      </PageContainer>
    </div>
  )
}
