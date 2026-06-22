import { useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Globe, FileText, Bookmark, Loader2, Trash2, Archive, ExternalLink, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useBreadcrumbSearch } from '@/context/BreadcrumbSearchContext'
import { listItems, deleteItem, updateItem, type ReaderItem, type ListParams } from '@/lib/reader/api'

function Favicon({ item }: { item: ReaderItem }) {
  if (item.faviconUrl) {
    return <img src={item.faviconUrl} alt="" className="size-4 shrink-0 rounded-sm object-contain"
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
  }
  return <Globe className="size-4 shrink-0 text-muted-foreground" />
}

function host(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

function ArchiveBadge({ item }: { item: ReaderItem }) {
  if (item.type === 'live') {
    return <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400"><Bookmark className="size-3" />Live</span>
  }
  if (item.archiveState === 'pending' || item.archiveState === 'fetching') {
    return <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400"><Loader2 className="size-3 animate-spin" />Saving</span>
  }
  if (item.archiveState === 'failed') {
    return <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-medium text-red-400"><AlertTriangle className="size-3" />Failed</span>
  }
  return <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-medium text-violet-300"><FileText className="size-3" />{item.readingMins || 1} min</span>
}

export function ReaderLibraryPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [params] = useSearchParams()
  const { id: collectionParam } = useParams()
  const [search, setSearch] = useState('')
  const [confirmDel, setConfirmDel] = useState<ReaderItem | null>(null)

  const filters: ListParams = useMemo(() => ({
    status: (params.get('status') as ListParams['status']) || undefined,
    type: (params.get('type') as ListParams['type']) || undefined,
    tag: params.get('tag') || undefined,
    collectionId: collectionParam || undefined,
    q: params.get('tag') ? undefined : (search.trim() || undefined),
  }), [params, collectionParam, search])

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['reader-items', filters],
    queryFn: () => listItems(filters),
    // Poll while anything is mid-archive so the badge flips to "ready" without a refresh.
    refetchInterval: (q) => (q.state.data ?? []).some(i => i.archiveState === 'pending' || i.archiveState === 'fetching') ? 3000 : false,
  })

  const heading = collectionParam ? 'Collection'
    : params.get('tag') ? `#${params.get('tag')}`
    : params.get('status') ? params.get('status')!
    : params.get('type') === 'live' ? 'Live links'
    : params.get('type') === 'offline' ? 'Offline articles'
    : 'Library'

  // Standard breadcrumb row: live search (Settings lives in the rail for all users).
  useBreadcrumbSearch({
    query: search,
    setQuery: setSearch,
    placeholder: 'Search your library…',
  })

  function openItem(item: ReaderItem) {
    if (item.type === 'live' && !item.useEmbed) { window.open(item.url, '_blank', 'noopener'); return }
    navigate(`/reader/read/${item.id}`)
  }

  async function archive(item: ReaderItem) {
    await updateItem(item.id, { status: item.status === 'archived' ? 'unread' : 'archived' })
    qc.invalidateQueries({ queryKey: ['reader-items'] })
  }
  async function doDelete(item: ReaderItem) {
    try { await deleteItem(item.id); toast.success('Deleted'); qc.invalidateQueries({ queryKey: ['reader-items'] }) }
    catch { toast.error('Failed to delete') }
  }

  return (
    <div className="mx-auto max-w-6xl px-5 py-6">
      <h1 className="mb-5 text-2xl font-bold capitalize">{heading}</h1>

      {isLoading ? (
        <div className="flex justify-center py-20 text-muted-foreground"><Loader2 className="size-6 animate-spin" /></div>
      ) : items.length === 0 ? (
        <div className="py-20 text-center text-muted-foreground">
          Nothing here yet. Use <span className="font-medium text-foreground">Save</span> to add a link or article.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map(item => (
            <div key={item.id}
              className="group relative flex flex-col rounded-2xl border border-border/60 bg-card p-4 transition-colors hover:border-border">
              <button onClick={() => openItem(item)} className="flex-1 text-left">
                <div className="mb-2 flex items-center gap-2">
                  <Favicon item={item} />
                  <span className="truncate text-xs text-muted-foreground">{item.siteName || host(item.url)}</span>
                </div>
                <p className="mb-2 line-clamp-2 font-semibold leading-snug">{item.title || item.url}</p>
                {item.excerpt && <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">{item.excerpt}</p>}
                <div className="flex items-center gap-2">
                  <ArchiveBadge item={item} />
                  {item.tags.slice(0, 2).map(t => <span key={t} className="rounded-full bg-accent/60 px-2 py-0.5 text-[10px] text-muted-foreground">{t}</span>)}
                </div>
              </button>
              {item.canEdit && (
                <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <a href={item.url} target="_blank" rel="noopener noreferrer" title="Open original"
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><ExternalLink className="size-3.5" /></a>
                  <button onClick={() => archive(item)} title="Archive"
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><Archive className="size-3.5" /></button>
                  <button onClick={() => setConfirmDel(item)} title="Delete"
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-red-500/15 hover:text-red-400"><Trash2 className="size-3.5" /></button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDel}
        onOpenChange={(o) => { if (!o) setConfirmDel(null) }}
        title="Delete this item?"
        description={confirmDel?.title}
        confirmLabel="Delete"
        onConfirm={() => { if (confirmDel) void doDelete(confirmDel); setConfirmDel(null) }}
      />
    </div>
  )
}
