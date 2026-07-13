import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Plus, StickyNote, Users, Pin, Sparkles, FolderOpen, Tag, Link2, Search, Mic } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { getAppByPath } from '@/lib/appCategories'
import { useNotesUI } from '@/components/notes/NotesLayout'
import { listNotes, type NotesListParams, type NoteListItem } from '@/lib/notes/api'

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function NoteRow({ note }: { note: NoteListItem }) {
  return (
    <Link to={`/notes/${note.id}`}>
      <Card className="group flex flex-col gap-1.5 rounded-card border-border/50 px-4 py-3 transition-colors hover:border-border hover:bg-accent/30">
        <div className="flex items-center gap-2">
          {note.pinned && <Pin className="size-3.5 shrink-0 text-warning" aria-label="Pinned" />}
          <span className="truncate text-sm font-semibold">{note.title || 'Untitled note'}</span>
          {note.isShared && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-medium text-brand">
              <Users className="size-3" />Household
            </span>
          )}
          {note.source === 'companion' && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-muted-foreground" title="Captured by your companion">
              <Sparkles className="size-3" />Captured
            </span>
          )}
          <span className="ml-auto shrink-0 text-xs text-muted-foreground/70">{relativeTime(note.updatedAt)}</span>
        </div>
        {note.excerpt && <p className="line-clamp-2 text-xs text-muted-foreground">{note.excerpt}</p>}
        {(note.notebookName || note.tags.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {note.notebookName && (
              <span className="inline-flex items-center gap-1 rounded-full bg-accent/60 px-2 py-0.5 text-[10px] text-muted-foreground">
                <FolderOpen className="size-3" />{note.notebookName}
              </span>
            )}
            {note.tags.map((t) => (
              <span key={t} className="inline-flex items-center gap-1 rounded-full bg-accent/40 px-2 py-0.5 text-[10px] text-muted-foreground">
                <Tag className="size-3" />{t}
              </span>
            ))}
          </div>
        )}
      </Card>
    </Link>
  )
}

export function NotesListPage() {
  const [params] = useSearchParams()
  const { rail, newNote } = useNotesUI()
  const [search, setSearch] = useState('')

  const scope = params.get('scope')
  const notebookId = params.get('notebook')
  const tag = params.get('tag')
  const isRootView = !scope && !notebookId && !tag && !search.trim()

  const filters: NotesListParams = useMemo(() => ({
    scope: (scope as NotesListParams['scope']) || undefined,
    notebookId: notebookId || undefined,
    tag: tag || undefined,
    q: search.trim() || undefined,
  }), [scope, notebookId, tag, search])

  const { data: notes = [], isLoading } = useQuery({
    queryKey: ['notes', filters],
    queryFn: () => listNotes(filters),
  })

  const heading = tag ? `#${tag}`
    : scope === 'personal' ? 'My notes'
    : scope === 'household' ? 'Household'
    : notebookId ? (notes[0]?.notebookName ?? 'Notebook')
    : 'Notes'

  useAppHeader({
    query: search,
    setQuery: setSearch,
    placeholder: 'Search notes…',
    rail,
  })

  return (
    <PageContainer width="wide" className="py-6">
      <PageHeader title={heading} className="pt-0 pb-5" />

      {isLoading ? (
        <div className="flex justify-center py-20"><Spinner size="lg" /></div>
      ) : notes.length === 0 ? (
        isRootView ? (
          <EmptyAppState
            icon={StickyNote}
            gradient={getAppByPath('/notes')?.gradient}
            title="Your household knowledge base"
            tagline="Keep the stuff you'll need again: install gotchas, project research, measurements, and runbooks. Your companion can recall it when anyone asks, and save new notes for you by voice."
            actions={<Button onClick={newNote}><Plus className="mr-1.5 size-4" /> Write your first note</Button>}
            features={[
              { icon: Users, title: 'Personal & household', desc: 'Keep notes to yourself or share runbooks the whole family can use.' },
              { icon: Mic, title: 'Capture by voice', desc: 'Say "note that the far pothole took 8 bags" and it lands here.' },
              { icon: Sparkles, title: 'Companion recall', desc: 'Ask "the internet is slow" and your saved troubleshooting steps surface.' },
              { icon: Link2, title: 'Linked to your stuff', desc: 'Attach notes to Home Inventory devices and bookmarks.' },
              { icon: Search, title: 'Always findable', desc: 'Full-text and semantic search, right from Cmd+K.' },
              { icon: FolderOpen, title: 'Notebooks & tags', desc: 'Organize by project, room, or system. Your call.' },
            ]}
          />
        ) : (
          <p className="py-16 text-center text-sm text-muted-foreground">No notes match this view.</p>
        )
      ) : (
        <div className="flex flex-col gap-2">
          {notes.map((n) => <NoteRow key={n.id} note={n} />)}
        </div>
      )}
    </PageContainer>
  )
}
