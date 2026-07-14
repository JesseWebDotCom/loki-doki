import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { MediaRail } from '@/components/media/MediaRail'

// Movies and Shows share one always-dark, true-black "cinema" shell (same posture as the
// Videos and Music apps): tokens resolve via data-theme="dark" and the app's static
// registry identity is fed into the global --brand*/--ring vars. Art-derived palettes
// override these per surface via ArtAccentScope on the sanctioned surfaces only (hub
// billboard, detail pages).
const ACCENT = {
  // design-ok(hex-in-tsx): app identity accents (Movies violet, matches appCategories.ts) fed into CSS vars + color-mix
  movies: { base: '#7c3aed', hover: '#8b5cf6', fg: '#a78bfa', contrast: '#2e1065' },
  // design-ok(hex-in-tsx): app identity accents (Shows sky, matches appCategories.ts) fed into CSS vars + color-mix
  shows: { base: '#0284c7', hover: '#0ea5e9', fg: '#38bdf8', contrast: '#082f49' },
}

// Search results render on the app home (?q=); these are the paths whose box mirrors the URL.
const SEARCH_HOME_PATHS = new Set(['/movies', '/movies/', '/shows', '/shows/'])

export function MediaLayout() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  const movies = pathname.startsWith('/movies')
  const a = movies ? ACCENT.movies : ACCENT.shows
  const home = movies ? '/movies' : '/shows'

  // The layout owns the scroller (the shell backdrop/scroller is off for full-bleed
  // routes), so reset it to the top whenever the route changes.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => { scrollRef.current?.scrollTo(0, 0) }, [pathname])

  // Breadcrumb search: submits route to the app home's ?q= (results render there),
  // mirroring the Videos/Music layout-owned pattern.
  const [query, setQuery] = useState(params.get('q') ?? '')
  const urlQ = params.get('q') ?? ''
  useEffect(() => {
    if (SEARCH_HOME_PATHS.has(pathname)) setQuery(urlQ)
  }, [pathname, urlQ])

  const rail = useMemo(() => <MediaRail variant="drawer" />, [])
  useAppHeader({
    query,
    setQuery,
    onSubmit: (submitted?: string) => {
      const t = (submitted ?? query).trim()
      navigate(t ? `${home}?q=${encodeURIComponent(t)}` : home)
    },
    placeholder: movies ? 'Search movies…' : 'Search shows…',
    externalHref: movies ? 'https://www.justwatch.com' : 'https://www.tvmaze.com',
    settingsHref: movies ? '/movies/settings' : '/apps/shows/settings',
    rail,
  })

  const accentVars = {
    // Rebrand the subtree: every text-brand/bg-brand/ring inside resolves to the app
    // identity (inline vars beat the [data-theme=dark] stylesheet definitions).
    '--brand': a.fg,
    '--brand-hover': a.hover,
    '--brand-foreground': a.contrast,
    // --primary resolves at the root (see ArtAccentScope), so filled Buttons need it set here too.
    '--primary': a.fg,
    '--primary-foreground': a.contrast,
    '--ring': a.fg,
    // A faint identity wash over the near-black base, same recipe as Videos/Music.
    backgroundImage: `linear-gradient(color-mix(in oklab, ${a.base} 4%, transparent), color-mix(in oklab, ${a.base} 4%, transparent))`,
  } as CSSProperties

  return (
    <div data-theme="dark" className="flex min-h-0 flex-1 overflow-hidden bg-black text-foreground" style={accentVars}>
      <MediaRail />
      <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-none pb-[max(7rem,calc(var(--bottom-chrome,0px)+1.5rem))] md:pb-[max(8rem,calc(var(--bottom-chrome,0px)+2rem))]">
        <Outlet />
      </div>
    </div>
  )
}
