import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink, RotateCw, Archive, Loader2, AlertTriangle, FileText, Layout } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'
import { ArticleReader } from '@/components/shared/ArticleReader'
import { ReaderAIPanel } from '@/components/reader/ReaderAIPanel'
import { ReaderAutoUpdateMenu } from '@/components/reader/ReaderAutoUpdateMenu'
import { getItem, updateItem, rearchiveItem } from '@/lib/reader/api'

export function ReaderReadPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [view, setView] = useState<'reader' | 'full'>('reader')

  const { data: item, isLoading } = useQuery({
    queryKey: ['reader-item', id],
    queryFn: () => getItem(id),
    refetchInterval: (q) => {
      const s = q.state.data?.archiveState
      return s === 'pending' || s === 'fetching' ? 2000 : false
    },
  })

  // Mark an unread offline article as "reading" once opened.
  useEffect(() => {
    if (item && item.type === 'offline' && item.status === 'unread' && item.canEdit) {
      void updateItem(item.id, { status: 'reading' }).then(() => qc.invalidateQueries({ queryKey: ['reader-items'] }))
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
    qc.invalidateQueries({ queryKey: ['reader-item', id] })
    qc.invalidateQueries({ queryKey: ['reader-items'] })
  }
  async function toggleArchive() {
    await updateItem(item!.id, { status: item!.status === 'archived' ? 'reading' : 'archived' })
    qc.invalidateQueries({ queryKey: ['reader-items'] })
    qc.invalidateQueries({ queryKey: ['reader-item', id] })
    if (item!.status !== 'archived') navigate('/reader')
  }

  const TopBar = (
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/40 bg-background/80 px-4 py-2.5 backdrop-blur">
      <Button variant="ghost" size="icon-sm" onClick={() => navigate(-1)} title="Back"><ArrowLeft className="size-4" /></Button>
      <span className="flex-1 truncate text-sm font-medium">{item.title || item.url}</span>
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
      {item.type === 'offline' && item.canEdit && (
        <Button variant="ghost" size="icon-sm" onClick={reArchive} title="Re-archive"><RotateCw className="size-4" /></Button>
      )}
      {item.canEdit && (
        <ReaderAutoUpdateMenu item={item} onChanged={() => {
          qc.invalidateQueries({ queryKey: ['reader-item', id] })
          qc.invalidateQueries({ queryKey: ['reader-items'] })
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
            <div className="flex gap-2">
              <Button variant="outline" onClick={reArchive}>Try again</Button>
              <a href={item.url} target="_blank" rel="noopener noreferrer"><Button variant="ghost">Open original</Button></a>
            </div>
          </div>
        ) : showFull ? (
          <iframe
            title={item.title || item.url}
            src={`/api/reader/${item.id}/archive/index.html`}
            className="h-full w-full border-0 bg-white"
            sandbox="allow-same-origin allow-popups"
          />
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
            <div className="px-5 pb-10"><ReaderAIPanel itemId={item.id} /></div>
          </>
        )}
      </div>
    </div>
  )
}
