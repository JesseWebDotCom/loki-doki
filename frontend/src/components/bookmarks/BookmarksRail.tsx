import { useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Home, Library, Circle, Archive, Bookmark, FileText, Plus, FolderOpen, Tag, Upload, Download, Settings2, Pencil, Pin, ChevronRight, FileUp, Users, type LucideIcon } from 'lucide-react'
import { AppRailHeader } from '@/components/shared/AppRailHeader'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { listCollections, listTags, importBookmarks, createCollection, uploadFile, type BookmarkCollection } from '@/lib/bookmarks/api'
import { getIconChoice } from '@/components/shared/IconPicker'
import { resolveProjectColor } from '@/components/shared/ColorPicker'
import { CollectionEditor } from './CollectionEditor'

function FilterLink({ to, icon: Icon, label, active }: { to: string; icon: LucideIcon; label: string; active: boolean }) {
  return (
    <Link to={to}
      className={cn('flex items-center gap-3 rounded-control px-3 py-2 text-sm font-medium transition-colors',
        active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground')}>
      <Icon className="size-[18px]" /> {label}
    </Link>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 mt-5 px-3 text-overline text-muted-foreground/50">{children}</p>
}

// A single collection row (navigates + shows icon/color, hover-edit). Chevron toggles
// children when it has any; depth controls indentation.
function CollectionRow({ collection, active, depth, hasChildren, expanded, onToggle, onEdit }: {
  collection: BookmarkCollection; active: boolean; depth: number
  hasChildren: boolean; expanded: boolean; onToggle: () => void; onEdit: () => void
}) {
  const Icon = getIconChoice(collection.icon)?.Icon ?? FolderOpen
  const color = collection.color ? resolveProjectColor(collection.color) : undefined
  return (
    <div className={cn('group flex items-center gap-0.5 rounded-control pr-1 transition-colors', active ? 'bg-accent' : 'hover:bg-accent/50')}
      style={{ paddingLeft: depth * 12 }}>
      <button onClick={onToggle} aria-label={hasChildren ? (expanded ? 'Collapse' : 'Expand') : undefined}
        className={cn('flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground', !hasChildren && 'invisible')}>
        <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
      </button>
      <Link to={`/bookmarks/collection/${collection.id}`}
        className={cn('flex min-w-0 flex-1 items-center gap-2.5 rounded-control py-2 text-sm font-medium transition-colors',
          active ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground')}>
        <Icon className="size-[18px] shrink-0" style={color ? { color } : undefined} />
        <span className="truncate">{collection.name}</span>
        {collection.linkCount > 0 && <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/60">{collection.linkCount}</span>}
      </Link>
      <Button variant="ghost" size="icon-sm" onClick={(e) => { e.preventDefault(); onEdit() }} aria-label={`Edit ${collection.name}`}
        className="size-6 shrink-0 rounded-control text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100">
        <Pencil className="size-3.5" />
      </Button>
    </div>
  )
}

export function BookmarksRail({ onSave, variant = 'sidebar' }: { onSave: () => void; variant?: 'sidebar' | 'drawer' }) {
  const drawer = variant === 'drawer'
  const qc = useQueryClient()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { id: collectionParam } = useParams()
  const fileRef = useRef<HTMLInputElement>(null)
  const uploadRef = useRef<HTMLInputElement>(null)

  const { data: collections = [] } = useQuery({ queryKey: ['bookmark-collections'], queryFn: listCollections })
  const { data: tags = [] } = useQuery({ queryKey: ['bookmark-tags'], queryFn: listTags })
  const [newCollection, setNewCollection] = useState<string | null>(null)
  const [editing, setEditing] = useState<BookmarkCollection | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const creatingRef = useRef(false)

  // Split into owned tree + shared-with-me, and index children by parent.
  const owned = useMemo(() => collections.filter(c => c.role === 'owner'), [collections])
  const shared = useMemo(() => collections.filter(c => c.role !== 'owner'), [collections])
  const childrenOf = useMemo(() => {
    const map = new Map<string | null, BookmarkCollection[]>()
    for (const c of owned) {
      const key = c.parentId && owned.some(o => o.id === c.parentId) ? c.parentId : null
      const list = map.get(key) ?? []; list.push(c); map.set(key, list)
    }
    return map
  }, [owned])

  async function submitNewCollection(e: React.FormEvent) {
    e.preventDefault()
    if (creatingRef.current) return
    const name = (newCollection ?? '').trim()
    if (!name) { setNewCollection(null); return }
    creatingRef.current = true
    try {
      await createCollection(name)
      qc.invalidateQueries({ queryKey: ['bookmark-collections'] })
      toast.success(`Created "${name}"`)
    } catch { toast.error('Failed to create collection') }
    finally { creatingRef.current = false; setNewCollection(null) }
  }

  const isHome = pathname === '/bookmarks' || pathname === '/bookmarks/'
  const isAll = pathname === '/bookmarks/all'
  const status = params.get('status')
  const type = params.get('type')
  const tag = params.get('tag')
  const pinned = params.get('pinned') === '1'

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const n = await importBookmarks(await file.text())
      toast.success(`Imported ${n} bookmark${n === 1 ? '' : 's'}`)
      qc.invalidateQueries({ queryKey: ['bookmarks'] }); qc.invalidateQueries({ queryKey: ['bookmark-collections'] })
    } catch { toast.error('Import failed') }
    finally { if (fileRef.current) fileRef.current.value = '' }
  }

  async function onUploadFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const item = await uploadFile(file, { collectionId: collectionParam ?? null })
      toast.success('File uploaded')
      qc.invalidateQueries({ queryKey: ['bookmarks'] }); qc.invalidateQueries({ queryKey: ['bookmark-home'] })
      navigate(`/bookmarks/read/${item.id}`)
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Upload failed') }
    finally { if (uploadRef.current) uploadRef.current.value = '' }
  }

  // Recursive collection tree render.
  function renderTree(parentId: string | null, depth: number): React.ReactNode {
    const kids = childrenOf.get(parentId) ?? []
    return kids.map(c => {
      const hasChildren = (childrenOf.get(c.id) ?? []).length > 0
      const expanded = !collapsed.has(c.id)
      return (
        <div key={c.id}>
          <CollectionRow collection={c} active={collectionParam === c.id} depth={depth}
            hasChildren={hasChildren} expanded={expanded}
            onToggle={() => setCollapsed(prev => { const next = new Set(prev); next.has(c.id) ? next.delete(c.id) : next.add(c.id); return next })}
            onEdit={() => setEditing(c)} />
          {hasChildren && expanded && renderTree(c.id, depth + 1)}
        </div>
      )
    })
  }

  return (
    <nav className={cn(
      'h-full min-h-0 shrink-0 flex-col overflow-y-auto overscroll-none px-3 py-5',
      drawer ? 'flex w-full' : 'hidden w-60 border-r border-border/40 lg:flex',
    )}>
      <AppRailHeader title="Bookmarks" className="mb-3" />
      <Button onClick={onSave} className="mb-3 h-auto w-full justify-center gap-2 rounded-control px-3 py-2 text-sm font-semibold">
        <Plus className="size-4" /> Save
      </Button>

      <FilterLink to="/bookmarks" icon={Home} label="Home" active={isHome} />
      <FilterLink to="/bookmarks/all" icon={Library} label="All bookmarks" active={isAll && !status && !type && !pinned} />
      <FilterLink to="/bookmarks/all?status=unread" icon={Circle} label="Unread" active={status === 'unread'} />
      <FilterLink to="/bookmarks/all?pinned=1" icon={Pin} label="Pinned" active={pinned} />
      <FilterLink to="/bookmarks/all?status=archived" icon={Archive} label="Archived" active={status === 'archived'} />

      <SectionLabel>Type</SectionLabel>
      <FilterLink to="/bookmarks/all?type=live" icon={Bookmark} label="Live links" active={type === 'live'} />
      <FilterLink to="/bookmarks/all?type=offline" icon={FileText} label="Offline articles" active={type === 'offline'} />

      <SectionLabel>Collections</SectionLabel>
      {renderTree(null, 0)}
      {newCollection !== null ? (
        <form onSubmit={submitNewCollection} className="px-1 py-1">
          <input autoFocus value={newCollection} onChange={e => setNewCollection(e.target.value)} onBlur={submitNewCollection}
            placeholder="Collection name…"
            className="w-full rounded-control border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary" />
        </form>
      ) : (
        <Button variant="ghost" onClick={() => setNewCollection('')}
          className="h-auto w-full justify-start gap-3 rounded-control px-3 py-2 text-sm font-normal text-muted-foreground hover:text-foreground">
          <Plus className="size-[18px]" /> New collection
        </Button>
      )}

      {shared.length > 0 && <>
        <SectionLabel>Shared with me</SectionLabel>
        {shared.map(c => (
          <Link key={c.id} to={`/bookmarks/collection/${c.id}`}
            className={cn('flex items-center gap-2.5 rounded-control px-3 py-2 text-sm font-medium transition-colors',
              collectionParam === c.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground')}>
            <Users className="size-[18px] shrink-0" />
            <span className="truncate">{c.name}</span>
            {c.ownerName && <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/60">{c.ownerName}</span>}
          </Link>
        ))}
      </>}

      <div className="mb-1 mt-5 flex items-center justify-between px-3">
        <span className="text-overline text-muted-foreground/50">Tags</span>
        <Link to="/bookmarks/tags" className="text-[11px] text-muted-foreground/60 hover:text-foreground">Manage</Link>
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-2">
          {tags.map(t => (
            <Link key={t.id} to={`/bookmarks/all?tag=${encodeURIComponent(t.name)}`}
              className={cn('rounded-full px-2.5 py-1 text-xs transition-colors',
                tag === t.name ? 'bg-primary text-primary-foreground' : 'bg-accent/50 text-muted-foreground hover:text-foreground')}>
              <Tag className="mr-1 inline size-3" />{t.name}
            </Link>
          ))}
        </div>
      )}

      <div className="mt-auto space-y-0.5 pt-5">
        <FilterLink to="/bookmarks/settings" icon={Settings2} label="Settings" active={pathname === '/bookmarks/settings'} />
        <Button variant="ghost" onClick={() => uploadRef.current?.click()}
          className="h-auto w-full justify-start gap-3 rounded-control px-3 py-2 text-sm font-normal text-muted-foreground hover:text-foreground">
          <FileUp className="size-[18px]" /> Upload PDF / image
        </Button>
        <Button variant="ghost" onClick={() => fileRef.current?.click()}
          className="h-auto w-full justify-start gap-3 rounded-control px-3 py-2 text-sm font-normal text-muted-foreground hover:text-foreground">
          <Upload className="size-[18px]" /> Import bookmarks
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost"
              className="h-auto w-full justify-start gap-3 rounded-control px-3 py-2 text-sm font-normal text-muted-foreground hover:text-foreground">
              <Download className="size-[18px]" /> Export bookmarks
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuLabel>Export as</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild><a href="/api/bookmarks/export/html">HTML (Netscape)</a></DropdownMenuItem>
            <DropdownMenuItem asChild><a href="/api/bookmarks/export/json">JSON</a></DropdownMenuItem>
            <DropdownMenuItem asChild><a href="/api/bookmarks/export/csv">CSV</a></DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <input ref={fileRef} type="file" accept=".html,.htm,.json,.csv,text/html,application/json,text/csv" className="hidden" onChange={onImportFile} />
        <input ref={uploadRef} type="file" accept="application/pdf,image/*" className="hidden" onChange={onUploadFile} />
      </div>

      <CollectionEditor open={editing !== null} collection={editing}
        onOpenChange={(o) => { if (!o) setEditing(null) }}
        onDeleted={() => { if (editing && collectionParam === editing.id) navigate('/bookmarks') }} />
    </nav>
  )
}
