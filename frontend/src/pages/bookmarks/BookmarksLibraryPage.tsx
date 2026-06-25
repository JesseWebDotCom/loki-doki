import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Globe, FileText, Bookmark, Loader2, Trash2, Archive, ExternalLink, AlertTriangle, FolderOpen, Check, Pencil, BookOpen, Download, History, Upload, Plus } from 'lucide-react'
import { toast } from '@/lib/toast'
import { proxyImg } from '@/lib/img'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { useBookmarkUI } from '@/components/bookmarks/BookmarksLayout'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { BookmarkEditDialog } from '@/components/bookmarks/BookmarkEditDialog'
import { getIconChoice } from '@/components/shared/IconPicker'
import { resolveProjectColor } from '@/components/shared/ColorPicker'
import { listItems, deleteItem, updateItem, listCollections, type BookmarkItem, type BookmarkCollection, type ListParams } from '@/lib/bookmarks/api'

function Favicon({ item }: { item: BookmarkItem }) {
  if (item.faviconUrl) {
    return <img src={proxyImg(item.faviconUrl)} alt="" className="size-4 shrink-0 rounded-sm object-contain"
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
  }
  return <Globe className="size-4 shrink-0 text-muted-foreground" />
}

function host(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

// Locally-archived page thumbnail (og:image / first article image), served from the
// snapshot dir. Null for items without a saved snapshot.
function thumbUrl(item: BookmarkItem): string | null {
  return item.ogImagePath ? `/api/bookmarks/${item.id}/archive/${item.ogImagePath}` : null
}

function ArchiveBadge({ item }: { item: BookmarkItem }) {
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

// The collection an item belongs to, rendered with the collection's chosen icon/color.
function CollectionChip({ collection }: { collection: BookmarkCollection }) {
  const Icon = getIconChoice(collection.icon)?.Icon ?? FolderOpen
  const color = collection.color ? resolveProjectColor(collection.color) : undefined
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-accent/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      <Icon className="size-3" style={color ? { color } : undefined} />
      {collection.name}
    </span>
  )
}

export function BookmarksLibraryPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { openSave } = useBookmarkUI()
  const [params] = useSearchParams()
  const { id: collectionParam } = useParams()
  const [search, setSearch] = useState('')
  const [confirmDel, setConfirmDel] = useState<BookmarkItem | null>(null)
  const [editItem, setEditItem] = useState<BookmarkItem | null>(null)

  // The default Library view (no filter/search) → show the app pitch when empty; a filtered
  // view that happens to be empty just gets a short line.
  const isRootView = !collectionParam && !params.get('status') && !params.get('type') && !params.get('tag') && !search.trim()

  const filters: ListParams = useMemo(() => ({
    status: (params.get('status') as ListParams['status']) || undefined,
    type: (params.get('type') as ListParams['type']) || undefined,
    tag: params.get('tag') || undefined,
    collectionId: collectionParam || undefined,
    q: params.get('tag') ? undefined : (search.trim() || undefined),
  }), [params, collectionParam, search])

  const { data: collections = [] } = useQuery({ queryKey: ['bookmark-collections'], queryFn: listCollections })
  const collById = useMemo(() => new Map(collections.map(c => [c.id, c])), [collections])

  async function moveToCollection(item: BookmarkItem, collectionId: string | null) {
    await updateItem(item.id, { collectionId })
    qc.invalidateQueries({ queryKey: ['bookmarks'] })
    toast.success(collectionId ? 'Moved to collection' : 'Removed from collection')
  }

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['bookmarks', filters],
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
  useAppHeader({
    query: search,
    setQuery: setSearch,
    placeholder: 'Search your library…',
  })

  function openItem(item: BookmarkItem) {
    if (item.type === 'live' && !item.useEmbed) { window.open(item.url, '_blank', 'noopener'); return }
    navigate(`/bookmarks/read/${item.id}`)
  }

  async function archive(item: BookmarkItem) {
    await updateItem(item.id, { status: item.status === 'archived' ? 'unread' : 'archived' })
    qc.invalidateQueries({ queryKey: ['bookmarks'] })
  }
  async function doDelete(item: BookmarkItem) {
    try { await deleteItem(item.id); toast.success('Deleted'); qc.invalidateQueries({ queryKey: ['bookmarks'] }) }
    catch { toast.error('Failed to delete') }
  }

  return (
    <div className="mx-auto max-w-6xl px-5 py-6">
      <h1 className="mb-5 text-2xl font-bold capitalize">{heading}</h1>

      {isLoading ? (
        <div className="flex justify-center py-20 text-muted-foreground"><Loader2 className="size-6 animate-spin" /></div>
      ) : items.length === 0 ? (
        isRootView ? (
          <EmptyAppState
            icon={BookOpen}
            gradient="linear-gradient(135deg,#14532d,#166534)"
            title="Your private read-it-later & web archive"
            tagline="Save any link, read it later distraction-free, and keep a full offline copy that's yours forever — searchable, taggable, and never disappears when the web does."
            actions={
              <>
                <Button onClick={openSave}><Plus className="mr-1.5 size-4" /> Save your first link</Button>
                <Link to="/bookmarks/settings"><Button variant="outline">Get the Save bookmarklet</Button></Link>
              </>
            }
            features={[
              { icon: Bookmark, title: 'Live links & dashboards', desc: 'Pin services and sites — open them in a tab or embedded right here.' },
              { icon: FileText, title: 'Read it later', desc: 'A clean, distraction-free reader view for any article you save.' },
              { icon: Download, title: 'Offline archives + PDF', desc: 'Full-page snapshots and a printed PDF you can read with no connection.' },
              { icon: History, title: 'Versioned captures', desc: 'Re-archive to track how a page changes — old versions stay readable.' },
              { icon: Upload, title: 'Import your stuff', desc: 'Bring bookmarks from Pocket, Pinboard, or your browser (HTML / JSON / CSV).' },
              { icon: Globe, title: 'Save from anywhere', desc: 'Drag the Save-to-Loki bookmarklet to your bar and clip any page in a click.' },
            ]}
            footnote="Everything stays on your hardware — nothing is sent to the cloud."
          />
        ) : (
          <div className="py-20 text-center text-muted-foreground">
            Nothing here yet. Use <span className="font-medium text-foreground">Save</span> to add a link or article.
          </div>
        )
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map(item => (
            <div key={item.id}
              className="group relative flex flex-col rounded-2xl border border-border/60 bg-card p-4 transition-colors hover:border-border">
              <button onClick={() => openItem(item)} className="flex-1 text-left">
                {thumbUrl(item) && (
                  <div className="relative -mx-4 -mt-4 mb-3 aspect-video overflow-hidden rounded-t-2xl border-b border-border/40 bg-muted/40">
                    <img src={thumbUrl(item)!} alt="" loading="lazy"
                      className="size-full object-cover"
                      onError={(e) => { const el = e.currentTarget.parentElement; if (el) el.style.display = 'none' }} />
                    {item.faviconUrl && (
                      <img src={proxyImg(item.faviconUrl)} alt="" loading="lazy"
                        className="absolute bottom-2 left-2 size-6 rounded-md border border-border/40 bg-background/90 p-0.5 shadow-sm"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                    )}
                  </div>
                )}
                <div className="mb-2 flex items-center gap-2">
                  <Favicon item={item} />
                  <span className="truncate text-xs text-muted-foreground">{item.siteName || host(item.url)}</span>
                </div>
                <p className="mb-2 line-clamp-2 font-semibold leading-snug">{item.title || item.url}</p>
                {item.excerpt && <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">{item.excerpt}</p>}
                <div className="flex flex-wrap items-center gap-2">
                  <ArchiveBadge item={item} />
                  {item.isGlobal && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-400" title="Shared with everyone">
                      <Globe className="size-3" />Shared
                    </span>
                  )}
                  {item.collectionId && item.collectionId !== collectionParam && collById.has(item.collectionId) && (
                    <CollectionChip collection={collById.get(item.collectionId)!} />
                  )}
                  {item.tags.slice(0, 2).map(t => <span key={t} className="rounded-full bg-accent/60 px-2 py-0.5 text-[10px] text-muted-foreground">{t}</span>)}
                </div>
              </button>
              {item.canEdit && (
                <div className="absolute right-2 top-2 flex gap-1 rounded-lg bg-background/80 p-0.5 opacity-0 shadow-md ring-1 ring-border/60 backdrop-blur transition-opacity group-hover:opacity-100">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button title="Move to collection"
                        className="rounded-md p-1.5 text-foreground/80 hover:bg-accent hover:text-foreground"><FolderOpen className="size-4" /></button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      <DropdownMenuLabel>Move to collection</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {collections.length === 0 && (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">No collections yet — create one in the sidebar.</div>
                      )}
                      {collections.map(col => (
                        <DropdownMenuItem key={col.id} onClick={() => moveToCollection(item, col.id)}>
                          <FolderOpen className="size-4" />
                          <span className="flex-1 truncate">{col.name}</span>
                          {item.collectionId === col.id && <Check className="size-4" />}
                        </DropdownMenuItem>
                      ))}
                      {item.collectionId && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => moveToCollection(item, null)}>Remove from collection</DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <button onClick={() => setEditItem(item)} title="Edit"
                    className="rounded-md p-1.5 text-foreground/80 hover:bg-accent hover:text-foreground"><Pencil className="size-4" /></button>
                  <a href={item.url} target="_blank" rel="noopener noreferrer" title="Open original"
                    className="rounded-md p-1.5 text-foreground/80 hover:bg-accent hover:text-foreground"><ExternalLink className="size-4" /></a>
                  <button onClick={() => archive(item)} title="Archive"
                    className="rounded-md p-1.5 text-foreground/80 hover:bg-accent hover:text-foreground"><Archive className="size-4" /></button>
                  <button onClick={() => setConfirmDel(item)} title="Delete"
                    className="rounded-md p-1.5 text-foreground/80 hover:bg-red-500/20 hover:text-red-400"><Trash2 className="size-4" /></button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <BookmarkEditDialog item={editItem} open={!!editItem} onClose={() => setEditItem(null)} />

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
