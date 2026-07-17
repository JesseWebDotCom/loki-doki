import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Outlet, useNavigate, useLocation, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/cn'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { youtubeSuggestSource } from '@/lib/youtube/api'
import { getVideoSources, routeVideoUrl, type VideoSource } from '@/lib/videos/api'
import { VideosRail } from '@/components/videos/VideosRail'
import { DownloadDialog, SaveDialog, type DownloadTarget, type SaveTarget } from '@/components/youtube/dialogs'
import { hydrateCollections } from '@/lib/youtube/collections'
import { DeArrowProvider } from '@/lib/youtube/dearrow'

export type YoutubeMode = 'online' | 'offline'

// A search-bar entry that's a URL (not a query) is opened as a video: known hosts route to
// their native watch/creator page, everything else to the universal 'link' source.
function looksLikeUrl(s: string): boolean {
  if (/\s/.test(s)) return false
  if (/^https?:\/\//i.test(s)) return true
  return /^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(s)
}
function hubPath(source: VideoSource, kind: 'video' | 'creator', id: string): string {
  const e = encodeURIComponent(id)
  if (kind === 'creator') {
    switch (source) {
      case 'youtube': return `/videos/youtube/channel/${e}`
      case 'reddit': return `/videos/reddit/r/${e}`
      case 'tiktok': return `/videos/tiktok/creator/${e}`
      case 'vimeo': return `/videos/vimeo/channel/${e}`
      default: return `/videos/${source}/watch/${e}`
    }
  }
  return `/videos/${source}/watch/${e}`
}

interface YoutubeUI {
  mode: YoutubeMode
  setMode: (m: YoutubeMode) => void
  openSave: (videoId: string, title: string) => void
  openDownload: (videoId: string, title: string, savedKind?: 'audio' | 'video') => void
}
const YoutubeUICtx = createContext<YoutubeUI | null>(null)
export function useYoutubeUI() {
  const ctx = useContext(YoutubeUICtx)
  if (!ctx) throw new Error('useYoutubeUI must be inside VideosLayout')
  return ctx
}
/** Convenience accessor for just the online/offline mode. */
export function useYoutubeMode() { return useYoutubeUI().mode }
/** Mode accessor that doesn't throw outside the provider (defaults to online).
 *  Lets shared cards ghost offline-only items without every caller threading it. */
export function useYoutubeModeOptional(): YoutubeMode { return useContext(YoutubeUICtx)?.mode ?? 'online' }
/** UI accessor that returns null outside the provider (for shared cards). */
export function useYoutubeUIOptional(): YoutubeUI | null { return useContext(YoutubeUICtx) }

// Online = the Videos app's own cyan identity (matches appCategories.ts; not YouTube's
// red, and not the violet/fuchsia already claimed by Chat, Movies, Podcasts, Companions
// etc. this wash paints the whole hub, every source, not just YouTube). Offline =
// emerald so the two states stay visually distinct. Feeds CSS vars app-wide via `bg-[var(--yt-accent)]` etc.
const ACCENT: Record<YoutubeMode, { base: string; hover: string; fg: string; contrast: string }> = {
  // design-ok(hex-in-tsx): mode identity accents (Videos brand cyan / offline emerald) fed into CSS vars + color-mix
  online: { base: '#0891b2', hover: '#06b6d4', fg: '#22d3ee', contrast: '#04313b' },
  // design-ok(hex-in-tsx): mode identity accents (Videos brand cyan / offline emerald) fed into CSS vars + color-mix
  offline: { base: '#059669', hover: '#10b981', fg: '#34d399', contrast: '#03301f' },
}
const MODE_KEY = 'yt.mode'

/** Segmented Online/Offline control that lives in the breadcrumb's right slot. Active
 *  fill uses each mode's ACCENT hex directly (inline style, not a Tailwind class) so it
 *  always matches the page-wide wash instead of drifting to an unrelated palette. */
function ModeToggle({ mode, onChange }: { mode: YoutubeMode; onChange: (m: YoutubeMode) => void }) {
  return (
    <div className="flex h-8 shrink-0 items-center rounded-full border border-border bg-background p-0.5 text-xs font-semibold">
      {(['online', 'offline'] as YoutubeMode[]).map(m => (
        <button key={m} type="button" onClick={() => onChange(m)}
          className={cn('rounded-full px-2.5 py-1 capitalize transition-colors',
            mode === m ? 'text-white' : 'text-muted-foreground hover:text-foreground')}
          style={mode === m ? { backgroundColor: ACCENT[m].base } : undefined}>
          {m}
        </button>
      ))}
    </div>
  )
}

/** Paths where the search box's text mirrors the ?q= in the URL. */
const SEARCH_HOME_PATHS = new Set(['/videos', '/videos/', '/videos/youtube', '/videos/youtube/', '/videos/search', '/videos/search/'])

export function VideosLayout() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [params] = useSearchParams()

  const [mode, setModeState] = useState<YoutubeMode>(() => (localStorage.getItem(MODE_KEY) as YoutubeMode) || 'online')
  const setMode = (m: YoutubeMode) => { setModeState(m); try { localStorage.setItem(MODE_KEY, m) } catch { /* quota */ } }

  const [saveTarget, setSaveTarget] = useState<SaveTarget | null>(null)
  const [downloadTarget, setDownloadTarget] = useState<DownloadTarget | null>(null)
  const [query, setQuery] = useState(params.get('q') ?? '')

  usePublishUIContext({ label: 'Videos', description: `User is browsing the Videos app (${mode}).` })

  // The right pane is a persistent scroller, so reset it to the top whenever the
  // route changes (e.g. opening a video) instead of inheriting the prior scroll.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => { scrollRef.current?.scrollTo(0, 0) }, [pathname])

  // Pull server-side Watch Later / Liked into localStorage once per session.
  useEffect(() => { void hydrateCollections() }, [])

  // Keep the search box in sync with the URL query (search results live on the YouTube home).
  const urlQ = params.get('q') ?? ''
  useEffect(() => {
    if (SEARCH_HOME_PATHS.has(pathname)) setQuery(urlQ)
  }, [pathname, urlQ])

  // Approved-only mode (kids): no search box, no URL opening; discovery affordances hide
  // app-wide. The server filters every list regardless; this only removes dead-end UI.
  const { data: sourcesData } = useQuery({ queryKey: ['videos-sources'], queryFn: getVideoSources, staleTime: 5 * 60_000 })
  const allowlistOnly = sourcesData?.allowlistOnly === true

  // Publish the breadcrumb search + the Online/Offline toggle (upper-right).
  const rightSlot = useMemo(() => <ModeToggle mode={mode} onChange={setMode} />, [mode])
  const rail = useMemo(() => <VideosRail variant="drawer" />, [])
  useAppHeader({
    query,
    setQuery,
    // Approved-only mode hides the search input entirely (searchable: false below).
    searchable: !allowlistOnly,
    onSubmit: (submitted?: string) => {
      if (allowlistOnly) return
      // Use the submitted text (a picked suggestion or the Enter value) so we never search
      // stale query state; fall back to the live box value.
      const t = (submitted ?? query).trim()
      if (!t) return
      // A pasted URL opens the video directly; a plain query searches across all sources.
      if (looksLikeUrl(t)) {
        const url = /^https?:\/\//i.test(t) ? t : `https://${t}`
        void routeVideoUrl(url)
          .then((r) => navigate(hubPath(r.source, r.kind, r.id)))
          .catch(() => navigate(`/videos/search?q=${encodeURIComponent(t)}`))
        return
      }
      navigate(`/videos/search?q=${encodeURIComponent(t)}`)
    },
    placeholder: mode === 'online' ? 'Search videos, channels, episodes…' : 'Search your offline library…',
    settingsHref: '/videos/settings',
    suggest: mode === 'online' && !allowlistOnly ? youtubeSuggestSource : undefined,
    rightSlot,
    rail,
  })

  const ui: YoutubeUI = {
    mode, setMode,
    openSave: (videoId, title) => setSaveTarget({ videoId, title }),
    openDownload: (videoId, title, savedKind) => setDownloadTarget({ videoId, title, savedKind }),
  }

  const a = ACCENT[mode]
  const accentVars = {
    '--yt-accent': a.base,
    '--yt-accent-hover': a.hover,
    '--yt-accent-fg': a.fg,
    '--yt-accent-soft': `color-mix(in oklab, ${a.fg} 15%, transparent)`,
    // Rebrand the whole subtree: every text-brand/bg-brand/ring inside Videos resolves to
    // the mode identity (inline vars beat the [data-theme=dark] stylesheet definitions).
    '--brand': a.fg,
    '--brand-hover': a.hover,
    '--brand-foreground': a.contrast,
    '--ring': a.fg,   // focus rings follow the identity too (inputs, buttons)
    // A faint accent wash over the near-black base so Online (cyan) and Offline (emerald)
    // still read at a glance without lifting the black.
    backgroundImage: `linear-gradient(${`color-mix(in oklab, ${a.base} 4%, transparent)`}, ${`color-mix(in oklab, ${a.base} 4%, transparent)`})`,
  } as CSSProperties

  return (
    <YoutubeUICtx.Provider value={ui}>
     <DeArrowProvider>
      {/* The Videos hub is an always-dark, true-black "cinema" surface (the Netflix/Apple-TV
          look), independent of the app-wide theme - same posture as the Music app.
          Tokens inside resolve via data-theme="dark". */}
      <div data-theme="dark" className="flex min-h-0 flex-1 overflow-hidden bg-black text-foreground" style={accentVars}>
        <VideosRail />
        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-none pb-[max(7rem,calc(var(--bottom-chrome,0px)+1.5rem))] md:pb-[max(8rem,calc(var(--bottom-chrome,0px)+2rem))]"><Outlet /></div>
      </div>

      <SaveDialog target={saveTarget} onClose={() => setSaveTarget(null)}
        onSaved={() => qc.invalidateQueries({ queryKey: ['yt-downloads'] })} />
      <DownloadDialog target={downloadTarget} onClose={() => setDownloadTarget(null)} />
     </DeArrowProvider>
    </YoutubeUICtx.Provider>
  )
}
