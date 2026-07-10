import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Outlet, useNavigate, useLocation, useSearchParams } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { MusicRail } from '@/components/music/MusicRail'
import { musicSuggestSource } from '@/lib/music/catalogApi'

export type MusicMode = 'online' | 'offline'

const MusicModeCtx = createContext<{ mode: MusicMode; setMode: (m: MusicMode) => void } | null>(null)
export function useMusicMode() {
  const ctx = useContext(MusicModeCtx)
  if (!ctx) throw new Error('useMusicMode must be inside MusicLayout')
  return ctx
}
/** Mode accessor that doesn't throw outside the provider (defaults to online). Lets shared
 *  cards/pages ghost offline-only content without every caller threading it. */
export function useMusicModeOptional(): MusicMode { return useContext(MusicModeCtx)?.mode ?? 'online' }

// The Music app carries its OWN identity color - the orange of its app tile (mirrored
// from the appCategories registry entry) - not the app-wide violet. Online = that
// orange; Offline = warning amber, kept for the "you're on the offline side" signal.
// design-ok(hex-in-tsx): the app-tile identity hues, mirrored from appCategories.ts
const MUSIC_ORANGE = '#fb923c'
const MUSIC_ORANGE_DEEP = '#f97316' // design-ok(hex-in-tsx): app-tile identity hue
const ACCENT: Record<MusicMode, { base: string; hover: string; fg: string; contrast: string }> = {
  online: { base: MUSIC_ORANGE_DEEP, hover: MUSIC_ORANGE, fg: MUSIC_ORANGE, contrast: '#1b0f04' },
  offline: { base: 'var(--warning)', hover: 'var(--warning)', fg: 'var(--warning)', contrast: 'var(--warning-foreground)' },
}
const MODE_KEY = 'music.mode'

/** Segmented Online/Offline control - lives in the breadcrumb's right slot, mirroring YouTube.
 *  Rendered OUTSIDE the music subtree (in the shared header), so the Music orange is applied
 *  explicitly rather than via the subtree's --brand override. */
function ModeToggle({ mode, onChange }: { mode: MusicMode; onChange: (m: MusicMode) => void }) {
  return (
    <div className="flex h-8 shrink-0 items-center rounded-full border border-border bg-background p-0.5 text-xs font-semibold">
      {(['online', 'offline'] as MusicMode[]).map(m => (
        <button key={m} type="button" onClick={() => onChange(m)}
          style={mode === m && m === 'online' ? { background: MUSIC_ORANGE_DEEP, color: 'white' } : undefined}
          className={cn('rounded-full px-2.5 py-1 capitalize transition-colors',
            mode === m
              ? (m === 'online' ? '' : 'bg-warning text-warning-foreground')
              : 'text-muted-foreground hover:text-foreground')}>
          {m}
        </button>
      ))}
    </div>
  )
}

/** Nested Music sub-app shell: persistent left rail + scrolling content pane, with a breadcrumb
 *  search box that routes to Browse and an Online/Offline toggle. Mirrors the YouTube layout. */
export function MusicLayout() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  const [query, setQuery] = useState(params.get('q') ?? '')

  const [mode, setModeState] = useState<MusicMode>(() => (localStorage.getItem(MODE_KEY) as MusicMode) || 'online')
  const setMode = (m: MusicMode) => { setModeState(m); try { localStorage.setItem(MODE_KEY, m) } catch { /* quota */ } }

  usePublishUIContext({ label: 'Music', description: `User is browsing the Music app (${mode}).` })

  // Reset the scroller to the top on every route change.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => { scrollRef.current?.scrollTo(0, 0) }, [pathname])

  // Keep the search box in sync with the URL query on the Browse route.
  const urlQ = params.get('q') ?? ''
  useEffect(() => {
    if (pathname.startsWith('/music/browse')) setQuery(urlQ)
  }, [pathname, urlQ])

  const rightSlot = useMemo(() => <ModeToggle mode={mode} onChange={setMode} />, [mode])
  // Same rail the desktop shows at lg+, published for the mobile top bar's drawer.
  const rail = useMemo(() => <MusicRail variant="drawer" />, [])
  useAppHeader({
    query,
    setQuery,
    onSubmit: () => { const t = query.trim(); if (t) navigate(`/music/browse?q=${encodeURIComponent(t)}`) },
    // Picking a suggestion opens the ENTITY, not a text search: artists route through
    // Browse's ?artist= resolver (instant nav + spinner while the mbid resolves), songs
    // search as "artist title" so the right recording tops the results.
    onPickSuggestion: (s) => {
      if (mode !== 'online') return false
      if (s.sublabel === 'Artist') { navigate(`/music/browse?artist=${encodeURIComponent(s.label)}`); return true }
      if (s.sublabel) { navigate(`/music/browse?q=${encodeURIComponent(`${s.sublabel} ${s.label}`)}`); return true }
      return false
    },
    placeholder: mode === 'online' ? 'Search artists, albums, songs, stations…' : 'Search your offline stations…',
    // Live artist/song autosuggest as you type (Deezer-backed) - online only; offline has no network
    // and only searches locally-saved stations. Mirrors YouTube's suggest wiring.
    suggest: mode === 'online' ? musicSuggestSource : undefined,
    rightSlot,
    rail,
    settingsHref: '/apps/music/settings',
  })

  const a = ACCENT[mode]
  const accentVars = {
    '--music-accent': a.base,
    '--music-accent-hover': a.hover,
    '--music-accent-fg': a.fg,
    '--music-accent-contrast': a.contrast,
    '--music-accent-soft': `color-mix(in oklab, ${a.fg} 15%, transparent)`,
    // Rebrand the whole subtree: every text-brand/bg-brand/ring inside Music resolves to
    // the app's orange (inline vars beat the [data-theme=dark] stylesheet definitions).
    '--brand': a.fg,
    '--brand-hover': a.hover,
    '--brand-foreground': a.contrast,
    '--ring': a.fg,   // focus rings follow the identity too (inputs, buttons)
    // A faint accent wash over the near-black base so Online (orange) and Offline (amber)
    // still read at a glance without lifting the black.
    backgroundImage: `linear-gradient(${`color-mix(in oklab, ${a.base} 4%, transparent)`}, ${`color-mix(in oklab, ${a.base} 4%, transparent)`})`,
  } as CSSProperties

  return (
    <MusicModeCtx.Provider value={{ mode, setMode }}>
      {/* The Music app is an always-dark, true-black surface (the Moosic/Apple-Music look),
          independent of the app-wide theme - same posture as the fullscreen player overlay,
          applied to the whole sub-app. Tokens inside resolve via data-theme="dark". */}
      <div data-theme="dark" className="flex min-h-0 flex-1 overflow-hidden bg-black text-foreground" style={accentVars}>
        <MusicRail />
        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-none pb-[max(7rem,calc(var(--bottom-chrome,0px)+1.5rem))] md:pb-[max(8rem,calc(var(--bottom-chrome,0px)+2rem))]">
          <Outlet />
        </div>
      </div>
    </MusicModeCtx.Provider>
  )
}
