import { Globe, FileText, Bookmark, Trash2, Archive, ExternalLink, FolderOpen, Check, Pencil, AlertTriangle, Pin, PinOff, FileType, Image as ImageIcon } from 'lucide-react'
import { proxyImg } from '@/lib/img'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { getIconChoice } from '@/components/shared/IconPicker'
import { resolveProjectColor } from '@/components/shared/ColorPicker'
import type { CardListView } from '@/components/shared/ViewToggle'
import type { BookmarkItem, BookmarkCollection } from '@/lib/bookmarks/api'

export function host(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

function Favicon({ item }: { item: BookmarkItem }) {
  if (item.contentKind === 'pdf') return <FileType className="size-4 shrink-0 text-destructive" />
  if (item.contentKind === 'image') return <ImageIcon className="size-4 shrink-0 text-info" />
  if (item.faviconUrl) {
    return <img src={proxyImg(item.faviconUrl)} alt="" className="size-4 shrink-0 rounded-[3px] object-contain"
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
  }
  return <Globe className="size-4 shrink-0 text-muted-foreground" />
}

// Locally-archived page thumbnail (og:image / first article image / uploaded image),
// served from the snapshot dir. Null for items without a saved thumbnail.
function thumbUrl(item: BookmarkItem): string | null {
  return item.ogImagePath ? `/api/bookmarks/${item.id}/archive/${item.ogImagePath}` : null
}

export function ArchiveBadge({ item }: { item: BookmarkItem }) {
  if (item.contentKind === 'pdf') return <span className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-medium text-destructive"><FileType className="size-3" />PDF</span>
  if (item.contentKind === 'image') return <span className="inline-flex items-center gap-1 rounded-full bg-info/15 px-2 py-0.5 text-[10px] font-medium text-info"><ImageIcon className="size-3" />Image</span>
  if (item.type === 'live') return <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-medium text-success"><Bookmark className="size-3" />Live</span>
  if (item.archiveState === 'pending' || item.archiveState === 'fetching') return <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-medium text-warning"><Spinner className="size-3 text-warning" />Saving</span>
  if (item.archiveState === 'failed') return <span className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-medium text-destructive"><AlertTriangle className="size-3" />Failed</span>
  return <span className="inline-flex items-center gap-1 rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-medium text-brand"><FileText className="size-3" />{item.readingMins || 1} min</span>
}

export function CollectionChip({ collection }: { collection: BookmarkCollection }) {
  const Icon = getIconChoice(collection.icon)?.Icon ?? FolderOpen
  const color = collection.color ? resolveProjectColor(collection.color) : undefined
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-accent/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      <Icon className="size-3" style={color ? { color } : undefined} />
      {collection.name}
    </span>
  )
}

export interface BookmarkCardActions {
  onOpen: (item: BookmarkItem) => void
  onMove?: (item: BookmarkItem, collectionId: string | null) => void
  onEdit?: (item: BookmarkItem) => void
  onArchive?: (item: BookmarkItem) => void
  onDelete?: (item: BookmarkItem) => void
  onTogglePin?: (item: BookmarkItem) => void
  collections?: BookmarkCollection[]
}

function Meta({ item, collById, activeCollectionId }: { item: BookmarkItem; collById: Map<string, BookmarkCollection>; activeCollectionId?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ArchiveBadge item={item} />
      {item.isPinned && <Pin className="size-3 text-primary" />}
      {item.isGlobal && (
        <span className="inline-flex items-center gap-1 rounded-full bg-info/15 px-2 py-0.5 text-[10px] font-medium text-info" title="Shared with everyone"><Globe className="size-3" />Shared</span>
      )}
      {item.collectionId && item.collectionId !== activeCollectionId && collById.has(item.collectionId) && (
        <CollectionChip collection={collById.get(item.collectionId)!} />
      )}
      {item.tags.slice(0, 2).map(t => <span key={t} className="rounded-full bg-accent/60 px-2 py-0.5 text-[10px] text-muted-foreground">{t}</span>)}
    </div>
  )
}

