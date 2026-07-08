import { useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Library, Circle, Archive, Bookmark, FileText, Plus, FolderOpen, Tag, Upload, Download, Settings2, Pencil, type LucideIcon } from 'lucide-react'
import { AppRailHeader } from '@/components/shared/AppRailHeader'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { listCollections, listTags, importBookmarks, createCollection, type BookmarkCollection } from '@/lib/bookmarks/api'
import { getIconChoice } from '@/components/shared/IconPicker'
import { resolveProjectColor } from '@/components/shared/ColorPicker'
import { CollectionEditor } from './CollectionEditor'

// A rail link that is "active" based on the current path + search params (filters
// live in the query string, which NavLink can't match on its own).
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

// A collection row: navigates like a FilterLink, but renders the collection's chosen icon/color
// and reveals an edit button on hover.
function CollectionRow({ collection, active, onEdit }: { collection: BookmarkCollection; active: boolean; onEdit: () => void }) {
  const Icon = getIconChoice(collection.icon)?.Icon ?? FolderOpen
  const color = collection.color ? resolveProjectColor(collection.color) : undefined
  return (
    <div className={cn('group flex items-center gap-1 rounded-control pr-1 transition-colors',
      active ? 'bg-accent' : 'hover:bg-accent/50')}>
      <Link to={`/bookmarks/collection/${collection.id}`}
        className={cn('flex min-w-0 flex-1 items-center gap-3 rounded-control px-3 py-2 text-sm font-medium transition-colors',
          active ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground')}>
        <Icon className="size-[18px] shrink-0" style={color ? { color } : undefined} />
        <span className="truncate">{collection.name}</span>
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

  const { data: collections = [] } = useQuery({ queryKey: ['bookmark-collections'], queryFn: listCollections })
  const { data: tags = [] } = useQuery({ queryKey: ['bookmark-tags'], queryFn: listTags })
  const [newCollection, setNewCollection] = useState<string | null>(null) // null = not creating
  const [editing, setEditing] = useState<BookmarkCollection | null>(null)
  const creatingRef = useRef(false) // guard Enter + blur both firing the submit

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

  const isLibraryRoot = pathname === '/bookmarks' || pathname === '/bookmarks/'
  const status = params.get('status')
  const type = params.get('type')
  const tag = params.get('tag')

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const n = await importBookmarks(await file.text())
      toast.success(`Imported ${n} bookmark${n === 1 ? '' : 's'}`)
      qc.invalidateQueries({ queryKey: ['bookmarks'] })
      qc.invalidateQueries({ queryKey: ['bookmark-collections'] })
    } catch { toast.error('Import failed') }
    finally { if (fileRef.current) fileRef.current.value = '' }
  }

  return (
    <nav className={cn(
      'h-full min-h-0 shrink-0 flex-col overflow-y-auto overscroll-none px-3 py-5',
      drawer ? 'flex w-full' : 'hidden w-60 border-r border-border/40 lg:flex',
    )}>
      <AppRailHeader
        title="Bookmarks"
        className="mb-3"
      />
      <Button onClick={onSave}
        className="mb-3 h-auto w-full justify-center gap-2 rounded-control px-3 py-2 text-sm font-semibold">
        <Plus className="size-4" /> Save
      </Button>

      <FilterLink to="/bookmarks" icon={Library} label="All" active={isLibraryRoot && !status && !type && !tag} />
      <FilterLink to="/bookmarks?status=unread" icon={Circle} label="Unread" active={status === 'unread'} />
      <FilterLink to="/bookmarks?status=archived" icon={Archive} label="Archived" active={status === 'archived'} />

      <SectionLabel>Type</SectionLabel>
      <FilterLink to="/bookmarks?type=live" icon={Bookmark} label="Live links" active={type === 'live'} />
      <FilterLink to="/bookmarks?type=offline" icon={FileText} label="Offline articles" active={type === 'offline'} />

      <SectionLabel>Collections</SectionLabel>
      {collections.map(c => (
        <CollectionRow key={c.id} collection={c} active={collectionParam === c.id} onEdit={() => setEditing(c)} />
      ))}
      {newCollection !== null ? (
        <form onSubmit={submitNewCollection} className="px-1 py-1">
          <input
            autoFocus
            value={newCollection}
            onChange={e => setNewCollection(e.target.value)}
            onBlur={submitNewCollection}
            placeholder="Collection name…"
            className="w-full rounded-control border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary"
          />
        </form>
      ) : (
        <Button variant="ghost" onClick={() => setNewCollection('')}
          className="h-auto w-full justify-start gap-3 rounded-control px-3 py-2 text-sm font-normal text-muted-foreground hover:text-foreground">
          <Plus className="size-[18px]" /> New collection
        </Button>
      )}

      {tags.length > 0 && <>
        <SectionLabel>Tags</SectionLabel>
        <div className="flex flex-wrap gap-1.5 px-2">
          {tags.map(t => (
            <Link key={t.id} to={`/bookmarks?tag=${encodeURIComponent(t.name)}`}
              className={cn('rounded-full px-2.5 py-1 text-xs transition-colors',
                tag === t.name ? 'bg-primary text-primary-foreground' : 'bg-accent/50 text-muted-foreground hover:text-foreground')}>
              <Tag className="mr-1 inline size-3" />{t.name}
            </Link>
          ))}
        </div>
      </>}

      <div className="mt-auto space-y-0.5 pt-5">
        <FilterLink to="/bookmarks/settings" icon={Settings2} label="Settings" active={pathname === '/bookmarks/settings'} />
        <Button variant="ghost" onClick={() => fileRef.current?.click()}
          className="h-auto w-full justify-start gap-3 rounded-control px-3 py-2 text-sm font-normal text-muted-foreground hover:text-foreground">
          <Upload className="size-[18px]" /> Import bookmarks
        </Button>
        <a href="/api/bookmarks/export/html"
          className="flex items-center gap-3 rounded-control px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground">
          <Download className="size-[18px]" /> Export bookmarks
        </a>
        <input ref={fileRef} type="file" accept=".html,.htm,.json,.csv,text/html,application/json,text/csv" className="hidden" onChange={onImportFile} />
      </div>

      <CollectionEditor open={editing !== null} collection={editing}
        onOpenChange={(o) => { if (!o) setEditing(null) }}
        onDeleted={() => { if (editing && collectionParam === editing.id) navigate('/bookmarks') }} />
    </nav>
  )
}
