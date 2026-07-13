import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, Pencil, Pin, PinOff, Trash2, Users, Link2, Package, BookOpen, Plus, X, Tag } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { PageContainer } from '@/components/shared/PageContainer'
import { RichOptionSelect } from '@/components/shared/RichOptionSelect'
import { ToggleRow } from '@/components/shared/ToggleRow'
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { useAuth } from '@/context/AuthContext'
import { useTheme } from '@/context/ThemeContext'
import { useNotesUI } from '@/components/notes/NotesLayout'
import { cn } from '@/lib/cn'
import {
  getNote, updateNote, deleteNote, setNoteLinks, listNotebooks,
  type NoteLink, type NoteLinkTarget,
} from '@/lib/notes/api'
import { listItems as listBookmarks } from '@/lib/bookmarks/api'
import type { HomeDevice } from '@/pages/HomeInventoryPage'

// CodeMirror stays out of the main bundle (same rule as the Canvas pane).
const CanvasEditor = lazy(() => import('@/components/canvas/CanvasEditor'))

// ── Entity link picker (Devices + Bookmarks tabs) ────────────────────────────────

function LinkPickerDialog({ open, onOpenChange, existing, onAdd }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  existing: NoteLink[]
  onAdd: (targetType: NoteLinkTarget, targetId: string) => void
}) {
  const [tab, setTab] = useState<NoteLinkTarget>('device')
  const [query, setQuery] = useState('')

  const { data: devices = [] } = useQuery({
    queryKey: ['home-devices-for-links'],
    queryFn: async () => {
      const res = await fetch('/api/home/devices', { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to load devices')
      return ((await res.json()) as { devices: HomeDevice[] }).devices
    },
    enabled: open,
  })
  const { data: bookmarks = [] } = useQuery({
    queryKey: ['bookmarks-for-links'],
    queryFn: () => listBookmarks(),
    enabled: open,
  })

  const linked = new Set(existing.map((l) => `${l.targetType}:${l.targetId}`))
  const q = query.trim().toLowerCase()
  const rows = tab === 'device'
    ? devices
        .filter((d) => !q || d.name.toLowerCase().includes(q) || (d.brand ?? '').toLowerCase().includes(q) || (d.model ?? '').toLowerCase().includes(q))
        .map((d) => ({ id: d.id, title: d.name, subtitle: [d.brand, d.model].filter(Boolean).join(' ') || d.location || '' }))
    : bookmarks
        .filter((b) => !q || (b.title || b.url).toLowerCase().includes(q))
        .map((b) => ({ id: b.id, title: b.title || b.url, subtitle: b.siteName || b.url }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Link this note</DialogTitle>
          <DialogDescription>Attach the note to something it documents. It will show up there too.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-1 rounded-control bg-accent/40 p-1">
          {(['device', 'bookmark'] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)}
              className={cn('flex flex-1 items-center justify-center gap-1.5 rounded-control px-3 py-1.5 text-sm font-medium transition-colors',
                tab === t ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
              {t === 'device' ? <Package className="size-4" /> : <BookOpen className="size-4" />}
              {t === 'device' ? 'Devices' : 'Bookmarks'}
            </button>
          ))}
        </div>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tab === 'device' ? 'Search devices…' : 'Search bookmarks…'} />
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {rows.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Nothing found.</p>}
          {rows.slice(0, 50).map((r) => {
            const already = linked.has(`${tab}:${r.id}`)
            return (
              <button key={r.id} type="button" disabled={already}
                onClick={() => { onAdd(tab, r.id); onOpenChange(false) }}
                className={cn('flex w-full items-center gap-3 rounded-control px-3 py-2 text-left text-sm transition-colors',
                  already ? 'cursor-default opacity-40' : 'hover:bg-accent/50')}>
                {tab === 'device' ? <Package className="size-4 shrink-0 text-muted-foreground" /> : <BookOpen className="size-4 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{r.title}</span>
                  {r.subtitle && <span className="block truncate text-xs text-muted-foreground">{r.subtitle}</span>}
                </span>
                {already ? <span className="text-xs text-muted-foreground">Linked</span> : <Plus className="size-4 shrink-0 text-muted-foreground" />}
              </button>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Editor page ──────────────────────────────────────────────────────────────────

export function NoteEditorPage() {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { rail } = useNotesUI()
  const { user } = useAuth()
  const { effectiveTheme } = useTheme()
  const isAdmin = user?.role === 'admin'

  const { data: note, isLoading, isError } = useQuery({ queryKey: ['note', id], queryFn: () => getNote(id) })

  // Local editable copy; server writes are debounced (Canvas autosave pattern).
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [hydratedId, setHydratedId] = useState<string | null>(null)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [confirmDel, setConfirmDel] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [links, setLinks] = useState<NoteLink[]>([])
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef(false)

  useEffect(() => {
    if (!note || hydratedId === note.id) return
    setTitle(note.title)
    setBody(note.body)
    setTagsInput(note.tags.join(', '))
    setLinks(note.links)
    setMode(note.canEdit && (params.get('new') === '1' || !note.body) ? 'edit' : 'preview')
    setHydratedId(note.id)
  }, [note, hydratedId, params])

  const canEdit = note?.canEdit ?? false

  function scheduleSave(next: { title?: string; body?: string; tags?: string[] }) {
    if (!canEdit) return
    dirtyRef.current = true
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      dirtyRef.current = false
      try {
        await updateNote(id, next)
        qc.invalidateQueries({ queryKey: ['notes'] })
        if (next.tags) qc.invalidateQueries({ queryKey: ['note-tags'] })
      } catch { toast.error('Could not save note') }
    }, 800)
  }
  const titleRef = useRef(title); titleRef.current = title
  const bodyRef = useRef(body); bodyRef.current = body
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])
  // Flush a pending edit when leaving the page so the last keystrokes aren't lost.
  useEffect(() => () => {
    if (dirtyRef.current) {
      void updateNote(id, {
        title: titleRef.current,
        body: bodyRef.current,
      }).then(() => qc.invalidateQueries({ queryKey: ['notes'] })).catch(() => {})
    }
  }, [id, qc])

  const { data: notebooks = [] } = useQuery({ queryKey: ['notebooks'], queryFn: listNotebooks })
  // Scope rule: shared notes live in shared notebooks, personal notes in your own.
  const eligibleNotebooks = notebooks.filter((nb) => (note?.isShared ? nb.isShared : !nb.isShared))
  const notebookGroups = useMemo(() => [{
    options: [
      { value: '', label: 'No notebook' },
      ...eligibleNotebooks.map((nb) => ({ value: nb.id, label: nb.name })),
    ],
  }], [eligibleNotebooks]) // eslint-disable-line react-hooks/exhaustive-deps

  useAppHeader({ query: '', setQuery: () => {}, searchable: false, rail })

  async function patch(body: Parameters<typeof updateNote>[1], opts?: { refetchNote?: boolean }) {
    try {
      await updateNote(id, body)
      qc.invalidateQueries({ queryKey: ['notes'] })
      if (opts?.refetchNote !== false) qc.invalidateQueries({ queryKey: ['note', id] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save note')
    }
  }

  async function addLink(targetType: NoteLinkTarget, targetId: string) {
    const next = [...links.map((l) => ({ targetType: l.targetType, targetId: l.targetId })), { targetType, targetId }]
    try { setLinks(await setNoteLinks(id, next)) } catch { toast.error('Could not add link') }
  }
  async function removeLink(link: NoteLink) {
    const next = links.filter((l) => l.id !== link.id).map((l) => ({ targetType: l.targetType, targetId: l.targetId }))
    try { setLinks(await setNoteLinks(id, next)) } catch { toast.error('Could not remove link') }
  }

  async function doDelete() {
    try {
      await deleteNote(id)
      qc.invalidateQueries({ queryKey: ['notes'] })
      toast.success('Note deleted')
      navigate('/notes')
    } catch { toast.error('Could not delete note') }
  }

  if (isLoading) return <div className="flex justify-center py-20"><Spinner size="lg" /></div>
  if (isError || !note) return <p className="py-16 text-center text-sm text-muted-foreground">This note is gone or not yours to see.</p>

  return (
    <PageContainer width="narrow" className="flex min-h-full flex-col py-6">
      {/* Title + actions */}
      <div className="flex items-center gap-2 pb-3">
        <Input
          value={title}
          onChange={(e) => { setTitle(e.target.value); scheduleSave({ title: e.target.value }) }}
          placeholder="Untitled note"
          readOnly={!canEdit}
          autoFocus={params.get('new') === '1'}
          className="h-auto flex-1 border-none bg-transparent px-0 text-xl font-bold shadow-none focus-visible:ring-0"
        />
        {canEdit && (
          <>
            <Button variant="ghost" size="icon-sm" aria-label={note.pinned ? 'Unpin' : 'Pin'}
              onClick={() => patch({ pinned: !note.pinned })}>
              {note.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Delete note" className="text-muted-foreground hover:text-destructive"
              onClick={() => setConfirmDel(true)}>
              <Trash2 className="size-4" />
            </Button>
          </>
        )}
        {canEdit && (
          <div className="flex gap-1 rounded-control bg-accent/40 p-1">
            <button type="button" onClick={() => setMode('edit')} aria-label="Edit"
              className={cn('rounded-control px-2.5 py-1 text-xs font-medium transition-colors', mode === 'edit' ? 'bg-background shadow-sm' : 'text-muted-foreground')}>
              <Pencil className="size-3.5" />
            </button>
            <button type="button" onClick={() => setMode('preview')} aria-label="Preview"
              className={cn('rounded-control px-2.5 py-1 text-xs font-medium transition-colors', mode === 'preview' ? 'bg-background shadow-sm' : 'text-muted-foreground')}>
              <Eye className="size-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Meta row */}
      <div className="flex flex-wrap items-center gap-2 pb-4">
        {note.isShared && (
          <Badge variant="secondary" className="gap-1"><Users className="size-3" />Household</Badge>
        )}
        <RichOptionSelect
          value={note.notebookId ?? ''}
          onChange={(v) => patch({ notebookId: v || null })}
          groups={notebookGroups}
          placeholder="No notebook"
          disabled={!canEdit}
          triggerClassName="h-8 w-auto min-w-36 text-xs"
        />
        <div className="flex min-w-40 flex-1 items-center gap-1.5">
          <Tag className="size-3.5 shrink-0 text-muted-foreground" />
          <Input
            value={tagsInput}
            onChange={(e) => {
              setTagsInput(e.target.value)
              scheduleSave({ tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })
            }}
            placeholder="Tags, comma separated"
            readOnly={!canEdit}
            className="h-8 flex-1 text-xs"
          />
        </div>
      </div>

      {/* Links */}
      <div className="flex flex-wrap items-center gap-1.5 pb-4">
        {links.map((l) => (
          <span key={l.id} className="inline-flex items-center gap-1.5 rounded-full bg-accent/50 px-2.5 py-1 text-xs text-muted-foreground">
            {l.targetType === 'device' ? <Package className="size-3" /> : <BookOpen className="size-3" />}
            {l.targetTitle ?? 'Missing item'}
            {canEdit && (
              <button type="button" onClick={() => removeLink(l)} aria-label="Remove link" className="hover:text-foreground">
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
        {canEdit && (
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground" onClick={() => setLinkOpen(true)}>
            <Link2 className="size-3" /> Link to…
          </Button>
        )}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1">
        {mode === 'edit' && canEdit ? (
          <div className="h-full min-h-[50vh] overflow-hidden rounded-card border border-border/60">
            <Suspense fallback={<div className="flex justify-center py-16"><Spinner /></div>}>
              <CanvasEditor
                value={body}
                type="document"
                language={null}
                dark={effectiveTheme === 'dark'}
                onChange={(v) => { setBody(v); scheduleSave({ body: v }) }}
              />
            </Suspense>
          </div>
        ) : (
          <div className="min-h-[50vh]">
            {body.trim()
              ? <MarkdownRenderer content={body} className="text-sm" />
              : <p className="py-16 text-center text-sm text-muted-foreground">Nothing here yet.</p>}
          </div>
        )}
      </div>

      {/* Admin share control */}
      {isAdmin && (
        <div className="pt-6">
          <ToggleRow
            title="Share with household"
            description="Everyone in the household can read this note and their companions can recall it."
            checked={note.isShared}
            onCheckedChange={() => void patch({ makeShared: !note.isShared })}
          />
        </div>
      )}

      <ConfirmDialog
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title="Delete note?"
        description={`"${title || 'Untitled note'}" will be permanently removed.`}
        confirmLabel="Delete"
        destructive
        onConfirm={doDelete}
      />
      <LinkPickerDialog open={linkOpen} onOpenChange={setLinkOpen} existing={links} onAdd={addLink} />
    </PageContainer>
  )
}
