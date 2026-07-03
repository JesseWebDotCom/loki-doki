// The Audiobook Store: your own audiobooks (uploads/TTS conversions) up top, then
// curated LibriVox genre shelves, the audiobook equivalent of Podcasts' RSS
// subscription flow, minus the subscription: adding one is instant, chapters
// stream straight from archive.org (backend/src/lib/books/librivox.ts). Store
// tiles are bare cover art; tapping one opens BookPreviewPage for the description/
// runtime/add-to-library action, same split as the Book Store.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { BookAudio, Search, Sparkles } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { Spinner } from '@/components/ui/spinner'
import { BookCard } from '@/components/books/BookCard'
import { BookResultTile } from '@/components/books/BookResultTile'
import { BookShelf, ShelfSlot } from '@/components/books/BookShelf'
import { proxyImg } from '@/lib/img'
import {
  listLibrary, bookCoverUrl, searchLibrivox, browseAllLibrivoxCategories,
  type LibrivoxSearchResult, type LibrivoxShelf,
} from '@/lib/books/api'
import { getAppByPath } from '@/lib/appCategories'

const BOOKS_GRADIENT = getAppByPath('/books')?.gradient

function previewLink(r: LibrivoxSearchResult) {
  return { to: `/books/preview/librivox/${encodeURIComponent(r.identifier)}`, state: { kind: 'librivox' as const, result: r } }
}

function FindAudiobooks() {
  const [query, setQuery] = useState('')
  const [inputValue, setInputValue] = useState('')
  const [results, setResults] = useState<LibrivoxSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [shelves, setShelves] = useState<LibrivoxShelf[] | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => { void browseAllLibrivoxCategories().then(setShelves) }, [])

  const runSearch = useCallback(async (q: string) => {
    if (!q) { setQuery(''); return }
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setSearching(true)
    setQuery(q)
    try {
      const r = await searchLibrivox(q)
      if (!ctrl.signal.aborted) setResults(r)
    } finally {
      if (!ctrl.signal.aborted) setSearching(false)
    }
  }, [])

  return (
    <div className="space-y-9">
      <div>
        <SectionHeader title="Find audiobooks" className="mb-2" />
        <p className="mb-4 text-sm text-muted-foreground">Public-domain audiobooks read by volunteers, via LibriVox.</p>
        <div className="flex max-w-lg items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(inputValue.trim()) }}
              placeholder="Search by title or author…"
              className="ld-input w-full pl-9"
            />
          </div>
          <button
            type="button"
            onClick={() => void runSearch(inputValue.trim())}
            disabled={searching || !inputValue.trim()}
            className="shrink-0 rounded-full bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50"
          >
            {searching ? <Spinner size="sm" /> : 'Search'}
          </button>
          {query && (
            <button type="button" onClick={() => { setInputValue(''); setQuery('') }} className="shrink-0 text-sm text-muted-foreground hover:underline">Clear</button>
          )}
        </div>
      </div>

      {query ? (
        searching ? (
          <div className="flex justify-center py-10"><Spinner size="lg" /></div>
        ) : results.length === 0 ? (
          <p className="py-8 text-sm text-muted-foreground">No LibriVox results for "{query}".</p>
        ) : (
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
            {results.map((r) => {
              const link = previewLink(r)
              return (
                <BookResultTile key={r.identifier} id={r.identifier} to={link.to} state={link.state} title={r.title} author={r.author} coverSrc={r.coverUrl ? proxyImg(r.coverUrl) : null} />
              )
            })}
          </div>
        )
      ) : shelves === null ? (
        <div className="flex justify-center py-10"><Spinner size="lg" /></div>
      ) : (
        shelves.filter((s) => s.results.length > 0).map((shelf) => (
          <BookShelf key={shelf.category.subject} title={shelf.category.label}>
            {shelf.results.map((r) => {
              const link = previewLink(r)
              return (
                <ShelfSlot key={r.identifier}>
                  <BookResultTile id={r.identifier} to={link.to} state={link.state} title={r.title} author={r.author} coverSrc={r.coverUrl ? proxyImg(r.coverUrl) : null} />
                </ShelfSlot>
              )
            })}
          </BookShelf>
        ))
      )}
    </div>
  )
}

export function BooksAudiobooksPage() {
  const navigate = useNavigate()
  const { data: books = [], isLoading } = useQuery({ queryKey: ['books-library'], queryFn: listLibrary })
  const audiobooks = books.filter((b) => b.hasAudio)

  if (isLoading) {
    return <div className="flex h-full items-center justify-center py-24"><Spinner size="lg" /></div>
  }

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer width="wide" className="space-y-9 py-6 pb-24">
        <PageHeader title="Audiobook Store" subtitle="Everything you can listen to, plus public-domain titles you can add." className="pt-0 pb-0" />

        {audiobooks.length === 0 ? (
          <EmptyAppState
            icon={BookAudio}
            title="No audiobooks yet"
            tagline="Search LibriVox below, upload your own audio file, or convert one of your EPUBs into a multi-voice AI narration from its book page."
            gradient={BOOKS_GRADIENT}
            actions={<button onClick={() => navigate('/books/upload')} className="rounded-full bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover">Upload an audiobook</button>}
            features={[
              { icon: Sparkles, title: 'Convert to audiobook', desc: 'Open any EPUB in your library and use "Convert to Audiobook": dialogue gets a distinct voice per character.' },
              { icon: BookAudio, title: 'Upload your own', desc: 'MP3, M4A, M4B, and AAC audiobook files play directly.' },
            ]}
          />
        ) : (
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

        <FindAudiobooks />
      </PageContainer>
    </div>
  )
}
