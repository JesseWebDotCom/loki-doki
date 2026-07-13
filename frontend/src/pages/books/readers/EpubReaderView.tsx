// EPUB reader: epub.js fetches the raw file from /api/books/:id/file and owns
// zip/CFI/pagination itself; the server never pre-renders chapter HTML. Progress
// (CFI + percent) is debounced up to bookProgress so it syncs across devices.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ePub from 'epubjs'
import type Book from 'epubjs/types/book'
import type Rendition from 'epubjs/types/rendition'
import { ArrowLeft, BookAudio, ChevronLeft, ChevronRight, List, Type } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'
import { bookFileUrl, getChapters, updateProgress, type BookChapter, type BookDetail } from '@/lib/books/api'

const PROGRESS_SAVE_MS = 3000
const READING_HEARTBEAT_MS = 30_000

type ReaderTheme = 'light' | 'sepia' | 'dark'
// design-ok(hex-in-tsx): epub.js reading-surface theme colors, independent of the
// app's own light/dark chrome theme.
const THEME_COLORS: Record<ReaderTheme, { bg: string; fg: string }> = {
  light: { bg: '#fdfaf3', fg: '#1a1a1a' },
  sepia: { bg: '#f4ecd8', fg: '#5b4636' },
  dark: { bg: '#1a1a1a', fg: '#e5e5e5' },
}
const FONT_FAMILIES = [
  { label: 'Original', value: '' },
  { label: 'Serif', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Sans', value: 'system-ui, -apple-system, sans-serif' },
]

interface ReaderStyle { theme: ReaderTheme; fontPct: number; lineHeight: number; fontFamily: string }

function applyReaderStyle(rendition: Rendition, s: ReaderStyle) {
  const c = THEME_COLORS[s.theme]
  const body: Record<string, string> = { background: c.bg, color: c.fg, 'line-height': String(s.lineHeight) }
  if (s.fontFamily) body['font-family'] = `${s.fontFamily} !important`
  rendition.themes.default({ body, p: s.fontFamily ? { 'font-family': `${s.fontFamily} !important` } : {} })
  rendition.themes.fontSize(`${s.fontPct}%`)
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
  const [showType, setShowType] = useState(false)
  const [style, setStyle] = useState<ReaderStyle>(() => {
    try { return { theme: 'dark', fontPct: 100, lineHeight: 1.5, fontFamily: '', ...JSON.parse(localStorage.getItem('book-reader-style') ?? '{}') } } catch { return { theme: 'dark', fontPct: 100, lineHeight: 1.5, fontFamily: '' } }
  })
  const styleRef = useRef(style)
  styleRef.current = style
  // Last known position, so the reading-time heartbeat can persist progress + accrued time.
  const lastLocRef = useRef<{ cfi: string | null; percent: number }>({ cfi: null, percent: 0 })

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
      applyReaderStyle(rendition, styleRef.current)

      rendition.on('relocated', (loc: { start?: { percentage?: number; cfi?: string } }) => {
        const percent = loc?.start?.percentage ?? 0
        const cfi = loc?.start?.cfi ?? null
        lastLocRef.current = { cfi, percent }
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

  // Re-apply and persist the reading style whenever it changes.
  useEffect(() => {
    if (renditionRef.current) applyReaderStyle(renditionRef.current, style)
    try { localStorage.setItem('book-reader-style', JSON.stringify(style)) } catch { /* private mode */ }
  }, [style])

  // Reading-time heartbeat: count open-and-visible time toward reading stats.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      const loc = lastLocRef.current
      void updateProgress(bookId, { mode: 'reading', epubCfi: loc.cfi, percent: loc.percent, elapsedDeltaSec: READING_HEARTBEAT_MS / 1000 })
    }, READING_HEARTBEAT_MS)
    return () => clearInterval(t)
  }, [bookId])

  const patchStyle = useCallback((patch: Partial<ReaderStyle>) => setStyle((s) => ({ ...s, ...patch })), [])

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
        <div className="relative">
          <Button variant="ghost" size="icon-sm" onClick={() => setShowType((v) => !v)} title="Text & theme" className={showType ? 'text-foreground' : ''}><Type className="size-4" /></Button>
          {showType && (
            <>
              {/* design-ok(raw-overlay): click-away layer for the text settings popover */}
              <div className="fixed inset-0 z-20" onClick={() => setShowType(false)} />
              <div className="absolute right-0 top-full z-30 mt-2 w-64 space-y-3 rounded-card border border-border bg-popover p-3 shadow-lg">
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">Theme</p>
                  <div className="grid grid-cols-3 gap-1.5">
                    {(['light', 'sepia', 'dark'] as ReaderTheme[]).map((t) => (
                      <button key={t} onClick={() => patchStyle({ theme: t })}
                        className={cn('rounded-control border px-2 py-1.5 text-xs capitalize', style.theme === t ? 'border-brand text-foreground' : 'border-border text-muted-foreground')}
                        style={{ background: THEME_COLORS[t].bg, color: THEME_COLORS[t].fg }}>
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">Font size</p>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => patchStyle({ fontPct: Math.max(70, style.fontPct - 10) })}>A−</Button>
                    <span className="flex-1 text-center text-sm tabular-nums">{style.fontPct}%</span>
                    <Button variant="outline" size="sm" onClick={() => patchStyle({ fontPct: Math.min(200, style.fontPct + 10) })}>A+</Button>
                  </div>
                </div>
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">Line spacing</p>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => patchStyle({ lineHeight: Math.max(1.2, Math.round((style.lineHeight - 0.1) * 10) / 10) })}>−</Button>
                    <span className="flex-1 text-center text-sm tabular-nums">{style.lineHeight.toFixed(1)}</span>
                    <Button variant="outline" size="sm" onClick={() => patchStyle({ lineHeight: Math.min(2.4, Math.round((style.lineHeight + 0.1) * 10) / 10) })}>+</Button>
                  </div>
                </div>
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">Font</p>
                  <div className="grid grid-cols-3 gap-1.5">
                    {FONT_FAMILIES.map((f) => (
                      <button key={f.label} onClick={() => patchStyle({ fontFamily: f.value })}
                        className={cn('rounded-control border px-2 py-1.5 text-xs', style.fontFamily === f.value ? 'border-brand text-foreground' : 'border-border text-muted-foreground')}>
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
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
