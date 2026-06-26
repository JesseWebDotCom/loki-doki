import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Outlet, useNavigate, useLocation, useSearchParams } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { MusicRail } from '@/components/music/MusicRail'

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

// Online = violet identity, Offline = amber — so you always know which side you're on. The accent
// feeds CSS variables the whole Music app can consume via `bg-[var(--music-accent)]` etc.
const ACCENT: Record<MusicMode, { base: string; hover: string; fg: string }> = {
  online: { base: '#7c3aed', hover: '#8b5cf6', fg: '#a78bfa' },
  offline: { base: '#d97706', hover: '#f59e0b', fg: '#fbbf24' },
}
const MODE_KEY = 'music.mode'

/** Segmented Online/Offline control — lives in the breadcrumb's right slot, mirroring YouTube. */
function ModeToggle({ mode, onChange }: { mode: MusicMode; onChange: (m: MusicMode) => void }) {
  return (
    <div className="flex h-8 shrink-0 items-center rounded-md border border-border bg-background p-0.5 text-xs font-semibold">
      {(['online', 'offline'] as MusicMode[]).map(m => (
        <button key={m} type="button" onClick={() => onChange(m)}
          className={cn('rounded px-2.5 py-1 capitalize transition-colors',
            mode === m
              ? (m === 'online' ? 'bg-violet-600 text-white' : 'bg-amber-600 text-white')
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
  useAppHeader({
    query,
    setQuery,
    onSubmit: () => { const t = query.trim(); if (t) navigate(`/music/browse?q=${encodeURIComponent(t)}`) },
    placeholder: mode === 'online' ? 'Search artists, albums, songs, stations…' : 'Search your offline stations…',
    rightSlot,
  })

  const a = ACCENT[mode]
  const accentVars = {
    '--music-accent': a.base,
    '--music-accent-hover': a.hover,
    '--music-accent-fg': a.fg,
    '--music-accent-soft': `color-mix(in oklab, ${a.fg} 15%, transparent)`,
    // A faint accent wash over the page background so Online (violet) and Offline (amber) read at
    // a glance. Layered on top of bg-background.
    backgroundImage: `linear-gradient(${`color-mix(in oklab, ${a.base} 7%, transparent)`}, ${`color-mix(in oklab, ${a.base} 7%, transparent)`})`,
  } as CSSProperties

  return (
    <MusicModeCtx.Provider value={{ mode, setMode }}>
      <div className="flex min-h-0 flex-1 overflow-hidden bg-background" style={accentVars}>
        <MusicRail />
        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-none pb-28 md:pb-32">
          <Outlet />
        </div>
      </div>
    </MusicModeCtx.Provider>
  )
}
