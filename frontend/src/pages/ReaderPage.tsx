import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { AppBreadcrumb } from '@/components/shared/AppBreadcrumb'
import { Search, ArrowLeft, ArrowRight, Shuffle, ExternalLink, BookOpen, Home } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { categoryVisual } from '@/lib/archiveCategories'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { ArchiveIcon } from '@/components/shared/ArchiveIcon'

// ── Types ─────────────────────────────────────────────────────────────────────

interface InstalledArchive {
  id: string
  sourceId: string
  label: string
  description: string | null
  category: string
  faviconUrl: string | null
  zimIconUrl: string | null
  variantLabel: string
  fileSizeBytes: number | null
  zimDate: string | null
  kiwixBookName: string | null
}


// ── Full-screen offline-archive reader ─────────────────────────────────────────
// Reachable only by opening an archive from the Today screen. Wraps kiwix-serve
// content in a same-origin iframe and provides browser-style chrome around it.

export function ReaderPage() {
  const { sourceId } = useParams<{ sourceId: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  // Captured once: a deep link (e.g. from ArchiveBrowsePage) opens at a specific
  // article, but in-iframe navigation shouldn't reset back to it afterwards.
  const initialPathRef = useRef(searchParams.get('path') ?? '')

  const [archive, setArchive]       = useState<InstalledArchive | null>(null)
  const [loaded, setLoaded]         = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [iframeUrl, setIframeUrl]   = useState<string | null>(null)
  const [iframeKey, setIframeKey]   = useState(0)
  const [articleTitle, setArticleTitle] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Resolve which installed archive this route points at.
  useEffect(() => {
    let cancelled = false
    fetch('/api/archives/installed', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        const list: InstalledArchive[] = d.archives ?? []
        setArchive(list.find((a) => a.sourceId === sourceId) ?? null)
        setLoaded(true)
      })
      .catch(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [sourceId])

  const open = useCallback((path = '') => {
    if (!sourceId) return
    setIframeUrl(`/api/archives/view/${sourceId}/${path}`)
    setIframeKey((k) => k + 1)
  }, [sourceId])

  // Load the archive's landing page (or a deep-linked article) once resolved.
  useEffect(() => {
    if (archive) open(initialPathRef.current)
  }, [archive, open])

  // Read document.title from the iframe on every load; works for both initial
  // loads and in-iframe link clicks, and is more reliable than URL parsing.
  function handleIframeLoad() {
    try {
      const rawTitle = iframeRef.current?.contentWindow?.document?.title ?? ''
      // design-ok(em-dash): regex character class must match em-dash-separated title suffixes
      const title = rawTitle.replace(/\s*[|–—-]\s*.+$/, '').trim() || null
      setArticleTitle(title)
    } catch { /* cross-origin guard */ }
  }

  usePublishUIContext({
    label: archive?.label ?? 'Library',
    description: archive
      ? `User is reading from the offline library "${archive.label}"${articleTitle ? `. Currently viewing the article: "${articleTitle}".` : '.'}`
      : 'User is opening an offline library.',
  })

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (!archive || !searchQuery.trim()) return
    open(`search?pattern=${encodeURIComponent(searchQuery.trim())}`)
  }

  // ── Loading / not-found states ───────────────────────────────────────────────

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Spinner size="lg" />
      </div>
    )
  }

  if (!archive) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
        <BookOpen className="size-12 text-muted-foreground/30" />
        <div>
          <p className="font-medium">This library isn't installed</p>
          <p className="mt-1 text-sm text-muted-foreground">
            It may have been removed. Manage offline libraries in{' '}
            <a href="/admin/features" className="underline underline-offset-2">Admin → Features</a>.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => navigate('/')}>
          <Home className="size-4" /> Back to Home
        </Button>
      </div>
    )
  }

  const visual = categoryVisual(archive.category)
  const archiveTile = (
    <span className="flex size-5 shrink-0 items-center justify-center rounded" style={{ background: visual.gradient }}>
      <ArchiveIcon zimIconUrl={archive.zimIconUrl} category={archive.category} />
    </span>
  )

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <AppBreadcrumb
        crumbs={[
          { label: "Home", href: "/", icon: Home },
          { label: archive.category, href: `/category/${encodeURIComponent(archive.category)}` },
          { label: archive.label, iconNode: archiveTile, truncate: true },
        ]}
      >
        <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={() => iframeRef.current?.contentWindow?.history.back()} title="Back">
          <ArrowLeft className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={() => iframeRef.current?.contentWindow?.history.forward()} title="Forward">
          <ArrowRight className="size-4" />
        </Button>
        <form onSubmit={handleSearch} className="flex flex-1 gap-1">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={`Search ${archive.label}…`}
              className="h-8 pl-8 text-sm"
            />
          </div>
          <Button type="submit" size="sm" variant="secondary" className="h-8 px-3">Go</Button>
        </form>
        <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={() => open('random')} title="Random article">
          <Shuffle className="size-4" />
        </Button>
        {archive.faviconUrl && (
          <a href={archive.faviconUrl.replace('/favicon.ico', '')} target="_blank" rel="noopener noreferrer" title="Open website" className="hidden sm:flex shrink-0">
            <Button variant="ghost" size="icon" className="size-8" asChild>
              <span><ExternalLink className="size-4" /></span>
            </Button>
          </a>
        )}
      </AppBreadcrumb>

      {/* Minimal license credit, required by CC-BY-SA for offline archive content */}
      <div className="flex shrink-0 items-center border-b border-border/40 px-3 py-0.5">
        <span className="text-[10px] text-muted-foreground/50">
          Offline archive &middot;{' '}
          <a href="/settings/about" className="underline underline-offset-2 hover:text-muted-foreground">
            Content licenses
          </a>
        </span>
      </div>

      {/* Viewer */}
      <div className="relative flex-1 overflow-hidden">
        {iframeUrl && (
          <iframe
            key={iframeKey}
            ref={iframeRef}
            src={iframeUrl}
            onLoad={handleIframeLoad}
            className="h-full w-full border-0"
            title={archive.label}
            sandbox="allow-same-origin allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms"
          />
        )}
      </div>
    </div>
  )
}
