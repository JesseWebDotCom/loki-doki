import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Globe, Pencil, Plus, Trash2, ExternalLink, Loader2, CheckCircle2, AlertTriangle, XCircle, BookMarked } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { cn } from '@/lib/cn'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAuth } from '@/context/AuthContext'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { PageHeader } from '@/components/shared/PageHeader'

interface BookmarkEntry {
  id: string
  ownerId: string | null
  label: string
  url: string
  icon: string | null
  category: string
  sortOrder: number
  useProxy: boolean
  useEmbed: boolean
  isGlobal: boolean
  canEdit: boolean
  isHidden: boolean
}

interface BookmarkForm {
  label: string
  url: string
  icon: string | null
  category: string
  useEmbed: boolean
  useProxy: boolean
}

type ProbeResult = { reachable: boolean; framesBlocked: boolean; faviconUrl: string | null } | null

const EMPTY_FORM: BookmarkForm = { label: '', url: '', icon: null, category: '', useEmbed: false, useProxy: false }

function BookmarkFavicon({ icon, className }: { icon: string | null; className?: string }) {
  if (icon?.startsWith('http')) {
    return (
      <img
        src={icon}
        className={cn('shrink-0 rounded-sm object-contain', className)}
        alt=""
        onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
      />
    )
  }
  return <Globe className={cn('shrink-0', className)} />
}

function ToggleSwitch({ value, onChange }: { value: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={onChange}
      className={cn('relative h-5 w-9 rounded-full transition-colors shrink-0', value ? 'bg-primary' : 'bg-input')}
    >
      <span className={cn('absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform', value ? 'translate-x-4' : 'translate-x-0.5')} />
    </button>
  )
}

