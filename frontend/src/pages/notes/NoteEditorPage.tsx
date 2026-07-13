// Outline-style document page: one seamless writing surface. Big borderless
// title, body flowing directly beneath it (WYSIWYG markdown via NoteDocEditor),
// silent debounced autosave with a subtle status word, and everything that is
// not writing (notebook, tags, sharing, entity links, delete) tucked into the
// header's "…" menu, the way Outline keeps document chrome out of the page.

import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  MoreHorizontal, Pin, PinOff, Trash2, Users, Link2, Package, BookOpen,
  FolderOpen, Tag, X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@/components/ui/spinner'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { PageContainer } from '@/components/shared/PageContainer'
import { RichOptionSelect } from '@/components/shared/RichOptionSelect'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { useAuth } from '@/context/AuthContext'
import { useNotesUI } from '@/components/notes/NotesLayout'
import { cn } from '@/lib/cn'
import {
  getNote, updateNote, deleteNote, setNoteLinks, listNotebooks,
  type NoteLink, type NoteLinkTarget,
} from '@/lib/notes/api'
import { listItems as listBookmarks } from '@/lib/bookmarks/api'
import type { HomeDevice } from '@/pages/HomeInventoryPage'

import type { NoteDocController } from '@/components/notes/doc/NoteDocEditor'

// TipTap/ProseMirror stays out of the main bundle (same rule as CanvasEditor).
const NoteDocEditor = lazy(() => import('@/components/notes/doc/NoteDocEditor'))

// Outline autosaves silently on a 3s debounce (useDocumentSave AUTOSAVE_DELAY)
// plus a flush when the title blurs; errors surface as toasts, success says nothing.
const AUTOSAVE_DELAY = 3000

function relativeTime(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} minutes ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hours ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} days ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

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
                {already && <span className="text-xs text-muted-foreground">Linked</span>}
              </button>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────────