function ActionBar({ item, actions, className }: { item: BookmarkItem; actions: BookmarkCardActions; className?: string }) {
  const { onMove, onEdit, onArchive, onDelete, onTogglePin, collections = [] } = actions
  return (
    <div className={cn('flex gap-1 rounded-control bg-popover p-0.5 shadow-md ring-1 ring-border/60', className)}>
      {onTogglePin && (
        <Button variant="ghost" size="icon-sm" onClick={() => onTogglePin(item)} title={item.isPinned ? 'Unpin' : 'Pin'} aria-label={item.isPinned ? 'Unpin' : 'Pin'}
          className="text-foreground/80 hover:text-foreground">{item.isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}</Button>
      )}
      {onMove && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" title="Move to collection" aria-label="Move to collection" className="text-foreground/80 hover:text-foreground"><FolderOpen className="size-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-72 w-52 overflow-y-auto">
            <DropdownMenuLabel>Move to collection</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {collections.length === 0 && <div className="px-2 py-1.5 text-xs text-muted-foreground">No collections yet.</div>}
            {collections.map(col => (
              <DropdownMenuItem key={col.id} onClick={() => onMove(item, col.id)}>
                <FolderOpen className="size-4" /><span className="flex-1 truncate">{col.name}</span>
                {item.collectionId === col.id && <Check className="size-4" />}
              </DropdownMenuItem>
            ))}
            {item.collectionId && <><DropdownMenuSeparator /><DropdownMenuItem onClick={() => onMove(item, null)}>Remove from collection</DropdownMenuItem></>}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {onEdit && <Button variant="ghost" size="icon-sm" onClick={() => onEdit(item)} title="Edit" aria-label="Edit" className="text-foreground/80 hover:text-foreground"><Pencil className="size-4" /></Button>}
      <Button asChild variant="ghost" size="icon-sm" className="text-foreground/80 hover:text-foreground">
        <a href={item.url} target="_blank" rel="noopener noreferrer" title="Open original" aria-label="Open original"><ExternalLink className="size-4" /></a>
      </Button>
      {onArchive && <Button variant="ghost" size="icon-sm" onClick={() => onArchive(item)} title="Archive" aria-label="Archive" className="text-foreground/80 hover:text-foreground"><Archive className="size-4" /></Button>}
      {onDelete && <Button variant="ghost" size="icon-sm" onClick={() => onDelete(item)} title="Delete" aria-label="Delete" className="text-foreground/80 hover:text-destructive"><Trash2 className="size-4" /></Button>}
    </div>
  )
}

// Small circular multi-select checkbox overlaid on a card / row.
function SelectDot({ selected, onToggle }: { selected: boolean; onToggle: () => void }) {
  return (
    <button onClick={(e) => { e.stopPropagation(); onToggle() }} aria-label={selected ? 'Deselect' : 'Select'} aria-pressed={selected}
      className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors',
        selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background/80 text-transparent hover:border-primary')}>
      <Check className="size-3.5" />
    </button>
  )
}

export function BookmarkCard({
  item, collById, view, actions, activeCollectionId,
  selectable, selected, onToggleSelect,
}: {
  item: BookmarkItem
  collById: Map<string, BookmarkCollection>
  view: CardListView
  actions: BookmarkCardActions
  activeCollectionId?: string
  selectable?: boolean
  selected?: boolean
  onToggleSelect?: () => void
}) {
  const thumb = thumbUrl(item)
  const canEdit = item.canEdit

  // ── List row ──
  if (view === 'list') {
    return (
      <Card className={cn('group relative flex items-center gap-3 border-border/60 p-3 hover:border-border', selected && 'ring-2 ring-primary')}>
        {selectable && <SelectDot selected={!!selected} onToggle={() => onToggleSelect?.()} />}
        <button onClick={() => actions.onOpen(item)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          {thumb ? (
            <img src={thumb} alt="" loading="lazy" className="size-12 shrink-0 rounded-control border border-border/40 object-cover"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
          ) : (
            <div className="flex size-12 shrink-0 items-center justify-center rounded-control border border-border/40 bg-muted/40"><Favicon item={item} /></div>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold leading-snug">{item.title || item.url}</p>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate">{item.siteName || host(item.url)}</span>
            </div>
            <div className="mt-1.5"><Meta item={item} collById={collById} activeCollectionId={activeCollectionId} /></div>
          </div>
        </button>
        {canEdit && <ActionBar item={item} actions={actions} className="opacity-0 transition-opacity group-hover:opacity-100" />}
      </Card>
    )
  }

  // ── Card views (grid = 16:9, big = 9:16 poster) ──
  const aspect = view === 'big' ? 'aspect-[3/4]' : 'aspect-video'
  return (
    <Card className={cn('group relative flex flex-col border-border/60 p-4 hover:border-border', selected && 'ring-2 ring-primary')}>
      {selectable && <div className="absolute left-2 top-2 z-10 opacity-0 transition-opacity group-hover:opacity-100 aria-[pressed]:opacity-100" aria-pressed={selected}><SelectDot selected={!!selected} onToggle={() => onToggleSelect?.()} /></div>}
      <button onClick={() => actions.onOpen(item)} className="flex-1 text-left">
        {thumb && (
          <div className={cn('relative -mx-4 -mt-4 mb-3 overflow-hidden rounded-t-2xl border-b border-border/40 bg-muted/40', aspect)}>
            <img src={thumb} alt="" loading="lazy" className={cn('size-full', item.contentKind === 'image' ? 'object-contain' : 'object-cover')}
              onError={(e) => { const el = e.currentTarget.parentElement; if (el) el.style.display = 'none' }} />
            {item.faviconUrl && item.contentKind === 'link' && (
              <img src={proxyImg(item.faviconUrl)} alt="" loading="lazy"
                className="absolute bottom-2 left-2 size-6 rounded-control border border-border/40 bg-background/90 p-0.5 shadow-sm"
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
        <Meta item={item} collById={collById} activeCollectionId={activeCollectionId} />
      </button>
      {canEdit && <ActionBar item={item} actions={actions} className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100" />}
    </Card>
  )
}
