// EPUB reader: epub.js fetches the raw file from /api/books/:id/file and owns
// zip/CFI/pagination itself; the server never pre-renders chapter HTML. Progress
// (CFI + percent) is debounced up to bookProgress so it syncs across devices.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ePub from 'epubjs'
import type Book from 'epubjs/types/book'
import type Rendition from 'epubjs/types/rendition'
import { ArrowLeft, BookAudio, ChevronLeft, ChevronRight, List, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { bookFileUrl, getChapters, updateProgress, type BookChapter, type BookDetail } from '@/lib/books/api'

const PROGRESS_SAVE_MS = 3000

// design-ok(hex-in-tsx): epub.js reading-surface theme colors (sepia/dark reading
// modes), independent of the app's own light/dark chrome theme.
function applyTheme(rendition: Rendition, mode: 'light' | 'dark') {
  rendition.themes.default(mode === 'dark'
    ? { body: { background: '#1a1a1a', color: '#e5e5e5' } }
    : { body: { background: '#fdfaf3', color: '#1a1a1a' } })
}

/** Shortcut to the audiobook player once one exists. Starting the conversion
 *  itself lives on the book's detail page (/books/detail/:id), described as a
 *  real feature there instead of a bare icon here. */
function ListenShortcut({ bookId, hasAudio }: { bookId: string; hasAudio: boolean }) {
  const navigate = useNavigate()
  if (!hasAudio) return null
  return (
    <Button variant="ghost" size="icon-sm" onClick={() => navigate(`/books/listen/${bookId}`)} title="Listen to the audiobook version">
      <BookAudio className="size-4" />
    </Button>
  )
}

export function EpubReaderView({ bookId, detail }: { bookId: string; detail: BookDetail }) {
  const navigate = useNavigate()
  const viewerRef = useRef<HTMLDivElement>(null)
  const bookRef = useRef<Book | null>(null)
  const renditionRef = useRef<Rendition | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [chapters, setChapters] = useState<BookChapter[]>([])
  const [showToc, setShowToc] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>('dark')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    void (async () => {
      const chs = await getChapters(bookId)
      if (cancelled) return
      setChapters(chs)
      if (!viewerRef.current) return

      // epub.js sniffs the URL's file extension to decide whether it's a packed
      // .epub archive to fetch-and-unzip vs. an already-unpacked directory of
      // loose files to fetch piece by piece. Our URL (/api/books/:id/file) has no
      // extension, so without this hint it guesses "unpacked" and 404s trying to
      // fetch META-INF/container.xml as a relative path off that URL.
      const book = ePub(bookFileUrl(bookId), { openAs: 'epub' }) as unknown as Book
      bookRef.current = book
      const rendition = book.renderTo(viewerRef.current, {
        width: '100%', height: '100%', flow: 'scrolled-doc', allowScriptedContent: false,
      })
      renditionRef.current = rendition
      applyTheme(rendition, theme)

      rendition.on('relocated', (loc: { start?: { percentage?: number; cfi?: string } }) => {
        const percent = loc?.start?.percentage ?? 0
        const cfi = loc?.start?.cfi ?? null
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        saveTimerRef.current = setTimeout(() => {
          void updateProgress(bookId, { mode: 'reading', epubCfi: cfi, percent, completed: percent >= 0.98 })
        }, PROGRESS_SAVE_MS)
      })

      const startCfi = detail.progress?.mode === 'reading' ? detail.progress.epubCfi : null
      try {
        await rendition.display(startCfi ?? undefined)
        if (!cancelled) setLoading(false)
      } catch {
        if (!cancelled) { setError('Could not open this book. It may not be a valid EPUB.'); setLoading(false) }
      }
    })()

    return () => {
      cancelled = true
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      try { renditionRef.current?.destroy() } catch { /* already gone */ }
      try { bookRef.current?.destroy() } catch { /* already gone */ }
      renditionRef.current = null
      bookRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId])

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark'
      if (renditionRef.current) applyTheme(renditionRef.current, next)
      return next
    })
  }, [])

  const goToChapter = useCallback((href: string | null) => {
    if (href) void renditionRef.current?.display(href)
    setShowToc(false)
  }, [])

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="glass-chrome sticky top-0 z-10 flex items-center gap-2 border-b border-border/40 px-4 py-2.5">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate('/books')} title="Back"><ArrowLeft className="size-4" /></Button>
        <span className="flex-1 truncate text-sm font-medium">{detail.title}</span>
        <ListenShortcut bookId={bookId} hasAudio={detail.assets.some((a) => a.kind === 'audio' && a.status === 'ready')} />
        <Button variant="ghost" size="icon-sm" onClick={() => setShowToc((v) => !v)} title="Table of contents" className={showToc ? 'text-foreground' : ''}><List className="size-4" /></Button>
        <Button variant="ghost" size="icon-sm" onClick={toggleTheme} title="Toggle theme">
          {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>
      </div>
      <div className="relative flex min-h-0 flex-1">
        {showToc && (
          <div className="w-64 shrink-0 overflow-y-auto border-r border-border/40 p-3">
            <p className="mb-2 text-overline text-muted-foreground">Contents</p>
            <div className="space-y-0.5">
              {chapters.map((ch) => (
                <button key={ch.id} onClick={() => goToChapter(ch.epubHref)}
                  className="block w-full truncate rounded-control px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground">
                  {ch.title}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="relative min-w-0 flex-1">
          {loading && <div className="absolute inset-0 flex items-center justify-center"><Spinner size="lg" /></div>}
          {error && <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-destructive">{error}</div>}
          <div ref={viewerRef} className="size-full" />
          {!loading && !error && (
            <>
              <button onClick={() => renditionRef.current?.prev()} title="Previous page"
                className="absolute inset-y-0 left-0 flex w-10 items-center justify-center text-muted-foreground/30 transition-colors hover:text-foreground">
                <ChevronLeft className="size-6" />
              </button>
              <button onClick={() => renditionRef.current?.next()} title="Next page"
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground/30 transition-colors hover:text-foreground">
                <ChevronRight className="size-6" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
