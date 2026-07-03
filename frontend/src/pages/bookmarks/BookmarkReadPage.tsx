import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink, RotateCw, Archive, AlertTriangle, FileText, Layout, FileDown, Film, Headphones, Highlighter, History, Pause, Play, Square, X, Globe } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'
import { ArticleReader } from '@/components/shared/ArticleReader'
import { BookmarkAIPanel } from '@/components/bookmarks/BookmarkAIPanel'
import { BookmarkAutoUpdateMenu } from '@/components/bookmarks/BookmarkAutoUpdateMenu'
import { HighlightsPanel } from '@/components/bookmarks/HighlightsPanel'
import { SelectionToolbar } from '@/components/bookmarks/SelectionToolbar'
import { scrollToHighlight, useHighlightAnchoring } from '@/components/bookmarks/useHighlightAnchoring'
import { useArticleNarration } from '@/hooks/useArticleNarration'
import {
  getItem, updateItem, rearchiveItem, listSnapshots, getSnapshot, archiveAssetUrl,
  createHighlight, deleteHighlight, listHighlights, updateHighlight, type HighlightColor,
} from '@/lib/bookmarks/api'

export function BookmarkReadPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [view, setView] = useState<'reader' | 'full'>('reader')
  const [showHistory, setShowHistory] = useState(false)
  const [snapId, setSnapId] = useState<string | null>(null)
  const [showHighlights, setShowHighlights] = useState(false)
  const contentRef = useRef<HTMLDivElement | null>(null)

  const { data: item, isLoading } = useQuery({
    queryKey: ['bookmark', id],
    queryFn: () => getItem(id),
    refetchInterval: (q) => {
      const s = q.state.data?.archiveState
      return s === 'pending' || s === 'fetching' ? 2000 : false
    },
  })

  // Version history (one row per capture). Loaded for offline items so the timeline can show
  // when the page was re-archived and which captures actually changed.
  const { data: snaps = [] } = useQuery({
    queryKey: ['bookmark-snapshots', id],
    queryFn: () => listSnapshots(id),
    enabled: item?.type === 'offline',
  })
  // The selected historical capture's full content (when viewing an old version).
  const { data: snap } = useQuery({
    queryKey: ['bookmark-snapshot', id, snapId],
    queryFn: () => getSnapshot(id, snapId!),
    enabled: !!snapId,
  })

  // The user's highlights & notes on this article.
  const { data: highlights = [] } = useQuery({
    queryKey: ['bookmark-highlights', id],
    queryFn: () => listHighlights(id),
    enabled: item?.type === 'offline',
  })
  const invalidateHighlights = useCallback(() => { void qc.invalidateQueries({ queryKey: ['bookmark-highlights', id] }) }, [qc, id])

  const jumpToHighlight = useCallback((hlId: string) => {
    scrollToHighlight(contentRef.current, hlId)
  }, [])
  const openHighlightFromMark = useCallback((_hlId: string) => setShowHighlights(true), [])

  // Anchoring runs only on the LATEST reader view - historical snapshots are read-only.
  const anchoring = useHighlightAnchoring(contentRef, highlights, {
    enabled: item?.type === 'offline' && view === 'reader' && !snapId,
    contentKey: item?.contentHtml ?? null,
    onMarkClick: openHighlightFromMark,
  })

  // "Listen to this article" - narrates the latest reader content.
  const narration = useArticleNarration({ id, contentHtml: item?.type === 'offline' ? item?.contentHtml : null })

  const addHighlight = useCallback(async (color: HighlightColor, note?: string) => {
    const sel = anchoring.pendingSelection
    if (!sel) return
    anchoring.clearSelection()
    window.getSelection()?.removeAllRanges()
    try {
      await createHighlight(id, { quote: sel.quote, prefix: sel.prefix, suffix: sel.suffix, color, note })
      invalidateHighlights()
    } catch {
      toast.error('Failed to save the highlight')
    }
  }, [anchoring, id, invalidateHighlights])

  // Mark an unread offline article as "reading" once opened.
  useEffect(() => {
    if (item && item.type === 'offline' && item.status === 'unread' && item.canEdit) {
      void updateItem(item.id, { status: 'reading' }).then(() => qc.invalidateQueries({ queryKey: ['bookmarks'] }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id])

  if (isLoading || !item) {
    return <div className="flex h-full items-center justify-center"><Spinner size="lg" /></div>
  }

  async function reArchive() {
    // Server re-renders (headless Chromium → faithful HTML + fresh screenshot), falling back
    // to client/static capture inside the job.
    await rearchiveItem(item!.id)
    toast.success('Re-archiving…')
    qc.invalidateQueries({ queryKey: ['bookmark', id] })
    qc.invalidateQueries({ queryKey: ['bookmarks'] })
  }
  async function toggleArchive() {
    await updateItem(item!.id, { status: item!.status === 'archived' ? 'reading' : 'archived' })
    qc.invalidateQueries({ queryKey: ['bookmarks'] })
    qc.invalidateQueries({ queryKey: ['bookmark', id] })
    if (item!.status !== 'archived') navigate('/bookmarks')
  }

  const TopBar = (
    <div className="glass-chrome sticky top-0 z-10 flex items-center gap-2 border-b border-border/40 px-4 py-2.5">
      <Button variant="ghost" size="icon-sm" onClick={() => navigate(-1)} title="Back"><ArrowLeft className="size-4" /></Button>
      <span className="flex-1 truncate text-sm font-medium">{item.title || item.url}</span>
      {item.isGlobal && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-info/15 px-2 py-0.5 text-[10px] font-medium text-info" title="Shared with everyone">
          <Globe className="size-3" />Shared
        </span>
      )}
      {item.type === 'offline' && item.archiveState === 'ready' && item.snapshotPath && (
        <div className="flex items-center rounded-control border border-border/50 p-0.5">
          <button
            onClick={() => setView('reader')}
            title="Reader view"
            className={cn('inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors',
              view === 'reader' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}
          ><FileText className="size-3.5" /> Reader</button>
          <button
            onClick={() => setView('full')}
            title="Full page snapshot"
            className={cn('inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors',
              view === 'full' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}
          ><Layout className="size-3.5" /> Full page</button>
        </div>
      )}
      {item.pdfPath && (
        <a href={archiveAssetUrl(item.id, item.pdfPath)} target="_blank" rel="noopener noreferrer" title="Download PDF"
          className="inline-flex size-7 items-center justify-center rounded-control text-muted-foreground hover:bg-accent hover:text-foreground"><FileDown className="size-4" /></a>
      )}
      {item.mediaPath && (
        <a href={archiveAssetUrl(item.id, item.mediaPath)} target="_blank" rel="noopener noreferrer" title="Captured media"
          className="inline-flex size-7 items-center justify-center rounded-control text-muted-foreground hover:bg-accent hover:text-foreground"><Film className="size-4" /></a>
      )}
      {/* Listen to this article (offline items with reader content) */}
      {item.type === 'offline' && narration.available && (
        narration.status === 'idle' ? (
          <Button variant="ghost" size="icon-sm" onClick={() => narration.start()}
            title={narration.hasResumePoint ? 'Resume listening' : 'Listen to this article'}>
            <Headphones className="size-4" />
          </Button>
        ) : (
          <div className="flex items-center gap-0.5 rounded-control border border-border/50 px-1 py-0.5">
            {narration.status === 'playing' ? (
              <Button variant="ghost" size="icon-sm" className="size-6" onClick={narration.pause} title="Pause"><Pause className="size-3.5" /></Button>
            ) : (
              <Button variant="ghost" size="icon-sm" className="size-6" onClick={narration.resume} title="Resume"><Play className="size-3.5" /></Button>
            )}
            <Button variant="ghost" size="icon-sm" className="size-6" onClick={narration.stop} title="Stop"><Square className="size-3.5" /></Button>
            <span className="px-1 text-[10px] tabular-nums text-muted-foreground">¶ {narration.progress.paragraph}/{narration.progress.total}</span>
          </div>
        )
      )}
      {item.type === 'offline' && (
        <Button variant="ghost" size="icon-sm" onClick={() => setShowHighlights((v) => !v)} title="Highlights & notes"
          className={cn(showHighlights && 'text-foreground', highlights.length > 0 && 'text-warning')}>
          <Highlighter className="size-4" />
        </Button>
      )}
      {item.type === 'offline' && snaps.length > 0 && (
        <Button variant="ghost" size="icon-sm" onClick={() => setShowHistory((v) => !v)} title="Version history"
          className={showHistory ? 'text-foreground' : ''}><History className="size-4" /></Button>
      )}
      {item.type === 'offline' && item.canEdit && (
        <Button variant="ghost" size="icon-sm" onClick={reArchive} title="Re-archive"><RotateCw className="size-4" /></Button>
      )}
      {item.canEdit && (
        <BookmarkAutoUpdateMenu item={item} onChanged={() => {
          qc.invalidateQueries({ queryKey: ['bookmark', id] })
          qc.invalidateQueries({ queryKey: ['bookmarks'] })
        }} />
      )}
      {item.canEdit && (
        <Button variant="ghost" size="icon-sm" onClick={toggleArchive} title={item.status === 'archived' ? 'Unarchive' : 'Archive'}><Archive className="size-4" /></Button>
      )}
      <a href={item.url} target="_blank" rel="noopener noreferrer" title="Open original"
        className="inline-flex size-7 items-center justify-center rounded-control text-muted-foreground hover:bg-accent hover:text-foreground"><ExternalLink className="size-4" /></a>
    </div>
  )

  // Live link → embed the site (proxied if needed).
  if (item.type === 'live') {
    return (
      <div className="flex h-full flex-col">
        {TopBar}
        <iframe
          title={item.title || item.url}
          src={item.useProxy ? `/api/proxy/${item.id}` : item.url}
          className="min-h-0 flex-1 border-0"
          sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
        />
      </div>
    )
  }

  // Offline article. Full-page snapshot renders in a sandboxed iframe (scripts disabled);
  // reader view renders the cleaned, locally-imaged article.
  const showFull = view === 'full' && !!item.snapshotPath
  return (
    <div className="flex h-full flex-col">
      {TopBar}
      <div className="flex min-h-0 flex-1">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {item.archiveState === 'pending' || item.archiveState === 'fetching' ? (
          <div className="flex flex-col items-center gap-3 py-24 text-muted-foreground">
            <Spinner size="lg" className="size-7" />
            <p>Archiving this page for offline reading…</p>
          </div>
        ) : item.archiveState === 'failed' ? (
          <div className="flex flex-col items-center gap-3 py-24 text-muted-foreground">
            <AlertTriangle className="size-7 text-destructive" />
            <p>Couldn't archive this page.</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="outline" onClick={reArchive}>Try again</Button>
              <a href={item.url} target="_blank" rel="noopener noreferrer"><Button variant="ghost">Open original</Button></a>
              {item.archiveOrgUrl && (
                <a href={item.archiveOrgUrl} target="_blank" rel="noopener noreferrer"><Button variant="ghost">View on Wayback Machine</Button></a>
              )}
            </div>
          </div>
        ) : showFull ? (
          <iframe
            title={item.title || item.url}
            src={`/api/bookmarks/${item.id}/archive/index.html`}
            className="h-full w-full border-0 bg-white"
            sandbox="allow-same-origin allow-popups"
          />
        ) : (
          <>
            {showHistory && (
              <div className="border-b border-border/40 bg-muted/30 px-5 py-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground/60">Version history</p>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => setSnapId(null)}
                    className={cn('rounded-full border px-3 py-1 text-xs transition-colors',
                      !snapId ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
                    Latest
                  </button>
                  {snaps.map((s) => (
                    <button key={s.id} onClick={() => setSnapId(s.id)}
                      className={cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors',
                        snapId === s.id ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
                      {new Date(s.capturedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                      {s.changed && <span className="rounded bg-warning/15 px-1 text-[10px] font-semibold text-warning">changed</span>}
                      {/* Watched-value timeline: only meaningful when a selector scopes the
                          extract to something short (a price, a stock line). */}
                      {item.watchSelector && s.watchValue && s.watchValue.length <= 48 && (
                        <span className="max-w-36 truncate text-[10px] text-muted-foreground/80" title={s.watchValue}>· {s.watchValue}</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {snapId ? (
              snap ? (
                <>
                  <div className="flex items-center justify-between gap-2 border-b border-warning/20 bg-warning/5 px-5 py-2 text-xs text-warning">
                    <span>Viewing an archived version from {new Date(snap.capturedAt).toLocaleString()}</span>
                    <button onClick={() => setSnapId(null)} className="inline-flex items-center gap-1 hover:underline"><X className="size-3" /> Back to latest</button>
                  </div>
                  <ArticleReader title={snap.title ?? item.title} siteName={item.siteName} url={item.url} contentHtml={snap.contentHtml} />
                </>
              ) : (
                <div className="flex justify-center py-24"><Spinner size="lg" /></div>
              )
            ) : (
              <>
                <ArticleReader
                  title={item.title}
                  byline={item.byline}
                  siteName={item.siteName}
                  faviconUrl={item.faviconUrl}
                  url={item.url}
                  contentHtml={item.contentHtml}
                  readingMins={item.readingMins}
                  contentRef={contentRef}
                />
                <div className="px-5 pb-10"><BookmarkAIPanel itemId={item.id} /></div>
              </>
            )}
          </>
        )}
      </div>

      {/* Highlights & notes side panel */}
      {showHighlights && (
        <aside className="w-72 shrink-0 overflow-y-auto border-l border-border/40 bg-background/60">
          <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/60">Highlights & notes</p>
            <button onClick={() => setShowHighlights(false)} className="text-muted-foreground hover:text-foreground"><X className="size-3.5" /></button>
          </div>
          <HighlightsPanel
            highlights={highlights}
            orphanedIds={anchoring.orphanedIds}
            onJump={jumpToHighlight}
            onUpdate={(hid, patch) => { void updateHighlight(id, hid, patch).then(invalidateHighlights) }}
            onDelete={(hid) => { void deleteHighlight(id, hid).then(invalidateHighlights) }}
          />
        </aside>
      )}
      </div>

      {/* Floating selection toolbar (latest reader view only) */}
      {anchoring.pendingSelection && !snapId && !showFull && (
        <SelectionToolbar
          selection={anchoring.pendingSelection}
          onHighlight={(color, note) => { void addHighlight(color, note) }}
          onCancel={anchoring.clearSelection}
        />
      )}
    </div>
  )
}
