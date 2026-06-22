import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Rss, Bookmark, Circle, Loader2, RefreshCw, Trash2, CheckCheck, Upload, Globe, ThumbsUp, ThumbsDown, Sparkles } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { relativeTime } from '@/components/shared/NewsCard'
import {
  listFeeds, listItems, addFeed, deleteFeed, refreshFeedApi, setItemState, markAllRead, importOpml, sendFeedback,
  type Feed, type FeedItem,
} from '@/lib/feeds/api'

type Scope = { kind: 'all' } | { kind: 'unread' } | { kind: 'saved' } | { kind: 'feed'; feed: Feed }

function FeedThumb({ item }: { item: FeedItem }) {
  if (item.imageUrl) return <img src={item.imageUrl} alt="" className="size-20 shrink-0 rounded-lg object-cover" loading="lazy" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
  return null
}

export function FeedsPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [scope, setScope] = useState<Scope>({ kind: 'all' })
  const [addOpen, setAddOpen] = useState(false)
  const [confirmDel, setConfirmDel] = useState<Feed | null>(null)
  const opmlRef = useRef<HTMLInputElement>(null)

  const { data: feedData } = useQuery({ queryKey: ['feeds'], queryFn: listFeeds, refetchInterval: 60_000 })
  const feeds = feedData?.feeds ?? []

  const itemQuery = useMemo(() => {
    if (scope.kind === 'feed') return { feedId: scope.feed.id }
    if (scope.kind === 'saved') return { saved: '1' as const }
    if (scope.kind === 'unread') return { unread: '1' as const }
    return {}
  }, [scope])

  const { data: itemData, isLoading } = useQuery({
    queryKey: ['feed-items', itemQuery],
    queryFn: () => listItems(itemQuery),
  })
  const items = itemData?.items ?? []

  async function open(item: FeedItem) {
    if (!item.read) { void setItemState(item.id, { read: true }).then(() => { qc.invalidateQueries({ queryKey: ['feeds'] }) }) }
    navigate(`/feeds/read/${item.id}`)
  }
  async function toggleSave(e: React.MouseEvent, item: FeedItem) {
    e.stopPropagation()
    await setItemState(item.id, { saved: !item.saved })
    toast.success(item.saved ? 'Removed from Reader' : 'Saved to Reader')
    qc.invalidateQueries({ queryKey: ['feed-items'] })
  }
  async function feedback(e: React.MouseEvent, item: FeedItem, vote: 'up' | 'down') {
    e.stopPropagation()
    await sendFeedback(item.id, vote)
    toast.success(vote === 'up' ? 'More like this' : 'Less like this')
    qc.invalidateQueries({ queryKey: ['feed-items'] })
  }
  async function refreshAll() {
    await Promise.allSettled(feeds.filter(f => f.canEdit || f.isSystem).map(f => refreshFeedApi(f.id)))
    qc.invalidateQueries({ queryKey: ['feeds'] }); qc.invalidateQueries({ queryKey: ['feed-items'] })
    toast.success('Refreshed')
  }
  async function onOpml(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return
    try { const n = await importOpml(await f.text()); toast.success(`Imported ${n} feeds`); qc.invalidateQueries({ queryKey: ['feeds'] }) }
    catch { toast.error('Import failed') } finally { if (opmlRef.current) opmlRef.current.value = '' }
  }

  const RailItem = ({ active, onClick, icon: Icon, label, badge }: { active: boolean; onClick: () => void; icon: typeof Rss; label: string; badge?: number }) => (
    <button onClick={onClick}
      className={cn('flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
        active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground')}>
      <Icon className="size-4 shrink-0" /><span className="flex-1 truncate text-left">{label}</span>
      {!!badge && <span className="rounded-full bg-primary/15 px-1.5 text-[11px] font-semibold text-primary">{badge}</span>}
    </button>
  )

  return (
    <div className="flex h-full min-h-0">
      {/* Left rail */}
      <div className="hidden w-64 shrink-0 flex-col overflow-y-auto border-r border-border/40 px-3 py-4 md:flex">
        <Button size="sm" className="mb-3" onClick={() => setAddOpen(true)}><Plus className="mr-1.5 size-4" />Add feed</Button>
        <RailItem active={scope.kind === 'all'} onClick={() => setScope({ kind: 'all' })} icon={Rss} label="All" />
        <RailItem active={scope.kind === 'unread'} onClick={() => setScope({ kind: 'unread' })} icon={Circle} label="Unread" />
        <RailItem active={scope.kind === 'saved'} onClick={() => setScope({ kind: 'saved' })} icon={Bookmark} label="Saved" />

        <p className="mb-1 mt-5 px-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">Feeds</p>
        {feeds.map(f => (
          <div key={f.id} className="group relative">
            <RailItem active={scope.kind === 'feed' && scope.feed.id === f.id} onClick={() => setScope({ kind: 'feed', feed: f })}
              icon={Rss} label={f.title || f.url || 'Feed'} badge={f.unread} />
            {f.canEdit && (
              <button onClick={() => setConfirmDel(f)} title="Remove"
                className="absolute right-1 top-1.5 hidden rounded p-1 text-muted-foreground hover:text-red-400 group-hover:block"><Trash2 className="size-3" /></button>
            )}
          </div>
        ))}

        <div className="mt-auto space-y-0.5 pt-4">
          <button onClick={refreshAll} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"><RefreshCw className="size-4" />Refresh all</button>
          <button onClick={() => opmlRef.current?.click()} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"><Upload className="size-4" />Import OPML</button>
          <a href="/api/feeds/opml/export" className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"><Globe className="size-4" />Export OPML</a>
          <input ref={opmlRef} type="file" accept=".opml,.xml,text/xml" className="hidden" onChange={onOpml} />
        </div>
      </div>

      {/* Item list */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border/40 bg-background/80 px-5 py-3 backdrop-blur">
          <h1 className="text-lg font-bold capitalize">{scope.kind === 'feed' ? scope.feed.title : scope.kind}</h1>
          {(scope.kind === 'feed' || scope.kind === 'all' || scope.kind === 'unread') && items.length > 0 && (
            <Button variant="ghost" size="sm" onClick={async () => { await markAllRead(scope.kind === 'feed' ? { feedId: scope.feed.id } : {}); qc.invalidateQueries({ queryKey: ['feeds'] }); qc.invalidateQueries({ queryKey: ['feed-items'] }) }}>
              <CheckCheck className="mr-1.5 size-4" />Mark all read
            </Button>
          )}
        </div>

        {isLoading ? (
          <div className="flex justify-center py-20 text-muted-foreground"><Loader2 className="size-6 animate-spin" /></div>
        ) : items.length === 0 ? (
          <div className="py-20 text-center text-muted-foreground">No items. {scope.kind === 'all' && 'Add a feed to get started.'}</div>
        ) : (
          <div className="divide-y divide-border/40">
            {items.map(item => (
              <button key={item.id} onClick={() => open(item)}
                className={cn('group flex w-full items-start gap-4 px-5 py-4 text-left transition-colors hover:bg-accent/30',
                  item.read && 'opacity-55',
                  item.score != null && item.score < 0.35 && 'opacity-45',
                  item.score != null && item.score > 0.7 && 'border-l-2 border-primary')}>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="truncate font-medium">{item.feedTitle}</span>
                    {item.publishedAt && <span>· {relativeTime(item.publishedAt)}</span>}
                    {item.score != null && item.score > 0.7 && <span className="inline-flex items-center gap-0.5 text-primary"><Sparkles className="size-3" />For you</span>}
                  </div>
                  <p className="mb-1 line-clamp-2 font-semibold leading-snug">{item.title}</p>
                  {item.summary && <p className="line-clamp-2 text-sm text-muted-foreground">{item.summary}</p>}
                </div>
                <FeedThumb item={item} />
                <div className="flex shrink-0 flex-col items-center gap-1">
                  <button onClick={(e) => toggleSave(e, item)} title={item.saved ? 'Saved' : 'Save to Reader'}
                    className={cn('rounded-md p-1.5 transition-colors', item.saved ? 'text-primary' : 'text-muted-foreground hover:text-foreground')}>
                    <Bookmark className={cn('size-4', item.saved && 'fill-current')} />
                  </button>
                  <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <button onClick={(e) => feedback(e, item, 'up')} title="More like this" className="rounded p-1 text-muted-foreground hover:text-emerald-400"><ThumbsUp className="size-3.5" /></button>
                    <button onClick={(e) => feedback(e, item, 'down')} title="Less like this" className="rounded p-1 text-muted-foreground hover:text-red-400"><ThumbsDown className="size-3.5" /></button>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <AddFeedDialog open={addOpen} onClose={() => setAddOpen(false)} onAdded={() => { qc.invalidateQueries({ queryKey: ['feeds'] }); qc.invalidateQueries({ queryKey: ['feed-items'] }) }} />
      <ConfirmDialog open={!!confirmDel} onOpenChange={(o) => { if (!o) setConfirmDel(null) }} title="Remove this feed?" description={confirmDel?.title} confirmLabel="Remove" destructive
        onConfirm={async () => { if (confirmDel) { await deleteFeed(confirmDel.id); toast.success('Removed'); setScope({ kind: 'all' }); qc.invalidateQueries({ queryKey: ['feeds'] }) } setConfirmDel(null) }} />
    </div>
  )
}

function AddFeedDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit() {
    if (!url.trim()) return
    setBusy(true)
    try { await addFeed({ url: url.trim() }); toast.success('Feed added'); setUrl(''); onAdded(); onClose() }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to add feed') }
    finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Add a feed</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">Paste a site or RSS/Atom URL — we'll find the feed automatically.</p>
        <Input autoFocus placeholder="https://example.com or .../feed.xml" value={url} onChange={e => setUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void submit() }} />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy && <Loader2 className="mr-1.5 size-4 animate-spin" />}Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
