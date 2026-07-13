import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Globe, FileText, Bookmark, Download, History, Upload, Plus, ArrowDownUp, X, Archive, Trash2, FolderOpen, Pin, CheckCheck } from 'lucide-react'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { ViewToggle } from '@/components/shared/ViewToggle'
import { useViewPreference } from '@/hooks/useViewPreference'
import { getAppByPath } from '@/lib/appCategories'
import { useBookmarkUI } from '@/components/bookmarks/BookmarksLayout'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { BookmarkEditDialog } from '@/components/bookmarks/BookmarkEditDialog'
import { BookmarkCard } from '@/components/bookmarks/BookmarkCard'
import { CollectionShareDialog } from '@/components/bookmarks/CollectionShareDialog'
import {
  listItems, deleteItem, updateItem, listCollections, bulkAction,
  type BookmarkItem, type ListParams, type BookmarkSort,
} from '@/lib/bookmarks/api'

const SORTS: { value: BookmarkSort; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'title', label: 'Title A → Z' },
  { value: '-title', label: 'Title Z → A' },
  { value: 'updated', label: 'Recently updated' },
]

export function BookmarksLibraryPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { openSave } = useBookmarkUI()
  const [params] = useSearchParams()
  const { id: collectionParam } = useParams()
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<BookmarkSort>('newest')
  const [view, setView] = useViewPreference('bookmarks.view', 'grid')
  const [confirmDel, setConfirmDel] = useState<BookmarkItem | null>(null)
  const [editItem, setEditItem] = useState<BookmarkItem | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [shareCollection, setShareCollection] = useState(false)

  const isRootView = !collectionParam && !params.get('status') && !params.get('type') && !params.get('tag') && !params.get('pinned') && !search.trim()

  const filters: ListParams = useMemo(() => ({
    status: (params.get('status') as ListParams['status']) || undefined,
    type: (params.get('type') as ListParams['type']) || undefined,
    tag: params.get('tag') || undefined,
    pinned: params.get('pinned') === '1' ? '1' : undefined,
    collectionId: collectionParam || undefined,
    q: params.get('tag') ? undefined : (search.trim() || undefined),
    sort,
  }), [params, collectionParam, search, sort])

  const { data: collections = [] } = useQuery({ queryKey: ['bookmark-collections'], queryFn: listCollections })
  const collById = useMemo(() => new Map(collections.map(c => [c.id, c])), [collections])
  const activeCollection = collectionParam ? collById.get(collectionParam) : undefined
  const canShareActive = activeCollection?.role === 'owner'

  async function moveToCollection(item: BookmarkItem, collectionId: string | null) {
    await updateItem(item.id, { collectionId })
    qc.invalidateQueries({ queryKey: ['bookmarks'] })
    toast.success(collectionId ? 'Moved to collection' : 'Removed from collection')
  }

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['bookmarks', filters],
    queryFn: () => listItems(filters),
    refetchInterval: (q) => (q.state.data ?? []).some(i => i.archiveState === 'pending' || i.archiveState === 'fetching') ? 3000 : false,
  })

  const heading = activeCollection ? activeCollection.name
    : params.get('tag') ? `#${params.get('tag')}`
    : params.get('pinned') === '1' ? 'Pinned'
    : params.get('status') ? params.get('status')!.replace(/^\w/, (m) => m.toUpperCase())
    : params.get('type') === 'live' ? 'Live links'
    : params.get('type') === 'offline' ? 'Offline articles'
    : 'All bookmarks'

  useAppHeader({ query: search, setQuery: setSearch, placeholder: 'Search your library…' })

  function openItem(item: BookmarkItem) {
    if (item.type === 'live' && !item.useEmbed && item.contentKind === 'link') { window.open(item.url, '_blank', 'noopener'); return }
    navigate(`/bookmarks/read/${item.id}`)
  }
  async function archive(item: BookmarkItem) {
    await updateItem(item.id, { status: item.status === 'archived' ? 'unread' : 'archived' })
    qc.invalidateQueries({ queryKey: ['bookmarks'] })
  }
  async function togglePin(item: BookmarkItem) {
    await updateItem(item.id, { isPinned: !item.isPinned })
    qc.invalidateQueries({ queryKey: ['bookmarks'] }); qc.invalidateQueries({ queryKey: ['bookmark-home'] })
  }
  async function doDelete(item: BookmarkItem) {
    try { await deleteItem(item.id); toast.success('Deleted'); qc.invalidateQueries({ queryKey: ['bookmarks'] }) }
    catch { toast.error('Failed to delete') }
  }

  // ── Multi-select ──
  function toggleSelect(id: string) {
    setSelected(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
  }
  function clearSelection() { setSelected(new Set()) }
  async function runBulk(action: Parameters<typeof bulkAction>[1], extra?: { collectionId?: string | null; tags?: string[] }) {
    const ids = [...selected]
    if (!ids.length) return
    try {
      const n = await bulkAction(ids, action, extra)
      toast.success(`${action === 'delete' ? 'Deleted' : 'Updated'} ${n} item${n === 1 ? '' : 's'}`)
      clearSelection()
      qc.invalidateQueries({ queryKey: ['bookmarks'] }); qc.invalidateQueries({ queryKey: ['bookmark-home'] })
    } catch { toast.error('Bulk action failed') }
  }

  const gridClass = view === 'list' ? 'flex flex-col gap-2'
    : view === 'big' ? 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4'
    : 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3'

  return (
    <PageContainer width="wide" className="py-6">
      <PageHeader title={heading} className="pt-0 pb-4" actions={
        <div className="flex items-center gap-2">
          {items.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(items.map(i => i.id)))} className="gap-1.5 text-muted-foreground">
              <CheckCheck className="size-4" /> Select all
            </Button>
          )}
          {canShareActive && (
            <Button variant="outline" size="sm" onClick={() => setShareCollection(true)} className="gap-1.5">
              <Globe className="size-4" /> Share
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5"><ArrowDownUp className="size-4" />{SORTS.find(s => s.value === sort)?.label}</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Sort by</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {SORTS.map(s => (
                <DropdownMenuCheckboxItem key={s.value} checked={sort === s.value} onCheckedChange={() => setSort(s.value)}>{s.label}</DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <ViewToggle value={view} onChange={setView} />
        </div>
      } />

      {selected.size > 0 && (
        <div className="sticky top-0 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-control border border-border bg-popover p-2 shadow-sm">
          <span className="px-1 text-sm font-medium">{selected.size} selected</span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => runBulk('pin')} className="gap-1.5"><Pin className="size-4" />Pin</Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="gap-1.5"><FolderOpen className="size-4" />Move</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-72 w-52 overflow-y-auto">
                <DropdownMenuLabel>Move to collection</DropdownMenuLabel><DropdownMenuSeparator />
                {collections.map(col => <DropdownMenuItem key={col.id} onClick={() => runBulk('move', { collectionId: col.id })}><FolderOpen className="size-4" /><span className="truncate">{col.name}</span></DropdownMenuItem>)}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => runBulk('move', { collectionId: null })}>Remove from collection</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="ghost" size="sm" onClick={() => runBulk('archive')} className="gap-1.5"><Archive className="size-4" />Archive</Button>
            <Button variant="ghost" size="sm" onClick={() => runBulk('delete')} className="gap-1.5 text-destructive hover:text-destructive"><Trash2 className="size-4" />Delete</Button>
            <Button variant="ghost" size="icon-sm" onClick={clearSelection} aria-label="Clear selection"><X className="size-4" /></Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-20"><Spinner size="lg" /></div>
      ) : items.length === 0 ? (
        isRootView ? (
          <EmptyAppState
            icon={Bookmark}
            gradient={getAppByPath('/bookmarks')?.gradient}
            title="Your private read-it-later & web archive"
            tagline="Save any link, read it later distraction-free, and keep a full offline copy that's yours forever. Searchable, taggable, and never disappears when the web does."
            actions={
              <>
                <Button onClick={openSave}><Plus className="mr-1.5 size-4" /> Save your first link</Button>
                <Link to="/bookmarks/settings"><Button variant="outline">Get the Save bookmarklet</Button></Link>
              </>
            }
            features={[
              { icon: Bookmark, title: 'Live links & dashboards', desc: 'Pin services and sites. Open them in a tab or embedded right here.' },
              { icon: FileText, title: 'Read it later', desc: 'A clean, distraction-free reader view for any article you save.' },
              { icon: Download, title: 'Offline archives + PDF', desc: 'Full-page snapshots and a printed PDF you can read with no connection.' },
              { icon: History, title: 'Versioned captures', desc: 'Re-archive to track how a page changes. Old versions stay readable.' },
              { icon: Upload, title: 'Import your stuff', desc: 'Bring bookmarks from Pocket, Pinboard, or your browser (HTML / JSON / CSV).' },
              { icon: Globe, title: 'Save from anywhere', desc: 'Drag the Save-to-Loki bookmarklet to your bar and clip any page in a click.' },
            ]}
            footnote="Everything stays on your hardware. Nothing is sent to the cloud."
          />
        ) : (
          <div className="py-20 text-center text-muted-foreground">
            Nothing here yet. Use <span className="font-medium text-foreground">Save</span> to add a link or article.
          </div>
        )
      ) : (
        <div className={gridClass}>
          {items.map(item => (
            <BookmarkCard
              key={item.id}
              item={item}
              collById={collById}
              view={view}
              activeCollectionId={collectionParam}
              selectable
              selected={selected.has(item.id)}
              onToggleSelect={() => toggleSelect(item.id)}
              actions={{
                onOpen: openItem,
                onMove: moveToCollection,
                onEdit: setEditItem,
                onArchive: archive,
                onDelete: setConfirmDel,
                onTogglePin: togglePin,
                collections,
              }}
            />
          ))}
        </div>
      )}

      <BookmarkEditDialog item={editItem} open={!!editItem} onClose={() => setEditItem(null)} />
      {activeCollection && (
        <CollectionShareDialog collection={activeCollection} open={shareCollection} onOpenChange={setShareCollection} />
      )}

      <ConfirmDialog
        open={!!confirmDel}
        onOpenChange={(o) => { if (!o) setConfirmDel(null) }}
        title="Delete this item?"
        description={confirmDel?.title}
        confirmLabel="Delete"
        onConfirm={() => { if (confirmDel) void doDelete(confirmDel); setConfirmDel(null) }}
      />
    </PageContainer>
  )
}
