import { useEffect, useState } from 'react'
import { Globe, Pencil, Plus, Trash2, Loader2, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { cn } from '@/lib/cn'

interface BookmarkRow {
  id: string
  label: string
  url: string
  icon: string | null
  category: string
  sortOrder: number
  useProxy: boolean
  useEmbed: boolean
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

const EMPTY: BookmarkForm = { label: '', url: '', icon: null, category: 'Services', useEmbed: false, useProxy: false }

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

  useEffect(() => {
    const url = form.url.trim()
    if (!url || !open) { setProbeResult(null); return }

    setProbing(true)
    const ctrl = new AbortController()
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/bookmarks/probe?url=${encodeURIComponent(url)}`, { credentials: 'include', signal: ctrl.signal })
        const data: ProbeResult = await res.json()
        if (ctrl.signal.aborted) return
        setProbeResult(data)
        if (data?.faviconUrl) setForm(f => ({ ...f, icon: data.faviconUrl }))
        if (data?.reachable && data?.framesBlocked) setForm(f => ({ ...f, useProxy: true }))
      } catch {
        if (!ctrl.signal.aborted) setProbeResult(null)
      } finally {
        if (!ctrl.signal.aborted) setProbing(false)
      }
    }, 600)
    return () => { clearTimeout(t); ctrl.abort(); setProbing(false) }
  }, [open, form.url]) // eslint-disable-line react-hooks/exhaustive-deps

  const field = (k: 'label' | 'url' | 'category') => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  const toggle = (k: 'useEmbed' | 'useProxy') => () =>
    setForm(f => {
      const next = { ...f, [k]: !f[k] }
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
            <div className="flex items-center justify-between px-3 py-2.5">
              <div>
                <Label>Embed in app</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Open in iframe instead of a new tab</p>
              </div>
              <ToggleSwitch value={form.useEmbed} onChange={toggle('useEmbed')} />
            </div>

            {form.useEmbed && (
              <>
                {probeResult && (
                  <div className={cn(
                    'flex items-center gap-2 px-3 py-2 text-xs',
                    !probeResult.reachable && 'text-destructive',
                    probeResult.reachable && probeResult.framesBlocked && 'text-yellow-600 dark:text-yellow-400',
                    probeResult.reachable && !probeResult.framesBlocked && 'text-green-600 dark:text-green-500',
                  )}>
                    {!probeResult.reachable && <><XCircle className="size-3 shrink-0" /><span>Server can't reach this URL</span></>}
                    {probeResult.reachable && probeResult.framesBlocked && <><AlertTriangle className="size-3 shrink-0" /><span>Blocks embedding — proxy mode enabled below</span></>}
                    {probeResult.reachable && !probeResult.framesBlocked && <><CheckCircle2 className="size-3 shrink-0" /><span>Embeds directly — no proxy needed</span></>}
                  </div>
                )}
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

export function AdminLinksTab() {
  const [bookmarks, setBookmarks] = useState<BookmarkRow[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const load = (signal?: AbortSignal) => {
    fetch('/api/admin/reader', { credentials: 'include', signal })
      .then(r => r.json())
      .then(d => {
        if (signal?.aborted) return
        // Reader items use `title`/`faviconUrl`; map to this tab's label/icon shape.
        setBookmarks((d.items ?? []).map((i: { id: string; title: string; url: string; faviconUrl: string | null; category: string; sortOrder: number; useProxy: boolean; useEmbed: boolean }) => ({
          id: i.id, label: i.title, url: i.url, icon: i.faviconUrl, category: i.category, sortOrder: i.sortOrder, useProxy: i.useProxy, useEmbed: i.useEmbed,
        })))
      })
      .catch(() => {})
  }

  useEffect(() => {
    const ctrl = new AbortController()
    load(ctrl.signal)
    return () => ctrl.abort()
  }, [])

  const editingRow = editingId ? bookmarks.find(b => b.id === editingId) : null
  const formInitial: BookmarkForm = editingRow
    ? { label: editingRow.label, url: editingRow.url, icon: editingRow.icon, category: editingRow.category, useEmbed: editingRow.useEmbed, useProxy: editingRow.useProxy }
    : EMPTY

  const handleSave = async (form: BookmarkForm) => {
    // Map this tab's label/icon onto the reader admin endpoint's title/faviconUrl.
    const body = JSON.stringify({ title: form.label, url: form.url, faviconUrl: form.icon, category: form.category, useProxy: form.useProxy, useEmbed: form.useEmbed })
    if (editingId) {
      await fetch(`/api/admin/reader/${editingId}`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body })
    } else {
      await fetch('/api/admin/reader', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body })
    }
    setDialogOpen(false)
    load()
  }

  const handleDelete = async () => {
    if (!confirmDeleteId) return
    await fetch(`/api/admin/reader/${confirmDeleteId}`, { method: 'DELETE', credentials: 'include' })
    setConfirmDeleteId(null)
    load()
  }

  const categories = [...new Set(bookmarks.map(b => b.category))].sort()

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Global Links</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Links shared with all users. Each user can also add their own personal links.
          </p>
        </div>
        <Button size="sm" onClick={() => { setEditingId(null); setDialogOpen(true) }}>
          <Plus className="size-4 mr-1.5" /> Add link
        </Button>
      </div>

      {bookmarks.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center border rounded-lg bg-muted/20">
          <Globe className="size-8 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">No global links yet. Add one to share with all users.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {categories.map(cat => (
            <div key={cat}>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60 mb-2">{cat}</p>
              <div className="space-y-1">
                {bookmarks
                  .filter(b => b.category === cat)
                  .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label))
                  .map(bm => (
                    <div key={bm.id} className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3">
                      <BookmarkFavicon icon={bm.icon} className="size-5 text-muted-foreground" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium leading-tight">{bm.label}</p>
                        <p className="text-xs text-muted-foreground truncate">{bm.url}</p>
                      </div>
                      <Badge variant="secondary" className="text-[10px] shrink-0">{bm.category}</Badge>
                      <div className="flex gap-1 shrink-0">
                        <Button variant="ghost" size="icon" className="size-8"
                          onClick={() => { setEditingId(bm.id); setDialogOpen(true) }}>
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-destructive"
                          onClick={() => setConfirmDeleteId(bm.id)}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
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
        title={editingId ? 'Edit link' : 'Add global link'}
      />

      <ConfirmDialog
        open={confirmDeleteId !== null}
        onOpenChange={open => { if (!open) setConfirmDeleteId(null) }}
        title="Delete link"
        description="This link will be removed for all users."
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
      />
    </div>
  )
}
