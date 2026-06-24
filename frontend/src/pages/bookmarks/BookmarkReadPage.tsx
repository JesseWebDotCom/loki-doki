import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink, RotateCw, Archive, Loader2, AlertTriangle, FileText, Layout, FileDown, Film, History, X, Globe } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'
import { ArticleReader } from '@/components/shared/ArticleReader'
import { BookmarkAIPanel } from '@/components/bookmarks/BookmarkAIPanel'
import { BookmarkAutoUpdateMenu } from '@/components/bookmarks/BookmarkAutoUpdateMenu'
import { getItem, updateItem, rearchiveItem, listSnapshots, getSnapshot, archiveAssetUrl } from '@/lib/bookmarks/api'

export function BookmarkReadPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [view, setView] = useState<'reader' | 'full'>('reader')
  const [showHistory, setShowHistory] = useState(false)
  const [snapId, setSnapId] = useState<string | null>(null)

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

  // Mark an unread offline article as "reading" once opened.
  useEffect(() => {
    if (item && item.type === 'offline' && item.status === 'unread' && item.canEdit) {
      void updateItem(item.id, { status: 'reading' }).then(() => qc.invalidateQueries({ queryKey: ['bookmarks'] }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id])

  if (isLoading || !item) {
    return <div className="flex h-full items-center justify-center text-muted-foreground"><Loader2 className="size-6 animate-spin" /></div>
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
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/40 bg-background/80 px-4 py-2.5 backdrop-blur">
      <Button variant="ghost" size="icon-sm" onClick={() => navigate(-1)} title="Back"><ArrowLeft className="size-4" /></Button>
      <span className="flex-1 truncate text-sm font-medium">{item.title || item.url}</span>
      {item.isGlobal && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-400" title="Shared with everyone">
          <Globe className="size-3" />Shared
        </span>
      )}
      {item.type === 'offline' && item.archiveState === 'ready' && item.snapshotPath && (
        <div className="flex items-center rounded-md border border-border/50 p-0.5">
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
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><FileDown className="size-4" /></a>
      )}
      {item.mediaPath && (
        <a href={archiveAssetUrl(item.id, item.mediaPath)} target="_blank" rel="noopener noreferrer" title="Captured media"
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><Film className="size-4" /></a>
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
        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><ExternalLink className="size-4" /></a>
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        {item.archiveState === 'pending' || item.archiveState === 'fetching' ? (
          <div className="flex flex-col items-center gap-3 py-24 text-muted-foreground">
            <Loader2 className="size-7 animate-spin" />
            <p>Archiving this page for offline reading…</p>
          </div>
        ) : item.archiveState === 'failed' ? (
          <div className="flex flex-col items-center gap-3 py-24 text-muted-foreground">
            <AlertTriangle className="size-7 text-red-400" />
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
                      {s.changed && <span className="rounded bg-amber-500/15 px-1 text-[10px] font-semibold text-amber-500">changed</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {snapId ? (
              snap ? (
                <>
                  <div className="flex items-center justify-between gap-2 border-b border-amber-500/20 bg-amber-500/5 px-5 py-2 text-xs text-amber-600 dark:text-amber-400">
                    <span>Viewing an archived version from {new Date(snap.capturedAt).toLocaleString()}</span>
                    <button onClick={() => setSnapId(null)} className="inline-flex items-center gap-1 hover:underline"><X className="size-3" /> Back to latest</button>
                  </div>
                  <ArticleReader title={snap.title ?? item.title} siteName={item.siteName} url={item.url} contentHtml={snap.contentHtml} />
                </>
              ) : (
                <div className="flex justify-center py-24 text-muted-foreground"><Loader2 className="size-6 animate-spin" /></div>
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
                />
                <div className="px-5 pb-10"><BookmarkAIPanel itemId={item.id} /></div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
