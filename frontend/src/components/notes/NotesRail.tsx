import { useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { StickyNote, User, Users, Plus, FolderOpen, Tag, Pencil, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { AppRailHeader } from '@/components/shared/AppRailHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/cn'
import { getIconChoice } from '@/components/shared/IconPicker'
import { resolveProjectColor } from '@/components/shared/ColorPicker'
import { listNotebooks, listNoteTags, createNotebook, type Notebook } from '@/lib/notes/api'
import { NotebookEditor } from './NotebookEditor'

// A rail link that is "active" based on path + search params (filters live in the
// query string, which NavLink can't match on its own). Mirrors BookmarksRail.
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

function NotebookRow({ notebook, active, onEdit }: { notebook: Notebook; active: boolean; onEdit: () => void }) {
  const Icon = getIconChoice(notebook.icon)?.Icon ?? FolderOpen
  const color = notebook.color ? resolveProjectColor(notebook.color) : undefined
  return (
    <div className={cn('group flex items-center gap-1 rounded-control pr-1 transition-colors',
      active ? 'bg-accent' : 'hover:bg-accent/50')}>
      <Link to={`/notes?notebook=${notebook.id}`}
        className={cn('flex min-w-0 flex-1 items-center gap-3 rounded-control px-3 py-2 text-sm font-medium transition-colors',
          active ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground')}>
        <Icon className="size-[18px] shrink-0" style={color ? { color } : undefined} />
        <span className="truncate">{notebook.name}</span>
        {notebook.isShared && <Users className="ml-auto size-3.5 shrink-0 text-muted-foreground/60" aria-label="Shared with household" />}
      </Link>
      {notebook.canEdit && (
        <Button variant="ghost" size="icon-sm" onClick={(e) => { e.preventDefault(); onEdit() }} aria-label={`Edit ${notebook.name}`}
          className="size-6 shrink-0 rounded-control text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100">
          <Pencil className="size-3.5" />
        </Button>
      )}
    </div>
  )
}

export function NotesRail({ onNewNote, variant = 'sidebar' }: { onNewNote: () => void; variant?: 'sidebar' | 'drawer' }) {
  const drawer = variant === 'drawer'
  const qc = useQueryClient()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [params] = useSearchParams()

  const { data: notebooks = [] } = useQuery({ queryKey: ['notebooks'], queryFn: listNotebooks })
  const { data: tags = [] } = useQuery({ queryKey: ['note-tags'], queryFn: listNoteTags })
  const [newNotebook, setNewNotebook] = useState<string | null>(null) // null = not creating
  const [editing, setEditing] = useState<Notebook | null>(null)
  const creatingRef = useRef(false) // guard Enter + blur both firing the submit

  async function submitNewNotebook(e: React.FormEvent) {
    e.preventDefault()
    if (creatingRef.current) return
    const name = (newNotebook ?? '').trim()
    if (!name) { setNewNotebook(null); return }
    creatingRef.current = true
    try {
      await createNotebook({ name })
      qc.invalidateQueries({ queryKey: ['notebooks'] })
      toast.success(`Created "${name}"`)
    } catch { toast.error('Failed to create notebook') }
    finally { creatingRef.current = false; setNewNotebook(null) }
  }

  const isRoot = pathname === '/notes' || pathname === '/notes/'
  const scope = params.get('scope')
  const notebookParam = params.get('notebook')
  const tag = params.get('tag')

  return (
    <nav className={cn(
      'h-full min-h-0 shrink-0 flex-col overflow-y-auto overscroll-none px-3 py-5',
      drawer ? 'flex w-full' : 'hidden w-60 border-r border-border/40 lg:flex',
    )}>
      <AppRailHeader title="Notes" className="mb-3" />
      <Button onClick={onNewNote}
        className="mb-3 h-auto w-full justify-center gap-2 rounded-control px-3 py-2 text-sm font-semibold">
        <Plus className="size-4" /> New note
      </Button>

      <FilterLink to="/notes" icon={StickyNote} label="All notes" active={isRoot && !scope && !notebookParam && !tag} />
      <FilterLink to="/notes?scope=personal" icon={User} label="My notes" active={scope === 'personal'} />
      <FilterLink to="/notes?scope=household" icon={Users} label="Household" active={scope === 'household'} />

      <SectionLabel>Notebooks</SectionLabel>
      {notebooks.map((nb) => (
        <NotebookRow key={nb.id} notebook={nb} active={notebookParam === nb.id} onEdit={() => setEditing(nb)} />
      ))}
      {newNotebook !== null ? (
        <form onSubmit={submitNewNotebook} className="px-1 py-1">
          <Input
            autoFocus
            value={newNotebook}
            onChange={(e) => setNewNotebook(e.target.value)}
            onBlur={submitNewNotebook}
            placeholder="Notebook name…"
            className="h-auto rounded-control px-2.5 py-1.5 text-sm"
          />
        </form>
      ) : (
        <Button variant="ghost" onClick={() => setNewNotebook('')}
          className="h-auto w-full justify-start gap-3 rounded-control px-3 py-2 text-sm font-normal text-muted-foreground hover:text-foreground">
          <Plus className="size-[18px]" /> New notebook
        </Button>
      )}

      {tags.length > 0 && <>
        <SectionLabel>Tags</SectionLabel>
        <div className="flex flex-wrap gap-1.5 px-2">
          {tags.map((t) => (
            <Link key={t.name} to={`/notes?tag=${encodeURIComponent(t.name)}`}
              className={cn('rounded-full px-2.5 py-1 text-xs transition-colors',
                tag === t.name ? 'bg-primary text-primary-foreground' : 'bg-accent/50 text-muted-foreground hover:text-foreground')}>
              <Tag className="mr-1 inline size-3" />{t.name}
            </Link>
          ))}
        </div>
      </>}

      <NotebookEditor open={editing !== null} notebook={editing}
        onOpenChange={(o) => { if (!o) setEditing(null) }}
        onDeleted={() => { if (editing && notebookParam === editing.id) navigate('/notes') }} />
    </nav>
  )
}
