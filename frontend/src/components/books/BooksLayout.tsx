import { createContext, useContext, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { NavLink, Link, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { BookAudio, Compass, Download, Library, Newspaper, Settings, Sparkles, Upload } from 'lucide-react'
import { AppRailHeader } from '@/components/shared/AppRailHeader'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { cn } from '@/lib/cn'

export type BooksMode = 'online' | 'offline'

const BooksModeCtx = createContext<{ mode: BooksMode; setMode: (m: BooksMode) => void } | null>(null)
export function useBooksMode() {
  const ctx = useContext(BooksModeCtx)
  if (!ctx) throw new Error('useBooksMode must be inside BooksLayout')
  return ctx
}
/** Mode accessor that doesn't throw outside the provider, mirrors Music's
 *  useMusicModeOptional() so shared components (BookCard, etc.) can ghost
 *  online-only content without every caller threading mode through. */
export function useBooksModeOptional(): BooksMode { return useContext(BooksModeCtx)?.mode ?? 'online' }

const MODE_KEY = 'books.mode'

// Online = the app's own accent, Offline = warning (amber), same convention
// Music uses, so you always know which side you're on at a glance. Feeds CSS
// variables the rest of the Books app can consume via `bg-[var(--books-accent)]`.
const ACCENT: Record<BooksMode, { base: string; hover: string; fg: string; contrast: string }> = {
  online: { base: 'var(--brand)', hover: 'var(--brand-hover)', fg: 'var(--brand)', contrast: 'var(--brand-foreground)' },
  offline: { base: 'var(--warning)', hover: 'var(--warning)', fg: 'var(--warning)', contrast: 'var(--warning-foreground)' },
}

/** Segmented Online/Offline control in the breadcrumb's right slot, the exact
 *  pattern YouTube/Music use (see VideosLayout.tsx/MusicLayout.tsx's ModeToggle):
 *  a localStorage-backed mode filters already-fetched content client-side rather
 *  than switching endpoints. */
function ModeToggle({ mode, onChange }: { mode: BooksMode; onChange: (m: BooksMode) => void }) {
  return (
    <div className="flex h-8 shrink-0 items-center rounded-full border border-border bg-background p-0.5 text-xs font-semibold">
      {(['online', 'offline'] as BooksMode[]).map((m) => (
        <button key={m} type="button" onClick={() => onChange(m)}
          className={cn('rounded-full px-2.5 py-1 capitalize transition-colors',
            mode === m ? 'bg-[var(--books-accent)] text-[var(--books-accent-contrast)]' : 'text-muted-foreground hover:text-foreground')}>
          {m}
        </button>
      ))}
    </div>
  )
}

function RailLink({ to, icon: Icon, label, end }: { to: string; icon: typeof Library; label: string; end?: boolean }) {
  return (
    <NavLink to={to} end={end}
      className={({ isActive }) => cn(
        'flex items-center gap-3 rounded-control px-3 py-2.5 text-sm font-medium transition-colors',
        isActive ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}>
      <Icon className="size-[18px]" />
      {label}
    </NavLink>
  )
}

/** A "My Library" tab shortcut that reflects ?filter= on the library route,
 *  mirroring YouTube's LibTab ("Saved offline" among History/Watch Later/Liked):
 *  always present in the rail, not conditional on mode, since it's a real
 *  destination regardless of whether you're currently online or offline. */
function OfflineLink() {
  const [params] = useSearchParams()
  const { pathname } = useLocation()
  const active = pathname === '/books/library' && params.get('filter') === 'offline'
  return (
    <Link to="/books/library?filter=offline"
      className={cn('flex items-center gap-3 rounded-control px-3 py-2.5 text-sm font-medium transition-colors',
        active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground')}>
      <Download className="size-[18px]" />
      Offline
    </Link>
  )
}

// The Books sub-nav. Rendered inline as the desktop rail (lg+) and, via the header
// `rail` slot, inside the mobile top bar's drawer. `mode` is passed explicitly because
// the drawer renders outside the BooksModeCtx provider.
function BooksRail({ variant, mode }: { variant: 'sidebar' | 'drawer'; mode: BooksMode }) {
  const drawer = variant === 'drawer'
  return (
    <nav className={cn(
      'shrink-0 flex-col gap-1 px-3 py-5',
      drawer ? 'flex h-full w-full overflow-y-auto' : 'sticky top-0 hidden h-fit w-56 self-start border-r border-border/40 lg:flex',
    )}>
      <AppRailHeader title="Books" className="mb-4" />
      {mode === 'online' && (
        <>
          <RailLink to="/books" icon={Compass} label="Book Store" end />
          <RailLink to="/books/magazines" icon={Newspaper} label="Magazine Store" />
          <RailLink to="/books/audiobooks" icon={BookAudio} label="Audiobook Store" />
        </>
      )}
      <RailLink to="/books/library" icon={Library} label="My Library" end={mode === 'offline'} />
      <OfflineLink />
      <RailLink to="/books/upload" icon={Upload} label="Upload" />
      <RailLink to="/books/generate" icon={Sparkles} label="Create with AI" />
      <RailLink to="/books/sources" icon={Settings} label="Sources" />
    </nav>
  )
}

export function BooksLayout() {
  usePublishUIContext({ label: 'Books', description: 'User is browsing the Books app (books, magazines, offline libraries, audiobooks).' })

  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  const [query, setQuery] = useState(params.get('q') ?? '')

  const [mode, setModeState] = useState<BooksMode>(() => (localStorage.getItem(MODE_KEY) as BooksMode) || 'online')
  const setMode = (m: BooksMode) => { setModeState(m); try { localStorage.setItem(MODE_KEY, m) } catch { /* quota */ } }

  // Keep the search box in sync with the URL query on the Book Store route.
  const urlQ = params.get('q') ?? ''
  useEffect(() => {
    if (pathname === '/books' || pathname === '/books/magazines') setQuery(urlQ)
  }, [pathname, urlQ])

  // Book Store / Audiobook Store are live internet catalogs, meaningless offline.
  // Bounce to My Library (your own EPUBs/downloads/offline archives) the moment
  // offline mode is on and you're sitting on one of them, same as switching to
  // offline mode with a rail item hidden out from under you.
  useEffect(() => {
    if (mode === 'offline' && (pathname === '/books' || pathname === '/books/audiobooks' || pathname === '/books/magazines')) {
      navigate('/books/library', { replace: true })
    }
  }, [mode, pathname, navigate])

  const rightSlot = useMemo(() => <ModeToggle mode={mode} onChange={setMode} />, [mode])
  const rail = useMemo(() => <BooksRail variant="drawer" mode={mode} />, [mode])
  useAppHeader({
    query,
    setQuery,
    onSubmit: () => {
      const t = query.trim()
      if (!t) return
      const base = pathname.startsWith('/books/magazines') || /\b(magazine|magazines|periodical|periodicals|journal|journals)\b/i.test(t)
        ? '/books/magazines'
        : '/books'
      navigate(`${base}?q=${encodeURIComponent(t)}`)
    },
    placeholder: 'Search books…',
    settingsHref: '/books/sources',
    rightSlot,
    rail,
  })

  const a = ACCENT[mode]
  const accentVars = {
    '--books-accent': a.base,
    '--books-accent-hover': a.hover,
    '--books-accent-fg': a.fg,
    '--books-accent-contrast': a.contrast,
    '--books-accent-soft': `color-mix(in oklab, ${a.fg} 15%, transparent)`,
    // A faint accent wash over the page background so Online (brand) and Offline
    // (warning) read at a glance, mirroring Music's exact treatment.
    backgroundImage: `linear-gradient(${`color-mix(in oklab, ${a.base} 7%, transparent)`}, ${`color-mix(in oklab, ${a.base} 7%, transparent)`})`,
  } as CSSProperties

  return (
    <BooksModeCtx.Provider value={{ mode, setMode }}>
      <div className="flex min-h-full bg-background" style={accentVars}>
        <BooksRail variant="sidebar" mode={mode} />

        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </BooksModeCtx.Provider>
  )
}
