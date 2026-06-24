import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Outlet, useNavigate, useLocation, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/cn'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { YoutubeRail } from '@/components/youtube/YoutubeRail'
import { DownloadDialog, SaveDialog, ManageChannelsDialog, type DownloadTarget, type SaveTarget } from '@/components/youtube/dialogs'
import { hydrateCollections } from '@/lib/youtube/collections'
import { DeArrowProvider } from '@/lib/youtube/dearrow'

export type YoutubeMode = 'online' | 'offline'

interface YoutubeUI {
  mode: YoutubeMode
  setMode: (m: YoutubeMode) => void
  openManage: () => void
  openSave: (videoId: string, title: string) => void
  openDownload: (videoId: string, title: string, savedKind?: 'audio' | 'video') => void
}
const YoutubeUICtx = createContext<YoutubeUI | null>(null)
export function useYoutubeUI() {
  const ctx = useContext(YoutubeUICtx)
  if (!ctx) throw new Error('useYoutubeUI must be inside YoutubeLayout')
  return ctx
}
/** Convenience accessor for just the online/offline mode. */
export function useYoutubeMode() { return useYoutubeUI().mode }
/** Mode accessor that doesn't throw outside the provider (defaults to online).
 *  Lets shared cards ghost offline-only items without every caller threading it. */
export function useYoutubeModeOptional(): YoutubeMode { return useContext(YoutubeUICtx)?.mode ?? 'online' }
/** UI accessor that returns null outside the provider (for shared cards). */
export function useYoutubeUIOptional(): YoutubeUI | null { return useContext(YoutubeUICtx) }

// Online = red identity, Offline = emerald — so you always know which side you're on.
// The accent feeds CSS variables consumed by the whole app via `bg-[var(--yt-accent)]` etc.
const ACCENT: Record<YoutubeMode, { base: string; hover: string; fg: string }> = {
  online: { base: '#dc2626', hover: '#ef4444', fg: '#f87171' },
  offline: { base: '#059669', hover: '#10b981', fg: '#34d399' },
}
const MODE_KEY = 'yt.mode'

/** Segmented Online/Offline control — lives in the breadcrumb's right slot. */
function ModeToggle({ mode, onChange }: { mode: YoutubeMode; onChange: (m: YoutubeMode) => void }) {
  return (
    <div className="flex h-8 shrink-0 items-center rounded-md border border-border bg-background p-0.5 text-xs font-semibold">
      {(['online', 'offline'] as YoutubeMode[]).map(m => (
        <button key={m} type="button" onClick={() => onChange(m)}
          className={cn('rounded px-2.5 py-1 capitalize transition-colors',
            mode === m
              ? (m === 'online' ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white')
              : 'text-muted-foreground hover:text-foreground')}>
          {m}
        </button>
      ))}
    </div>
  )
}

export function YoutubeLayout() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [params] = useSearchParams()

  const [mode, setModeState] = useState<YoutubeMode>(() => (localStorage.getItem(MODE_KEY) as YoutubeMode) || 'online')
  const setMode = (m: YoutubeMode) => { setModeState(m); try { localStorage.setItem(MODE_KEY, m) } catch { /* quota */ } }

  const [manageOpen, setManageOpen] = useState(false)
  const [saveTarget, setSaveTarget] = useState<SaveTarget | null>(null)
  const [downloadTarget, setDownloadTarget] = useState<DownloadTarget | null>(null)
  const [query, setQuery] = useState(params.get('q') ?? '')

  usePublishUIContext({ label: 'YouTube', description: `User is browsing the YouTube app (${mode}).` })

  // The right pane is a persistent scroller, so reset it to the top whenever the
  // route changes (e.g. opening a video) instead of inheriting the prior scroll.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => { scrollRef.current?.scrollTo(0, 0) }, [pathname])

  // Pull server-side Watch Later / Liked into localStorage once per session.
  useEffect(() => { void hydrateCollections() }, [])

  // Keep the search box in sync with the URL query (search results live on Home).
  const urlQ = params.get('q') ?? ''
  useEffect(() => {
    if (pathname === '/youtube' || pathname === '/youtube/') setQuery(urlQ)
  }, [pathname, urlQ])

  // Publish the breadcrumb search + the Online/Offline toggle (upper-right).
  const rightSlot = useMemo(() => <ModeToggle mode={mode} onChange={setMode} />, [mode])
  useAppHeader({
    query,
    setQuery,
    onSubmit: () => { const t = query.trim(); if (t) navigate(`/youtube?q=${encodeURIComponent(t)}`) },
    placeholder: mode === 'online' ? 'Search videos, channels, episodes…' : 'Search your offline library…',
    externalHref: mode === 'online' ? 'https://www.youtube.com' : undefined,
    rightSlot,
  })

  const ui: YoutubeUI = {
    mode, setMode,
    openManage: () => setManageOpen(true),
    openSave: (videoId, title) => setSaveTarget({ videoId, title }),
    openDownload: (videoId, title, savedKind) => setDownloadTarget({ videoId, title, savedKind }),
  }

  const a = ACCENT[mode]
  const accentVars = {
    '--yt-accent': a.base,
    '--yt-accent-hover': a.hover,
    '--yt-accent-fg': a.fg,
    '--yt-accent-soft': `color-mix(in oklab, ${a.fg} 15%, transparent)`,
    // A faint accent wash over the page background so Online (red) and Offline
    // (emerald) are distinguishable at a glance. Layered on top of bg-background.
    backgroundImage: `linear-gradient(${`color-mix(in oklab, ${a.base} 7%, transparent)`}, ${`color-mix(in oklab, ${a.base} 7%, transparent)`})`,
  } as CSSProperties

  return (
    <YoutubeUICtx.Provider value={ui}>
     <DeArrowProvider>
      <div className="flex min-h-0 flex-1 overflow-hidden bg-background" style={accentVars}>
        <YoutubeRail onManage={ui.openManage} />
        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-none pb-28 md:pb-32"><Outlet /></div>
      </div>

      <ManageChannelsDialog open={manageOpen} onClose={() => setManageOpen(false)}
        onChanged={() => { qc.invalidateQueries({ queryKey: ['yt-subs'] }); qc.invalidateQueries({ queryKey: ['yt-feed'] }) }} />
      <SaveDialog target={saveTarget} onClose={() => setSaveTarget(null)}
        onSaved={() => qc.invalidateQueries({ queryKey: ['yt-downloads'] })} />
      <DownloadDialog target={downloadTarget} onClose={() => setDownloadTarget(null)} />
     </DeArrowProvider>
    </YoutubeUICtx.Provider>
  )
}
