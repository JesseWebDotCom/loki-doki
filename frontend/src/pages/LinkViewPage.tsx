import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink, Globe, ArrowLeftRight, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { getIconChoice } from '@/components/shared/IconPicker'
import { ChromeWash } from '@/components/shared/ChromeWash'
import { useTheme } from '@/context/ThemeContext'

interface BookmarkEntry {
  id: string
  label: string
  url: string
  icon: string | null
  useProxy: boolean
  useEmbed: boolean
}

function BookmarkIcon({ icon, className }: { icon: string | null; className?: string }) {
  if (icon?.startsWith('http')) {
    return <img src={icon} className={cn('shrink-0 rounded-sm object-contain', className)} alt="" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
  }
  if (icon) {
    const choice = getIconChoice(icon)
    if (choice) return <choice.Icon className={cn('shrink-0', className)} />
  }
  return <Globe className={cn('shrink-0', className)} />
}

export function LinkViewPage() {
  const { id } = useParams<{ id: string }>()
  const [bookmark, setBookmark] = useState<BookmarkEntry | null>(null)
  const [iframeKey, setIframeKey] = useState(0)
  const [iframeError, setIframeError] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const { effectiveTheme } = useTheme()

  const injectThemeCss = useCallback(() => {
    try {
      const doc = iframeRef.current?.contentDocument
      if (!doc?.head) return
      doc.getElementById('ld-theme')?.remove()
      if (effectiveTheme === 'dark') {
        const style = doc.createElement('style')
        style.id = 'ld-theme'
        style.textContent =
          'html{filter:invert(1) hue-rotate(180deg)!important;background:#fff!important}' +
          'img,video,canvas,svg[role=img]{filter:invert(1) hue-rotate(180deg)!important}'
        doc.head.appendChild(style)
      }
    } catch { /* cross-origin — best-effort only */ }
  }, [effectiveTheme])

  useEffect(() => {
    injectThemeCss()
  }, [injectThemeCss])

  usePublishUIContext({
    label: bookmark?.label ?? 'Links',
    description: bookmark
      ? `User is viewing "${bookmark.label}" (${bookmark.url}).`
      : 'User is viewing a linked service.',
  })

  const loadBookmark = () => {
    fetch('/api/bookmarks', { credentials: 'include' })
      .then(r => r.json())
      .then(d => setBookmark((d.bookmarks ?? []).find((b: BookmarkEntry) => b.id === id) ?? null))
      .catch(() => {})
  }

  useEffect(() => { loadBookmark() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  const reload = () => {
    setIframeError(false)
    setIframeKey(k => k + 1)
  }

  const toggleProxy = async () => {
    if (!bookmark) return
    await fetch(`/api/bookmarks/${bookmark.id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ useProxy: !bookmark.useProxy }),
    })
    loadBookmark()
    reload()
  }

  if (!bookmark) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Loading…
      </div>
    )
  }

  const iframeSrc = bookmark.useProxy ? `/api/proxy/${bookmark.id}` : bookmark.url

  return (
    <div className="flex flex-col h-[calc(100vh-var(--app-bar-height,0px))] overflow-hidden">
      {/* Chrome bar */}
      <div className="relative flex items-center gap-1.5 px-3 py-2 border-b border-border/40 bg-background/70 backdrop-blur-md shrink-0">
        <ChromeWash />
        <Button variant="ghost" size="icon" className="size-8"
          onClick={() => iframeRef.current?.contentWindow?.history.back()} title="Back">
          <ArrowLeft className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-8"
          onClick={() => iframeRef.current?.contentWindow?.history.forward()} title="Forward">
          <ArrowRight className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-8" onClick={reload} title="Reload">
          <RotateCw className="size-4" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className={cn('size-8', bookmark.useProxy && 'bg-accent')}
          onClick={toggleProxy}
          title={`Proxy mode: ${bookmark.useProxy ? 'on' : 'off'}`}
        >
          <ArrowLeftRight className="size-4" />
        </Button>

        <div className="flex flex-1 items-center gap-2 rounded-md border bg-muted/30 px-3 h-8 min-w-0">
          <BookmarkIcon icon={bookmark.icon} className="size-3.5 text-muted-foreground" />
          <span className="text-sm font-medium text-muted-foreground shrink-0 hidden sm:block mr-1.5">
            {bookmark.label}
          </span>
          <span className="text-xs text-muted-foreground/60 truncate flex-1 hidden md:block">
            {bookmark.url}
          </span>
        </div>

        <a href={bookmark.url} target="_blank" rel="noopener noreferrer">
          <Button variant="ghost" size="icon" className="size-8" title="Open in new tab" asChild>
            <span><ExternalLink className="size-4" /></span>
          </Button>
        </a>
      </div>

      <div className="relative flex-1 overflow-hidden">
        <iframe
          key={iframeKey}
          ref={iframeRef}
          src={iframeSrc}
          className="absolute inset-0 size-full border-0"
          title={bookmark.label}
          onLoad={injectThemeCss}
          onError={() => setIframeError(true)}
        />
        {iframeError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background text-center px-8">
            <AlertTriangle className="size-10 text-muted-foreground/40" />
            <div className="space-y-1">
              <p className="font-medium">Failed to load</p>
              <p className="text-sm text-muted-foreground max-w-sm">
                {bookmark.useProxy
                  ? 'The proxy could not reach this site, or it uses a JavaScript-heavy framework that cannot be fully proxied.'
                  : 'This site blocks embedding. Try enabling proxy mode (⇄) — though some apps require network-level configuration.'}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={reload}>Try again</Button>
              <a href={bookmark.url} target="_blank" rel="noopener noreferrer">
                <Button size="sm"><ExternalLink className="size-3.5 mr-1.5" />Open directly</Button>
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