function BookmarkFormDialog({
  open, onOpenChange, initial, onSave, title,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  initial: BookmarkForm
  onSave: (form: BookmarkForm) => Promise<void>
  title: string
}) {
  const [form, setForm] = useState<BookmarkForm>(initial)
  const [saving, setSaving] = useState(false)
  const [probeResult, setProbeResult] = useState<ProbeResult>(null)
  const [probing, setProbing] = useState(false)

  useEffect(() => {
    if (open) { setForm(initial); setProbeResult(null) }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Probe whenever the URL changes (debounced)
  useEffect(() => {
    const url = form.url.trim()
    if (!url || !open) { setProbeResult(null); return }

    setProbing(true)
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/bookmarks/probe?url=${encodeURIComponent(url)}`, { credentials: 'include' })
        const data: ProbeResult = await res.json()
        setProbeResult(data)
        if (data?.faviconUrl) setForm(f => ({ ...f, icon: data.faviconUrl }))
        if (data?.reachable && data?.framesBlocked) setForm(f => ({ ...f, useProxy: true }))
      } catch {
        setProbeResult(null)
      } finally {
        setProbing(false)
      }
    }, 600)
    return () => { clearTimeout(t); setProbing(false) }
  }, [open, form.url]) // eslint-disable-line react-hooks/exhaustive-deps

  const field = (k: 'label' | 'url' | 'category') => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  const toggle = (k: 'useEmbed' | 'useProxy') => () =>
    setForm(f => {
      const next = { ...f, [k]: !f[k] }
      // Auto-suggest proxy when embed is toggled on and probe already shows framesBlocked
      if (k === 'useEmbed' && next.useEmbed && probeResult?.reachable && probeResult?.framesBlocked) {
        next.useProxy = true
      }
      return next
    })

  const handleSave = async () => {
    if (!form.label.trim() || !form.url.trim()) return
    setSaving(true)
    try { await onSave(form) } finally { setSaving(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Label</Label>
            <Input value={form.label} onChange={field('label')} placeholder="Jellyfin" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label>URL</Label>
            <div className="relative">
              <Input
                value={form.url}
                onChange={field('url')}
                placeholder="http://192.168.1.100:8096"
                className="pr-9"
              />
              <span className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center justify-center size-5">
                {probing
                  ? <Loader2 className="size-3.5 text-muted-foreground animate-spin" />
                  : form.icon?.startsWith('http')
                    ? <img src={form.icon} className="size-4 rounded-sm object-contain" alt="" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                    : null
                }
              </span>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Category</Label>
            <Input value={form.category} onChange={field('category')} placeholder="Media" />
          </div>

          <div className="rounded-lg border divide-y">
            {/* Embed toggle */}
            <div className="flex items-center justify-between px-3 py-2.5">
              <div>
                <Label>Embed in app</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Open in iframe instead of a new tab</p>
              </div>
              <ToggleSwitch value={form.useEmbed} onChange={toggle('useEmbed')} />
            </div>

            {form.useEmbed && (
              <>
                {/* Probe status */}
                {probeResult && (
                  <div className={cn(
                    'flex items-center gap-2 px-3 py-2 text-xs',
                    !probeResult.reachable && 'text-destructive',
                    probeResult.reachable && probeResult.framesBlocked && 'text-yellow-600 dark:text-yellow-400',
                    probeResult.reachable && !probeResult.framesBlocked && 'text-green-600 dark:text-green-500',
                  )}>
                    {!probeResult.reachable && <><XCircle className="size-3 shrink-0" /><span>Server can't reach this URL — embedding may fail</span></>}
                    {probeResult.reachable && probeResult.framesBlocked && <><AlertTriangle className="size-3 shrink-0" /><span>Blocks embedding — proxy mode enabled below</span></>}
                    {probeResult.reachable && !probeResult.framesBlocked && <><CheckCircle2 className="size-3 shrink-0" /><span>Embeds directly — no proxy needed</span></>}
                  </div>
                )}

                {/* Proxy toggle */}
                <div className="flex items-center justify-between px-3 py-2.5">
                  <div>
                    <Label>Proxy mode</Label>
                    <p className="text-xs text-muted-foreground mt-0.5">Route through server to bypass X-Frame-Options</p>
                  </div>
                  <ToggleSwitch value={form.useProxy} onChange={toggle('useProxy')} />
                </div>
              </>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !form.label.trim() || !form.url.trim()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function LinksPage() {
  const { user } = useAuth()
  const [bookmarks, setBookmarks] = useState<BookmarkEntry[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  usePublishUIContext({ label: 'Links', description: 'User is managing their saved links.' })

  const load = useCallback(() => {
    fetch('/api/bookmarks', { credentials: 'include' })
      .then(r => r.json())
      .then(d => setBookmarks(d.bookmarks ?? []))
      .catch(() => {})
  }, [])

  useEffect(() => { load() }, [load])

  const editingRow = editingId ? bookmarks.find(b => b.id === editingId) : null
  const formInitial: BookmarkForm = editingRow
    ? { label: editingRow.label, url: editingRow.url, icon: editingRow.icon, category: editingRow.category, useEmbed: editingRow.useEmbed, useProxy: editingRow.useProxy }
    : EMPTY_FORM

  const handleSave = async (form: BookmarkForm) => {
    if (editingId) {
      await fetch(`/api/bookmarks/${editingId}`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
    } else {
      await fetch('/api/bookmarks', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
    }
    setDialogOpen(false)
    load()
  }

  const handleDelete = async () => {
    if (!confirmDeleteId) return
    await fetch(`/api/bookmarks/${confirmDeleteId}`, { method: 'DELETE', credentials: 'include' })
    setConfirmDeleteId(null)
    load()
  }

  const categories = [...new Set(bookmarks.map(b => b.category))].sort()

  return (
    <PageShell gradient="linear-gradient(135deg,#14532d,#166534)" GhostIcon={BookMarked}>
      <PageHeader
        variant="compact"
        title="Links"
        gradient="linear-gradient(135deg,#14532d,#166534)"
        icon={<BookMarked className="size-7 text-white" />}
        actions={
          <div className="flex items-center gap-2">
            {user?.role === 'admin' && (
              <Button variant="ghost" size="sm" className="text-white/70 hover:text-white hover:bg-white/10" asChild>
                <Link to="/admin/links">Manage global</Link>
              </Button>
            )}
            <Button size="sm" onClick={() => { setEditingId(null); setDialogOpen(true) }}>
              <Plus className="size-4 mr-1.5" /> Add link
            </Button>
          </div>
        }
      />

      {bookmarks.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 py-24 text-center px-8">
          <Globe className="size-12 text-muted-foreground/30" />
          <div>
            <p className="font-medium">No links yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              Add links to your self-hosted services — they'll appear in the sidebar.
            </p>
          </div>
          <Button variant="outline" onClick={() => { setEditingId(null); setDialogOpen(true) }}>
            <Plus className="size-4 mr-1.5" /> Add your first link
          </Button>
        </div>
      ) : (
        <div className="px-5 pb-8 space-y-6">
          {categories.map(cat => (
            <div key={cat}>
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">{cat}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {bookmarks
                  .filter(b => b.category === cat)
                  .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label))
                  .map(bm => {
                    const cardContent = (
                      <>
                        <span className="flex size-10 items-center justify-center rounded-lg bg-muted shrink-0">
                          <BookmarkFavicon icon={bm.icon} className="size-5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium leading-tight truncate">{bm.label}</p>
                          <p className="text-xs text-muted-foreground truncate mt-0.5">{bm.url}</p>
                        </div>
                      </>
                    )

                    return (
                      <div
                        key={bm.id}
                        className={cn(
                          'group flex items-center gap-3 rounded-2xl border border-border/60 bg-card p-4 transition-all hover:border-brand/40 hover:shadow-md',
                          bm.isHidden && 'opacity-50',
                        )}
                      >
                        {bm.useEmbed
                          ? <Link to={`/links/${bm.id}`} className="flex items-center gap-3 flex-1 min-w-0">{cardContent}</Link>
                          : <a href={bm.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 flex-1 min-w-0">{cardContent}</a>
                        }

                        <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                          <a href={bm.url} target="_blank" rel="noopener noreferrer">
                            <Button variant="ghost" size="icon" className="size-7">
                              <ExternalLink className="size-3.5" />
                            </Button>
                          </a>
                          {bm.canEdit && (
                            <>
                              <Button variant="ghost" size="icon" className="size-7"
                                onClick={() => { setEditingId(bm.id); setDialogOpen(true) }}>
                                <Pencil className="size-3.5" />
                              </Button>
                              <Button variant="ghost" size="icon"
                                className="size-7 text-muted-foreground hover:text-destructive"
                                onClick={() => setConfirmDeleteId(bm.id)}>
                                <Trash2 className="size-3.5" />
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    )
                  })}
              </div>
            </div>
          ))}
        </div>
      )}

      <BookmarkFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initial={formInitial}
        onSave={handleSave}
        title={editingId ? 'Edit link' : 'Add link'}
      />

      <ConfirmDialog
        open={confirmDeleteId !== null}
        onOpenChange={open => { if (!open) setConfirmDeleteId(null) }}
        title="Delete link"
        description="This link will be removed from your sidebar."
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
      />
    </PageShell>
  )
}
