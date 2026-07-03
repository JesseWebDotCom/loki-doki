import { useCallback, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Archive, BookAudio, BookOpen, Compass, Download, Headphones, Plus, Sparkles, Upload } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { OfflineSelectionToolbar } from '@/components/shared/OfflineSelectionToolbar'
import { AddOfflinePacksDialog } from '@/components/shared/AddOfflinePacksDialog'
import { useAuth } from '@/context/AuthContext'
import { Spinner } from '@/components/ui/spinner'
import { BookCard } from '@/components/books/BookCard'
import { BookCover } from '@/components/books/BookCover'
import { BookShelf, ShelfSlot } from '@/components/books/BookShelf'
import { useInstalledArchives, type InstalledArchive } from '@/hooks/useInstalledArchives'
import { listLibrary, bookCoverUrl, removeBooksFromLibrary, type BookListItem } from '@/lib/books/api'
import { getAppByPath } from '@/lib/appCategories'
import { proxyImg } from '@/lib/img'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/cn'

const BOOKS_GRADIENT = getAppByPath('/books')?.gradient

function coverSrcFor(b: BookListItem): string | null {
  if (b.hasEbook) return bookCoverUrl(b.id)
  return b.coverUrl ? proxyImg(b.coverUrl) : null
}

// LibriVox audiobooks never download a local copy: every chapter streams from
// archive.org (see backend/src/lib/books/librivox.ts), so unlike an uploaded/
// downloaded EPUB or a TTS-converted audiobook, they need a live connection and
// don't belong in "Offline" even though they're in your library.
function isOfflineAvailable(b: BookListItem): boolean {
  return b.libraryStatus === 'ready' && (b.hasEbook || b.hasAudio) && b.sourceType !== 'librivox'
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

// Installed book packs (Gutenberg, Wikisource, textbooks, manuals…) shelved right in
// the library, one shelf per book category. Reference packs (Wikipedia, medical wikis,
// dev docs) are NOT books - they live in the Reference app, so they're filtered out here
// by `bookCategory` (only book collections carry it).
function bookPacks(archives: InstalledArchive[]): InstalledArchive[] {
  return archives.filter((a) => a.bookCategory != null)
}

function BookPackShelf({ title, archives }: { title: string; archives: InstalledArchive[] }) {
  return (
    <BookShelf title={title}>
      {archives.map((a) => (
        <ShelfSlot key={a.id}>
          <Link to={`/books/archives/${a.sourceId}`} className="group block">
            <div className="relative aspect-[2/3] w-full overflow-hidden rounded-card shadow-sm transition-shadow group-hover:shadow-lg">
              <BookCover bookId={a.sourceId} title={a.label} coverSrc={a.zimIconUrl} fill size={220} className="transition-transform group-hover:scale-[1.02]" />
            </div>
            <div className="mt-2">
              <p className="truncate text-sm font-semibold">{a.label}</p>
              <p className="truncate text-xs text-muted-foreground">Book collection</p>
            </div>
          </Link>
        </ShelfSlot>
      ))}
    </BookShelf>
  )
}

function BookPackShelves() {
  const { data: archives = [], isLoading } = useInstalledArchives()
  const packs = bookPacks(archives)
  if (isLoading) return <BookShelf title="Book collections" loading>{null}</BookShelf>
  if (!packs.length) return null

  const byCategory = new Map<string, InstalledArchive[]>()
  for (const a of packs) {
    const cat = a.bookCategory ?? 'Books'
    if (!byCategory.has(cat)) byCategory.set(cat, [])
    byCategory.get(cat)!.push(a)
  }
  const categories = [...byCategory.keys()].sort((a, b) => a.localeCompare(b))

  return (
    <>
      {categories.map((cat) => (
        <BookPackShelf key={cat} title={cat} archives={byCategory.get(cat)!} />
      ))}
    </>
  )
}

export function BooksLibraryPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [addOpen, setAddOpen] = useState(false)
  const [params] = useSearchParams()
  const offlineOnly = params.get('filter') === 'offline'
  const { data: allBooks = [], isLoading } = useQuery({
    queryKey: ['books-library'],
    queryFn: listLibrary,
    refetchInterval: (query) => (query.state.data ?? []).some((b) => b.libraryStatus === 'pending' || b.libraryStatus === 'downloading') ? 3000 : false,
  })
  const { data: archives = [], isLoading: archivesLoading } = useInstalledArchives()
  const hasBookPacks = bookPacks(archives).length > 0
  const books = offlineOnly ? allBooks.filter(isOfflineAvailable) : allBooks

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const toggle = useCallback((id: string) => setSelected((s) => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next }), [])
  const allSelected = books.length > 0 && selected.size === books.length

  const clear = useCallback(async (ids: string[]) => {
    setBusy(true)
    try {
      await removeBooksFromLibrary(ids)
      setSelected(new Set())
      await qc.invalidateQueries({ queryKey: ['books-library'] })
      toast.success(ids.length === 1 ? 'Removed from offline' : `Removed ${ids.length} from offline`)
    } catch {
      toast.error('Could not remove all books')
    } finally {
      setBusy(false)
    }
  }, [qc])

  if (isLoading || archivesLoading) {
    return <div className="flex h-full items-center justify-center py-24"><Spinner size="lg" /></div>
  }

  if (!books.length && !hasBookPacks) {
    return (
      <div className="h-full overflow-y-auto">
        <PageContainer width="wide" className="py-6 pb-24">
          <PageHeader title={offlineOnly ? 'Offline' : undefined} className="pt-0 pb-0" />
          {offlineOnly ? (
            <EmptyAppState
              icon={Download}
              title="Nothing saved for offline yet"
              tagline="Uploaded EPUBs, downloaded books, and TTS-converted audiobooks show up here. LibriVox audiobooks stream live and don't count, since there's no local copy to fall back on."
              gradient={BOOKS_GRADIENT}
              actions={<button onClick={() => navigate('/books/library')} className="rounded-full bg-[var(--books-accent)] px-4 py-2 text-sm font-medium text-[var(--books-accent-contrast)] hover:bg-[var(--books-accent-hover)]">View full library</button>}
              features={[]}
            />
          ) : (
            <EmptyAppState
              icon={BookAudio}
              title="Your library is empty"
              tagline="Upload your own EPUBs, find public-domain classics, or read whole offline book collections, all in one place."
              gradient={BOOKS_GRADIENT}
              actions={(
                <>
                  <button onClick={() => navigate('/books/upload')} className="rounded-full bg-[var(--books-accent)] px-4 py-2 text-sm font-medium text-[var(--books-accent-contrast)] hover:bg-[var(--books-accent-hover)]">Upload a book</button>
                  <button onClick={() => navigate('/books')} className="rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-accent/50">Browse the Book Store</button>
                </>
              )}
              features={[
                { icon: Upload, title: 'Upload your own', desc: 'EPUB, PDF, CBZ, CBR, and audiobook files (MP3/M4A/M4B).' },
                { icon: Compass, title: 'Discover public domain', desc: 'Search Project Gutenberg and the Internet Archive directly.' },
                { icon: Sparkles, title: 'Convert to audiobook', desc: 'AI narration with a distinct voice per character.' },
                { icon: Archive, title: 'Offline collections', desc: 'Read whole libraries like Gutenberg and Wikisource fully offline.' },
              ]}
            />
          )}
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
        <PageHeader
          title={offlineOnly ? 'Offline' : undefined}
          subtitle={offlineOnly ? 'Books and audiobooks with a local copy, usable with no connection.' : 'Your EPUBs, audiobooks, and offline book collections in one place.'}
          className="pt-0 pb-0"
          actions={isAdmin && !offlineOnly ? (
            <button
              onClick={() => setAddOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-accent/50"
            >
              <Plus className="size-4" /> Add offline books
            </button>
          ) : undefined}
        />

        {!offlineOnly && <Row title="Continue Reading" books={reading} />}
        {!offlineOnly && <Row title="Continue Listening" books={listening} />}
        {!offlineOnly && <BookPackShelves />}

        {books.length > 0 && (
          <section>
            <SectionHeader title={offlineOnly ? 'Offline' : 'Your Library'} count={books.length} className="mb-4" />
            {offlineOnly && (
              <div className="mb-4">
                <OfflineSelectionToolbar
                  totalCount={books.length}
                  selectedCount={selected.size}
                  allSelected={allSelected}
                  busy={busy}
                  itemLabel="book"
                  onToggleSelectAll={() => setSelected(allSelected ? new Set() : new Set(books.map((b) => b.id)))}
                  onClearSelected={() => clear([...selected])}
                  onClearAll={() => clear(books.map((b) => b.id))}
                />
              </div>
            )}
            <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
              {books.map((b) => (
                <div key={b.id} className={cn(offlineOnly && 'group relative')}>
                  {offlineOnly && (
                    <button
                      type="button"
                      onClick={() => toggle(b.id)}
                      className={cn('absolute left-2 top-2 z-10 flex size-6 items-center justify-center rounded-full border-2 transition-colors',
                        selected.has(b.id) ? 'border-[var(--books-accent)] bg-[var(--books-accent)]' : 'border-white/70 bg-black/40 opacity-0 group-hover:opacity-100')}
                      aria-label={selected.has(b.id) ? 'Deselect' : 'Select'}
                    >
                      {selected.has(b.id) && <span className="size-2 rounded-full bg-white" />}
                    </button>
                  )}
                  <BookCard
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
                </div>
              ))}
            </div>
          </section>
        )}
      </PageContainer>
      {isAdmin && <AddOfflinePacksDialog open={addOpen} onOpenChange={setAddOpen} mode="books" accentClassName="bg-[var(--books-accent)] text-[var(--books-accent-contrast)] hover:bg-[var(--books-accent-hover)]" />}
    </div>
  )
}
