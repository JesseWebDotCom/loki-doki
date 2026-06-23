import { useRef, useState } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Library, Circle, Archive, Bookmark, FileText, Plus, FolderOpen, Tag, Upload, Download, Settings2, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { listCollections, listTags, importBookmarksHtml, createCollection } from '@/lib/reader/api'

// A rail link that is "active" based on the current path + search params (filters
// live in the query string, which NavLink can't match on its own).
function FilterLink({ to, icon: Icon, label, active }: { to: string; icon: LucideIcon; label: string; active: boolean }) {
  return (
    <Link to={to}
      className={cn('flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors',
        active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground')}>
      <Icon className="size-[18px]" /> {label}
    </Link>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 mt-5 px-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">{children}</p>
}

export function ReaderRail({ onSave }: { onSave: () => void }) {
  const qc = useQueryClient()
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  const { id: collectionParam } = useParams()
  const fileRef = useRef<HTMLInputElement>(null)

  const { data: collections = [] } = useQuery({ queryKey: ['reader-collections'], queryFn: listCollections })
  const { data: tags = [] } = useQuery({ queryKey: ['reader-tags'], queryFn: listTags })
  const [newCollection, setNewCollection] = useState<string | null>(null) // null = not creating
  const creatingRef = useRef(false) // guard Enter + blur both firing the submit

  async function submitNewCollection(e: React.FormEvent) {
    e.preventDefault()
    if (creatingRef.current) return
    const name = (newCollection ?? '').trim()
    if (!name) { setNewCollection(null); return }
    creatingRef.current = true
    try {
      await createCollection(name)
      qc.invalidateQueries({ queryKey: ['reader-collections'] })
      toast.success(`Created "${name}"`)
    } catch { toast.error('Failed to create collection') }
    finally { creatingRef.current = false; setNewCollection(null) }
  }

  const isLibraryRoot = pathname === '/reader' || pathname === '/reader/'
  const status = params.get('status')
  const type = params.get('type')
  const tag = params.get('tag')

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const n = await importBookmarksHtml(await file.text())
      toast.success(`Imported ${n} bookmark${n === 1 ? '' : 's'}`)
      qc.invalidateQueries({ queryKey: ['reader-items'] })
      qc.invalidateQueries({ queryKey: ['reader-collections'] })
    } catch { toast.error('Import failed') }
    finally { if (fileRef.current) fileRef.current.value = '' }
  }

  return (
    <nav className="hidden h-full min-h-0 w-60 shrink-0 flex-col overflow-y-auto overscroll-none border-r border-border/40 px-3 py-5 lg:flex">
      <button onClick={onSave}
        className="mb-3 flex items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90">
        <Plus className="size-4" /> Save
      </button>

      <FilterLink to="/reader" icon={Library} label="All" active={isLibraryRoot && !status && !type && !tag} />
      <FilterLink to="/reader?status=unread" icon={Circle} label="Unread" active={status === 'unread'} />
      <FilterLink to="/reader?status=archived" icon={Archive} label="Archived" active={status === 'archived'} />

      <SectionLabel>Type</SectionLabel>
      <FilterLink to="/reader?type=live" icon={Bookmark} label="Live links" active={type === 'live'} />
      <FilterLink to="/reader?type=offline" icon={FileText} label="Offline articles" active={type === 'offline'} />

      <SectionLabel>Collections</SectionLabel>
      {collections.map(c => (
        <FilterLink key={c.id} to={`/reader/collection/${c.id}`} icon={FolderOpen} label={c.name} active={collectionParam === c.id} />
      ))}
      {newCollection !== null ? (
        <form onSubmit={submitNewCollection} className="px-1 py-1">
          <input
            autoFocus
            value={newCollection}
            onChange={e => setNewCollection(e.target.value)}
            onBlur={submitNewCollection}
            placeholder="Collection name…"
            className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary"
          />
        </form>
      ) : (
        <button onClick={() => setNewCollection('')}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground">
          <Plus className="size-[18px]" /> New collection
        </button>
      )}

      {tags.length > 0 && <>
        <SectionLabel>Tags</SectionLabel>
        <div className="flex flex-wrap gap-1.5 px-2">
          {tags.map(t => (
            <Link key={t.id} to={`/reader?tag=${encodeURIComponent(t.name)}`}
              className={cn('rounded-full px-2.5 py-1 text-xs transition-colors',
                tag === t.name ? 'bg-primary text-primary-foreground' : 'bg-accent/50 text-muted-foreground hover:text-foreground')}>
              <Tag className="mr-1 inline size-3" />{t.name}
            </Link>
          ))}
        </div>
      </>}

      <div className="mt-auto space-y-0.5 pt-5">
        <FilterLink to="/reader/settings" icon={Settings2} label="Settings" active={pathname === '/reader/settings'} />
        <button onClick={() => fileRef.current?.click()}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground">
          <Upload className="size-[18px]" /> Import bookmarks
        </button>
        <a href="/api/reader/export/html"
          className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground">
          <Download className="size-[18px]" /> Export bookmarks
        </a>
        <input ref={fileRef} type="file" accept=".html,text/html" className="hidden" onChange={onImportFile} />
      </div>
    </nav>
  )
}