export function NoteEditorPage() {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { rail } = useNotesUI()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const isNew = params.get('new') === '1'

  const { data: note, isLoading, isError } = useQuery({ queryKey: ['note', id], queryFn: () => getNote(id) })

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [hydratedId, setHydratedId] = useState<string | null>(null)
  const [links, setLinks] = useState<NoteLink[]>([])
  const [confirmDel, setConfirmDel] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [notebookOpen, setNotebookOpen] = useState(false)
  const [tagsOpen, setTagsOpen] = useState(false)
  const [tagsDraft, setTagsDraft] = useState('')

  const titleRef = useRef<HTMLTextAreaElement>(null)
  const docRef = useRef<NoteDocController | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef(false)
  const latest = useRef({ title: '', body: '' })
  latest.current = { title, body }

  useEffect(() => {
    if (!note || hydratedId === note.id) return
    setTitle(note.title)
    setBody(note.body)
    setLinks(note.links)
    setHydratedId(note.id)
  }, [note, hydratedId])

  // Autogrow the title textarea (borderless, wraps like Outline's H1).
  useEffect(() => {
    const el = titleRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [title, hydratedId])

  const canEdit = note?.canEdit ?? false

  function flushSave() {
    if (!dirtyRef.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    dirtyRef.current = false
    void updateNote(id, { title: latest.current.title, body: latest.current.body })
      .then(() => qc.invalidateQueries({ queryKey: ['notes'] }))
      .catch(() => toast.error('Could not save note'))
  }

  function scheduleSave() {
    if (!canEdit) return
    dirtyRef.current = true
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flushSave, AUTOSAVE_DELAY)
  }
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])
  // Flush pending edits on unmount so the last keystrokes are never lost.
  useEffect(() => () => {
    if (dirtyRef.current) {
      void updateNote(id, { title: latest.current.title, body: latest.current.body })
        .then(() => qc.invalidateQueries({ queryKey: ['notes'] })).catch(() => {})
    }
  }, [id, qc])

  const { data: notebooks = [] } = useQuery({ queryKey: ['notebooks'], queryFn: listNotebooks })
  const eligibleNotebooks = notebooks.filter((nb) => (note?.isShared ? nb.isShared : !nb.isShared))
  const notebook = notebooks.find((nb) => nb.id === note?.notebookId) ?? null

  useAppHeader({ query: '', setQuery: () => {}, searchable: false, rail })

  async function patch(bodyPatch: Parameters<typeof updateNote>[1]) {
    try {
      await updateNote(id, bodyPatch)
      qc.invalidateQueries({ queryKey: ['notes'] })
      qc.invalidateQueries({ queryKey: ['note', id] })
      if (bodyPatch.tags) qc.invalidateQueries({ queryKey: ['note-tags'] })
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

  function focusTitleEnd() {
    const el = titleRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }

  if (isLoading) return <div className="flex justify-center py-20"><Spinner size="lg" /></div>
  if (isError || !note) return <p className="py-16 text-center text-sm text-muted-foreground">This note is gone or not yours to see.</p>

  return (
    <PageContainer width="narrow" className="flex min-h-full flex-col py-4">
      {/* Chrome row: notebook crumb on the left, status + actions on the right. */}
      <div className="flex items-center gap-2 pb-8">
        <button
          type="button"
          onClick={() => canEdit && setNotebookOpen(true)}
          className={cn('flex items-center gap-1.5 rounded-control px-2 py-1 text-xs text-muted-foreground transition-colors',
            canEdit && 'hover:bg-accent/50 hover:text-foreground')}
        >
          <FolderOpen className="size-3.5" />
          {notebook?.name ?? 'No notebook'}
        </button>
        {note.isShared && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground"><Users className="size-3.5" />Household</span>
        )}
        <span className="ml-auto" />
        {canEdit && (
          <>
            <Button variant="ghost" size="icon-sm" aria-label={note.pinned ? 'Unpin' : 'Pin'}
              className={cn(note.pinned && 'text-warning')}
              onClick={() => patch({ pinned: !note.pinned })}>
              {note.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Note options"><MoreHorizontal className="size-4" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {isAdmin && (
                  <DropdownMenuCheckboxItem
                    checked={note.isShared}
                    onCheckedChange={(v) => void patch({ makeShared: v === true })}
                  >
                    <Users className="mr-2 size-4" /> Share with household
                  </DropdownMenuCheckboxItem>
                )}
                <DropdownMenuItem onClick={() => setNotebookOpen(true)}>
                  <FolderOpen className="mr-2 size-4" /> Move to notebook…
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setTagsDraft(note.tags.join(', ')); setTagsOpen(true) }}>
                  <Tag className="mr-2 size-4" /> Edit tags…
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setLinkOpen(true)}>
                  <Link2 className="mr-2 size-4" /> Link to device or bookmark…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setConfirmDel(true)}>
                  <Trash2 className="mr-2 size-4" /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>

      {/* Title: Outline's DocumentTitle metrics (2.25em / 600 / 1.25). Enter inserts
          a fresh paragraph at the top of the body; Tab/ArrowDown just moves down. */}
      <Textarea
        ref={titleRef}
        value={title}
        maxLength={100}
        onChange={(e) => {
          const v = e.target.value.replace(/\n/g, '')
          setTitle(v)
          scheduleSave()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); docRef.current?.focusStart(true) }
          if (e.key === 'ArrowDown' || e.key === 'Tab') { e.preventDefault(); docRef.current?.focusStart(false) }
        }}
        onBlur={flushSave}
        placeholder="Untitled"
        readOnly={!canEdit}
        autoFocus={isNew}
        rows={1}
        className="min-h-0 w-full resize-none overflow-hidden border-none bg-transparent p-0 text-4xl font-semibold leading-[1.25] tracking-tight shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 md:text-4xl"
      />

      {/* Meta line under the title (Outline's DocumentMeta): who + when + tags. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-6 pt-1 text-sm text-muted-foreground/70">
        <span>
          {note.source === 'companion' ? 'Your companion captured this'
            : note.updatedAt === note.createdAt ? 'You created this' : 'You updated'}
          {' '}{relativeTime(note.updatedAt)}
        </span>
        {note.tags.length > 0 && <span>·</span>}
        {note.tags.map((t) => (
          <button key={t} type="button"
            onClick={() => { if (canEdit) { setTagsDraft(note.tags.join(', ')); setTagsOpen(true) } }}
            className={cn('rounded-full bg-accent/50 px-2 py-0.5 text-muted-foreground', canEdit && 'hover:text-foreground')}>
            #{t}
          </button>
        ))}
      </div>

      {/* Body: the document itself, no box, no mode toggle. */}
      <Suspense fallback={<div className="flex justify-center py-16"><Spinner /></div>}>
        <NoteDocEditor
          value={body}
          editable={canEdit}
          autoFocus={isNew && !!note.title}
          onChange={(md) => { setBody(md); scheduleSave() }}
          onFocusTitle={focusTitleEnd}
          controllerRef={docRef}
        />
      </Suspense>

      {/* Linked entities: bottom references section, Outline-style. */}
      {(links.length > 0 || canEdit) && (
        <div className="mt-4 border-t border-border/40 pt-4">
          <p className="mb-2 text-overline text-muted-foreground/50">Linked to</p>
          <div className="flex flex-wrap items-center gap-1.5">
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
        </div>
      )}

      {/* Dialogs */}
      <Dialog open={notebookOpen} onOpenChange={setNotebookOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Move to notebook</DialogTitle>
            <DialogDescription>{note.isShared ? 'Household notes live in household notebooks.' : 'Personal notes live in your notebooks.'}</DialogDescription>
          </DialogHeader>
          <RichOptionSelect
            value={note.notebookId ?? ''}
            onChange={(v) => { void patch({ notebookId: v || null }); setNotebookOpen(false) }}
            groups={[{ options: [{ value: '', label: 'No notebook' }, ...eligibleNotebooks.map((nb) => ({ value: nb.id, label: nb.name }))] }]}
            placeholder="No notebook"
          />
        </DialogContent>
      </Dialog>

      <Dialog open={tagsOpen} onOpenChange={setTagsOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Edit tags</DialogTitle>
            <DialogDescription>Comma separated. Tags show in the sidebar for quick filtering.</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={tagsDraft}
            onChange={(e) => setTagsDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void patch({ tags: tagsDraft.split(',').map((t) => t.trim()).filter(Boolean) })
                setTagsOpen(false)
              }
            }}
            placeholder="homelab, network"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setTagsOpen(false)}>Cancel</Button>
            <Button onClick={() => {
              void patch({ tags: tagsDraft.split(',').map((t) => t.trim()).filter(Boolean) })
              setTagsOpen(false)
            }}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
