import { useState, useEffect, useRef } from 'react'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Pencil, Trash2, RefreshCw, ExternalLink, Phone, FileText, Upload,
  Send, Loader2, Plus, X, CheckCircle2, WifiOff, Clock, Star, Sparkles, Link2,
  ChevronDown, ScanText,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import type { HomeDevice, DeviceCategory } from '../HomeInventoryPage'

interface ServiceEntry {
  id: string
  deviceId: string
  date: string
  type: 'repair' | 'maintenance' | 'inspection' | 'upgrade' | 'other'
  description: string
  technician: string | null
  cost: number | null
  createdBy: string
  createdAt: string
}

interface DeviceFile {
  id: string
  deviceId: string
  label: string
  filePath: string
  fileType: 'pdf' | 'image' | 'other'
  source: 'user' | 'ai'
  sizeBytes: number | null
  uploadedBy: string
  comment: string | null
  createdAt: string
}

interface DeviceLink {
  id: string
  deviceId: string
  category: 'manual' | 'support' | 'download' | 'video' | 'other'
  label: string
  url: string
  createdAt: string
}

interface DeviceSheetProps {
  device: HomeDevice
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpdated: (device: HomeDevice) => void
  onDeleted: (id: string) => void
}

const CATEGORIES: { value: DeviceCategory; label: string }[] = [
  { value: 'appliance', label: 'Appliance' },
  { value: 'electronics', label: 'Electronics' },
  { value: 'vehicle', label: 'Vehicle' },
  { value: 'tool', label: 'Tool' },
  { value: 'furniture', label: 'Furniture' },
  { value: 'other', label: 'Other' },
]

const SERVICE_TYPES = ['repair', 'maintenance', 'inspection', 'upgrade', 'other'] as const

function formatBytes(bytes: number | null): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function LookupStatusBadge({ status }: { status: HomeDevice['lookupStatus'] }) {
  if (status === 'complete') return <Badge variant="outline" className="text-xs text-emerald-600 border-emerald-300"><CheckCircle2 className="size-3 mr-1" />Found</Badge>
  if (status === 'pending') return <Badge variant="outline" className="text-xs"><Clock className="size-3 mr-1 animate-pulse" />Looking up…</Badge>
  if (status === 'failed') return <Badge variant="outline" className="text-xs text-muted-foreground"><WifiOff className="size-3 mr-1" />Lookup failed</Badge>
  return null
}

// ── Overview Tab ──────────────────────────────────────────────────────────────

function OverviewTab({
  device,
  onUpdated,
  onDelete,
  onLookup,
}: {
  device: HomeDevice
  onUpdated: (d: HomeDevice) => void
  onDelete: () => void
  onLookup: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    name: device.name,
    brand: device.brand ?? '',
    model: device.model ?? '',
    serialNumber: device.serialNumber ?? '',
    category: device.category,
    location: device.location ?? '',
    owner: device.owner ?? '',
    description: device.description ?? '',
    manufacturedDate: device.manufacturedDate ?? '',
    purchaseDate: device.purchaseDate ?? '',
    purchasePrice: device.purchasePrice?.toString() ?? '',
    purchaseStore: device.purchaseStore ?? '',
    warrantyExpires: device.warrantyExpires ?? '',
    warrantyNotes: device.warrantyNotes ?? '',
    notes: device.notes ?? '',
  })

  async function handleSave() {
    setSaving(true)
    const fd = new FormData()
    Object.entries(form).forEach(([k, v]) => { if (v !== '') fd.append(k, v) })
    const res = await fetch(`/api/home/devices/${device.id}`, {
      method: 'PATCH', credentials: 'include', body: fd,
    })
    if (res.ok) {
      const data = await res.json() as { device: HomeDevice }
      onUpdated(data.device)
      setEditing(false)
    }
    setSaving(false)
  }

  const photoUrl = device.photoPath ? `/api/home/devices/${device.id}/photo` : null

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-4">
        {photoUrl ? (
          <img src={photoUrl} alt={device.name} className="size-24 rounded-xl object-cover bg-muted shrink-0" />
        ) : (
          <div className="size-24 rounded-xl bg-muted flex items-center justify-center text-4xl shrink-0">
            {({ appliance: '🏠', electronics: '📱', vehicle: '🚗', tool: '🔧', furniture: '🛋️', other: '📦' } as Record<string, string>)[device.category] ?? '📦'}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="secondary" className="capitalize text-xs">{device.category}</Badge>
            <LookupStatusBadge status={device.lookupStatus} />
          </div>
          {device.location && <p className="text-sm text-muted-foreground mt-1">{device.location}</p>}
          {device.description && <p className="text-sm text-muted-foreground/80 mt-1 line-clamp-2">{device.description}</p>}
          {device.lookupStatus === 'failed' && device.brand && device.model && (
            <Button size="sm" variant="outline" className="mt-2 h-7 text-xs" onClick={onLookup}>
              <RefreshCw className="size-3 mr-1" />Retry lookup
            </Button>
          )}
        </div>
      </div>

      {editing ? (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label className="text-xs">Name</Label>
              <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Brand</Label>
              <Input value={form.brand} onChange={e => setForm(f => ({ ...f, brand: e.target.value }))} className="mt-1" placeholder="e.g. Samsung" />
            </div>
            <div>
              <Label className="text-xs">Model</Label>
              <Input value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} className="mt-1" placeholder="e.g. RF28R7351" />
            </div>
            <div>
              <Label className="text-xs">Serial Number</Label>
              <Input value={form.serialNumber} onChange={e => setForm(f => ({ ...f, serialNumber: e.target.value }))} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Category</Label>
              <select
                value={form.category}
                onChange={e => setForm(f => ({ ...f, category: e.target.value as DeviceCategory }))}
                className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-xs">Location</Label>
              <Input value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} className="mt-1" placeholder="e.g. Kitchen, Garage" />
            </div>
            <div>
              <Label className="text-xs">Owner</Label>
              <Input value={form.owner} onChange={e => setForm(f => ({ ...f, owner: e.target.value }))} className="mt-1" placeholder="e.g. Jesse" />
            </div>
            <div>
              <Label className="text-xs">Year released</Label>
              <Input value={form.manufacturedDate} onChange={e => setForm(f => ({ ...f, manufacturedDate: e.target.value }))} className="mt-1" placeholder="e.g. 2021" />
            </div>
            <div className="col-span-2">
              <Label className="text-xs">Description</Label>
              <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="mt-1 resize-none" rows={2} placeholder="Brief description of this device" />
            </div>
            <div>
              <Label className="text-xs">Purchase Date</Label>
              <Input type="date" value={form.purchaseDate} onChange={e => setForm(f => ({ ...f, purchaseDate: e.target.value }))} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Purchase Price</Label>
              <Input type="number" value={form.purchasePrice} onChange={e => setForm(f => ({ ...f, purchasePrice: e.target.value }))} className="mt-1" placeholder="0.00" />
            </div>
            <div className="col-span-2">
              <Label className="text-xs">Store</Label>
              <Input value={form.purchaseStore} onChange={e => setForm(f => ({ ...f, purchaseStore: e.target.value }))} className="mt-1" placeholder="e.g. Home Depot, Amazon" />
            </div>
            <div>
              <Label className="text-xs">Warranty Expires</Label>
              <Input type="date" value={form.warrantyExpires} onChange={e => setForm(f => ({ ...f, warrantyExpires: e.target.value }))} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Warranty Notes</Label>
              <Input value={form.warrantyNotes} onChange={e => setForm(f => ({ ...f, warrantyNotes: e.target.value }))} className="mt-1" />
            </div>
            <div className="col-span-2">
              <Label className="text-xs">Notes</Label>
              <Textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="mt-1 resize-none" rows={2} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="size-3 mr-1 animate-spin" />}Save
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {device.brand && <Field label="Brand" value={device.brand} />}
            {device.model && <Field label="Model" value={device.model} />}
            {device.serialNumber && <Field label="Serial" value={device.serialNumber} className="col-span-2" />}
            {device.manufacturedDate && <Field label="Year released" value={device.manufacturedDate} />}
            {device.owner && <Field label="Owner" value={device.owner} />}
            {device.purchaseDate && <Field label="Purchased" value={device.purchaseDate} />}
            {device.purchasePrice != null && <Field label="Price" value={`$${device.purchasePrice.toFixed(2)}`} />}
            {device.purchaseStore && <Field label="From" value={device.purchaseStore} className="col-span-2" />}
            {device.warrantyExpires && <Field label="Warranty until" value={device.warrantyExpires} className="col-span-2" />}
            {device.warrantyNotes && <Field label="Warranty notes" value={device.warrantyNotes} className="col-span-2" />}
          </div>

          {device.notes && (
            <p className="text-sm text-muted-foreground italic">{device.notes}</p>
          )}

          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              <Pencil className="size-3 mr-1" />Edit
            </Button>
            <Button size="sm" variant="destructive" onClick={onDelete}>
              <Trash2 className="size-3 mr-1" />Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={cn('flex flex-col', className)}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}

// ── Links Tab ─────────────────────────────────────────────────────────────────

function LinksTab({ device }: { device: HomeDevice }) {
  const [links, setLinks] = useState<DeviceLink[]>([])
  const [loading, setLoading] = useState(true)
  const [addForm, setAddForm] = useState<{ category: string; label: string; url: string } | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch(`/api/home/devices/${device.id}/links`, { credentials: 'include' })
      .then(r => r.json() as Promise<{ links: DeviceLink[] }>)
      .then(d => { setLinks(d.links); setLoading(false) })
      .catch(() => setLoading(false))
  }, [device.id])

  async function addLink() {
    if (!addForm || !addForm.label.trim() || !addForm.url.trim()) return
    setSaving(true)
    const res = await fetch(`/api/home/devices/${device.id}/links`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(addForm),
    })
    if (res.ok) {
      const data = await res.json() as { link: DeviceLink }
      setLinks(prev => [...prev, data.link])
      setAddForm(null)
    }
    setSaving(false)
  }

  async function deleteLink(id: string) {
    await fetch(`/api/home/devices/${device.id}/links/${id}`, { method: 'DELETE', credentials: 'include' })
    setLinks(prev => prev.filter(l => l.id !== id))
  }

  const autoLinks = [
    device.manualPath && { key: 'pdf', label: 'Manual PDF', href: `/api/home/devices/${device.id}/manual`, icon: 'pdf' },
    device.manualUrl && { key: 'manualUrl', label: 'Manual page', href: device.manualUrl, icon: 'link' },
    device.supportUrl && { key: 'supportUrl', label: 'Support page', href: device.supportUrl, icon: 'link' },
    device.supportPhone && { key: 'phone', label: device.supportPhone, href: `tel:${device.supportPhone}`, icon: 'phone' },
  ].filter(Boolean) as Array<{ key: string; label: string; href: string; icon: string }>

  const LINK_CATS = ['manual', 'support', 'download', 'video', 'other'] as const
  const CAT_LABELS: Record<string, string> = { manual: 'Manual', support: 'Support', download: 'Downloads', video: 'Videos', other: 'Other' }
  const grouped = Object.fromEntries(LINK_CATS.map(c => [c, links.filter(l => l.category === c)]))

  return (
    <div className="flex flex-col gap-4">
      {autoLinks.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Auto-found</p>
          <div className="flex flex-col gap-1.5">
            {autoLinks.map(l => (
              <div key={l.key} className="flex items-center justify-between rounded-lg border p-3">
                <div className="flex items-center gap-2 text-sm">
                  {l.icon === 'pdf' && <FileText className="size-4 text-red-500 shrink-0" />}
                  {l.icon === 'link' && <ExternalLink className="size-4 text-muted-foreground shrink-0" />}
                  {l.icon === 'phone' && <Phone className="size-4 text-muted-foreground shrink-0" />}
                  <span className="truncate max-w-[220px]">{l.label}</span>
                </div>
                <Button size="sm" variant="ghost" className="h-7 px-2 shrink-0" asChild>
                  <a href={l.href} target={l.icon === 'phone' ? undefined : '_blank'} rel="noreferrer">Open</a>
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {LINK_CATS.map(cat => {
        const catLinks = grouped[cat] ?? []
        if (catLinks.length === 0) return null
        return (
          <div key={cat}>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">{CAT_LABELS[cat]}</p>
            <div className="flex flex-col gap-1.5">
              {catLinks.map(l => (
                <div key={l.id} className="flex items-center justify-between rounded-lg border p-3">
                  <div className="flex items-center gap-2 text-sm min-w-0">
                    {cat === 'video'
                      ? <svg className="size-4 shrink-0 text-red-500" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
                      : <Link2 className="size-4 text-muted-foreground shrink-0" />
                    }
                    <span className="truncate">{l.label}</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button size="icon" variant="ghost" className="size-7" asChild>
                      <a href={l.url} target="_blank" rel="noreferrer"><ExternalLink className="size-3" /></a>
                    </Button>
                    <Button size="icon" variant="ghost" className="size-7" onClick={() => deleteLink(l.id)}>
                      <X className="size-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })}

      {autoLinks.length === 0 && links.length === 0 && !loading && device.lookupStatus !== 'pending' && (
        <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
          {device.lookupStatus === 'pending'
            ? 'Searching for links…'
            : 'No links found automatically. Add some below.'}
        </div>
      )}

      {addForm ? (
        <div className="rounded-lg border p-3 flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Category</Label>
              <select
                value={addForm.category}
                onChange={e => setAddForm(f => f ? { ...f, category: e.target.value } : f)}
                className="mt-1 flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="manual">Manual</option>
                <option value="support">Support</option>
                <option value="download">Download</option>
                <option value="video">Video</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <Label className="text-xs">Label</Label>
              <Input value={addForm.label} onChange={e => setAddForm(f => f ? { ...f, label: e.target.value } : f)} className="mt-1 h-8 text-sm" placeholder="e.g. Driver download" />
            </div>
            <div className="col-span-2">
              <Label className="text-xs">URL</Label>
              <Input value={addForm.url} onChange={e => setAddForm(f => f ? { ...f, url: e.target.value } : f)} className="mt-1 h-8 text-sm" placeholder="https://…" />
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={addLink} disabled={saving || !addForm.label.trim() || !addForm.url.trim()}>
              {saving && <Loader2 className="size-3 mr-1 animate-spin" />}Add
            </Button>
            <Button size="sm" variant="outline" onClick={() => setAddForm(null)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setAddForm({ category: 'other', label: '', url: '' })} className="self-start">
          <Plus className="size-3 mr-1" />Add link
        </Button>
      )}
    </div>
  )
}

// ── Photos Tab ────────────────────────────────────────────────────────────────

function PhotosTab({ device, onUpdated }: { device: HomeDevice; onUpdated: (d: HomeDevice) => void }) {
  const [photos, setPhotos] = useState<DeviceFile[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<DeviceFile | null>(null)
  const [fullscreen, setFullscreen] = useState<DeviceFile | null>(null)
  const [settingMain, setSettingMain] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [editingComment, setEditingComment] = useState(false)
  const [commentDraft, setCommentDraft] = useState('')
  const [savingComment, setSavingComment] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch(`/api/home/devices/${device.id}/files`, { credentials: 'include' })
      .then(r => r.json() as Promise<{ files: DeviceFile[] }>)
      .then(d => { setPhotos(d.files.filter(f => f.fileType === 'image')); setLoading(false) })
      .catch(() => setLoading(false))
  }, [device.id])

  function selectPhoto(photo: DeviceFile) {
    setSelected(photo)
    setCommentDraft(photo.comment ?? '')
    setEditingComment(false)
  }

  async function setMainPhoto() {
    if (!selected) return
    setSettingMain(true)
    const res = await fetch(`/api/home/devices/${device.id}/set-main-photo`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: selected.id }),
    })
    if (res.ok) {
      const data = await res.json() as { device: HomeDevice }
      onUpdated(data.device)
    }
    setSettingMain(false)
  }

  async function saveComment() {
    if (!selected) return
    setSavingComment(true)
    const res = await fetch(`/api/home/devices/${device.id}/files/${selected.id}/comment`, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: commentDraft }),
    })
    if (res.ok) {
      const data = await res.json() as { file: DeviceFile }
      setPhotos(prev => prev.map(p => p.id === data.file.id ? data.file : p))
      setSelected(data.file)
      setEditingComment(false)
    }
    setSavingComment(false)
  }

  async function uploadPhoto(file: File) {
    setUploading(true)
    const fd = new FormData()
    fd.append('file', file)
    fd.append('label', file.name)
    const res = await fetch(`/api/home/devices/${device.id}/files`, {
      method: 'POST', credentials: 'include', body: fd,
    })
    if (res.ok) {
      const data = await res.json() as { file: DeviceFile }
      if (data.file.fileType === 'image') {
        setPhotos(prev => [...prev, data.file])
        selectPhoto(data.file)
      }
    }
    setUploading(false)
  }

  const userPhotos = photos.filter(p => p.source === 'user')
  const aiPhotos   = photos.filter(p => p.source === 'ai')
  const isMain     = selected?.id === device.mainPhotoId

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{photos.length} photo{photos.length !== 1 ? 's' : ''}</p>
        <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
          {uploading ? <Loader2 className="size-3 animate-spin mr-1" /> : <Upload className="size-3 mr-1" />}
          Upload
        </Button>
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) uploadPhoto(f); e.target.value = '' }} />
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : photos.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">No photos yet. Upload one or run a lookup to find product images.</p>
      ) : (
        <>
          {/* Selected photo detail */}
          {selected && (
            <div className="rounded-xl border border-border overflow-hidden">
              <img
                src={`/api/home/devices/${device.id}/files/${selected.id}`}
                alt={selected.label}
                className="w-full max-h-56 object-contain bg-muted cursor-zoom-in"
                onClick={() => setFullscreen(selected)}
                title="Click to view fullscreen"
              />
              <div className="p-3 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium flex-1 truncate">{selected.label}</span>
                  <span className={cn(
                    'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                    selected.source === 'user'
                      ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                      : 'bg-brand/10 text-brand'
                  )}>
                    {selected.source === 'user' ? 'Your photo' : 'AI found'}
                  </span>
                  {isMain && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium flex items-center gap-1"><Star className="size-2.5 fill-current" />Cover</span>}
                </div>

                {/* Comment */}
                {editingComment ? (
                  <div className="flex flex-col gap-1.5">
                    <textarea
                      className="w-full text-xs rounded-md border border-input bg-background px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                      rows={2}
                      placeholder="Add a note about this photo…"
                      value={commentDraft}
                      onChange={e => setCommentDraft(e.target.value)}
                      autoFocus
                    />
                    <div className="flex gap-1.5">
                      <Button size="sm" className="h-6 text-xs" onClick={saveComment} disabled={savingComment}>
                        {savingComment && <Loader2 className="size-3 mr-1 animate-spin" />}Save
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setEditingComment(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="text-left text-xs text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => setEditingComment(true)}
                  >
                    {selected.comment ? selected.comment : <span className="italic">Add a note…</span>}
                  </button>
                )}

                {/* Actions */}
                {!isMain && (
                  <Button size="sm" variant="outline" className="w-full h-7 text-xs" onClick={setMainPhoto} disabled={settingMain}>
                    {settingMain ? <Loader2 className="size-3 mr-1 animate-spin" /> : <Star className="size-3 mr-1" />}
                    Make cover photo
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Your photos */}
          {userPhotos.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Your photos</p>
              <div className="grid grid-cols-4 gap-1.5">
                {userPhotos.map(photo => (
                  <button key={photo.id} onClick={() => selectPhoto(photo)}
                    className={cn('relative aspect-square rounded-lg overflow-hidden border-2 transition-all',
                      selected?.id === photo.id ? 'border-primary' : 'border-transparent hover:border-muted-foreground/30')}>
                    <img src={`/api/home/devices/${device.id}/files/${photo.id}`} alt={photo.label}
                      className="w-full h-full object-cover" />
                    {photo.id === device.mainPhotoId && (
                      <div className="absolute top-0.5 right-0.5 bg-primary rounded-full p-0.5">
                        <Star className="size-2.5 fill-current text-primary-foreground" />
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* AI found photos */}
          {aiPhotos.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">AI found</p>
              <div className="grid grid-cols-4 gap-1.5">
                {aiPhotos.map(photo => (
                  <button key={photo.id} onClick={() => selectPhoto(photo)}
                    className={cn('relative aspect-square rounded-lg overflow-hidden border-2 transition-all',
                      selected?.id === photo.id ? 'border-primary' : 'border-transparent hover:border-muted-foreground/30')}>
                    <img src={`/api/home/devices/${device.id}/files/${photo.id}`} alt={photo.label}
                      className="w-full h-full object-cover" />
                    {photo.id === device.mainPhotoId && (
                      <div className="absolute top-0.5 right-0.5 bg-primary rounded-full p-0.5">
                        <Star className="size-2.5 fill-current text-primary-foreground" />
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Fullscreen lightbox */}
      {fullscreen && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
          onClick={() => setFullscreen(null)}
        >
          <img
            src={`/api/home/devices/${device.id}/files/${fullscreen.id}`}
            alt={fullscreen.label}
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
            onClick={e => e.stopPropagation()}
          />
          <button
            className="absolute top-4 right-4 text-white/70 hover:text-white bg-black/40 rounded-full p-1.5"
            onClick={() => setFullscreen(null)}
          >
            <X className="size-5" />
          </button>
          {fullscreen.comment && (
            <p className="absolute bottom-6 left-1/2 -translate-x-1/2 text-white/80 text-sm bg-black/50 rounded-lg px-4 py-2 max-w-sm text-center">
              {fullscreen.comment}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Specs Tab ─────────────────────────────────────────────────────────────────

function SpecsTab({ device, onUpdated }: { device: HomeDevice; onUpdated: (d: HomeDevice) => void }) {
  const parseSpecs = (): Record<string, string> => {
    if (!device.specs) return {}
    try { return JSON.parse(device.specs) as Record<string, string> } catch { return {} }
  }

  const [specs, setSpecs] = useState<Record<string, string>>(parseSpecs)
  const [generating, setGenerating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  const [addingRow, setAddingRow] = useState(false)
  const [dirty, setDirty] = useState(false)

  async function generate() {
    setGenerating(true)
    const res = await fetch(`/api/home/devices/${device.id}/generate-specs`, {
      method: 'POST', credentials: 'include',
    })
    if (res.ok) {
      const data = await res.json() as { device: HomeDevice }
      onUpdated(data.device)
      if (data.device.specs) {
        try { setSpecs(JSON.parse(data.device.specs) as Record<string, string>); setDirty(false) } catch {}
      }
    }
    setGenerating(false)
  }

  async function save() {
    setSaving(true)
    const fd = new FormData()
    fd.append('specs', JSON.stringify(specs))
    const res = await fetch(`/api/home/devices/${device.id}`, {
      method: 'PATCH', credentials: 'include', body: fd,
    })
    if (res.ok) {
      const data = await res.json() as { device: HomeDevice }
      onUpdated(data.device)
      setDirty(false)
    }
    setSaving(false)
  }

  function updateSpec(key: string, value: string) {
    setSpecs(prev => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  function deleteSpec(key: string) {
    setSpecs(prev => { const next = { ...prev }; delete next[key]; return next })
    setDirty(true)
  }

  function addSpec() {
    if (!newKey.trim()) return
    setSpecs(prev => ({ ...prev, [newKey.trim()]: newValue.trim() }))
    setNewKey('')
    setNewValue('')
    setAddingRow(false)
    setDirty(true)
  }

  const entries = Object.entries(specs)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{entries.length} spec{entries.length !== 1 ? 's' : ''}</p>
        <div className="flex gap-2">
          {dirty && (
            <Button size="sm" onClick={save} disabled={saving}>
              {saving && <Loader2 className="size-3 mr-1 animate-spin" />}Save
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={generate} disabled={generating || !device.brand || !device.model}>
            {generating ? <Loader2 className="size-3 mr-1 animate-spin" /> : <Sparkles className="size-3 mr-1" />}
            Generate
          </Button>
        </div>
      </div>

      {entries.length === 0 && !generating ? (
        <p className="text-sm text-muted-foreground text-center py-6">
          {device.brand && device.model
            ? 'No specs yet. Click Generate to auto-fill from AI.'
            : 'Add brand and model first to generate specs.'}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {entries.map(([key, value]) => (
            <div key={key} className="grid grid-cols-[auto_1fr_auto] gap-2 items-center">
              <span className="text-xs text-muted-foreground font-medium w-28 truncate shrink-0">{key}</span>
              <Input
                value={value}
                onChange={e => updateSpec(key, e.target.value)}
                className="h-7 text-sm"
              />
              <Button size="icon" variant="ghost" className="size-7 shrink-0" onClick={() => deleteSpec(key)}>
                <X className="size-3" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {addingRow ? (
        <div className="flex gap-2 items-end mt-1">
          <div className="flex-1">
            <Label className="text-xs">Spec name</Label>
            <Input value={newKey} onChange={e => setNewKey(e.target.value)} className="mt-1 h-8 text-sm" placeholder="e.g. RAM" />
          </div>
          <div className="flex-1">
            <Label className="text-xs">Value</Label>
            <Input
              value={newValue}
              onChange={e => setNewValue(e.target.value)}
              className="mt-1 h-8 text-sm"
              placeholder="e.g. 32 GB"
              onKeyDown={e => { if (e.key === 'Enter') addSpec() }}
            />
          </div>
          <Button size="sm" onClick={addSpec} disabled={!newKey.trim()}>Add</Button>
          <Button size="sm" variant="ghost" onClick={() => setAddingRow(false)}><X className="size-3" /></Button>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setAddingRow(true)} className="self-start">
          <Plus className="size-3 mr-1" />Add spec
        </Button>
      )}

      {device.rawLabelText && <ScanTextCollapsible text={device.rawLabelText} />}
    </div>
  )
}

function ScanTextCollapsible({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-2 border border-border/50 rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-xs text-muted-foreground hover:bg-muted/40 transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <span className="flex items-center gap-1.5">
          <ScanText className="size-3" />
          AI scan text
        </span>
        <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <pre className="px-3 py-2 text-[10px] font-mono leading-relaxed whitespace-pre-wrap text-muted-foreground bg-muted/20 border-t border-border/50 max-h-64 overflow-y-auto">
          {text}
        </pre>
      )}
    </div>
  )
}

// ── Service Log Tab ───────────────────────────────────────────────────────────

function ServiceTab({ deviceId }: { deviceId: string }) {
  const [entries, setEntries] = useState<ServiceEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ date: new Date().toISOString().split('T')[0], type: 'other', description: '', technician: '', cost: '' })
  const [saving, setSaving] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/home/devices/${deviceId}/service`, { credentials: 'include' })
      .then(r => r.json() as Promise<{ entries: ServiceEntry[] }>)
      .then(d => { setEntries(d.entries); setLoading(false) })
      .catch(() => setLoading(false))
  }, [deviceId])

  async function addEntry() {
    if (!form.description.trim()) return
    setSaving(true)
    const res = await fetch(`/api/home/devices/${deviceId}/service`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, cost: form.cost ? parseFloat(form.cost) : undefined }),
    })
    if (res.ok) {
      const data = await res.json() as { entry: ServiceEntry }
      setEntries(prev => [data.entry, ...prev])
      setForm({ date: new Date().toISOString().split('T')[0], type: 'other', description: '', technician: '', cost: '' })
      setShowForm(false)
    }
    setSaving(false)
  }

  async function deleteEntry(id: string) {
    await fetch(`/api/home/devices/${deviceId}/service/${id}`, { method: 'DELETE', credentials: 'include' })
    setEntries(prev => prev.filter(e => e.id !== id))
    setDeleteId(null)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{entries.length} record{entries.length !== 1 ? 's' : ''}</p>
        <Button size="sm" variant="outline" onClick={() => setShowForm(v => !v)}>
          <Plus className="size-3 mr-1" />Add record
        </Button>
      </div>

      {showForm && (
        <div className="rounded-lg border p-3 flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Date</Label>
              <Input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} className="mt-1 h-8 text-sm" />
            </div>
            <div>
              <Label className="text-xs">Type</Label>
              <select
                value={form.type}
                onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                className="mt-1 flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring capitalize"
              >
                {SERVICE_TYPES.map(t => <option key={t} value={t} className="capitalize">{t}</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <Label className="text-xs">Description</Label>
              <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="mt-1 resize-none text-sm" rows={2} placeholder="What was done?" />
            </div>
            <div>
              <Label className="text-xs">Technician / Company</Label>
              <Input value={form.technician} onChange={e => setForm(f => ({ ...f, technician: e.target.value }))} className="mt-1 h-8 text-sm" placeholder="Optional" />
            </div>
            <div>
              <Label className="text-xs">Cost ($)</Label>
              <Input type="number" value={form.cost} onChange={e => setForm(f => ({ ...f, cost: e.target.value }))} className="mt-1 h-8 text-sm" placeholder="0.00" />
            </div>
          </div>
          <div className="flex gap-2 mt-1">
            <Button size="sm" onClick={addEntry} disabled={saving || !form.description.trim()}>
              {saving && <Loader2 className="size-3 mr-1 animate-spin" />}Save
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">No service records yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {entries.map(entry => (
            <div key={entry.id} className="rounded-lg border p-3 text-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{entry.date}</span>
                  <Badge variant="secondary" className="text-xs capitalize">{entry.type}</Badge>
                  {entry.cost != null && <span className="text-muted-foreground">${entry.cost.toFixed(2)}</span>}
                </div>
                <Button size="icon" variant="ghost" className="size-6 shrink-0" onClick={() => setDeleteId(entry.id)}>
                  <X className="size-3" />
                </Button>
              </div>
              <p className="text-muted-foreground mt-1">{entry.description}</p>
              {entry.technician && <p className="text-xs text-muted-foreground/70 mt-0.5">By {entry.technician}</p>}
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!deleteId}
        onOpenChange={open => { if (!open) setDeleteId(null) }}
        title="Delete service record?"
        confirmLabel="Delete"
        destructive
        onConfirm={() => deleteId && deleteEntry(deleteId)}
      />
    </div>
  )
}

// ── Files Tab ─────────────────────────────────────────────────────────────────

function FilesTab({ deviceId }: { deviceId: string }) {
  const [files, setFiles] = useState<DeviceFile[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [label, setLabel] = useState('')

  useEffect(() => {
    fetch(`/api/home/devices/${deviceId}/files`, { credentials: 'include' })
      .then(r => r.json() as Promise<{ files: DeviceFile[] }>)
      .then(d => { setFiles(d.files.filter(f => f.fileType !== 'image')); setLoading(false) })
      .catch(() => setLoading(false))
  }, [deviceId])

  async function upload(file: File) {
    setUploading(true)
    const fd = new FormData()
    fd.append('file', file)
    fd.append('label', label || file.name)
    const res = await fetch(`/api/home/devices/${deviceId}/files`, {
      method: 'POST', credentials: 'include', body: fd,
    })
    if (res.ok) {
      const data = await res.json() as { file: DeviceFile }
      if (data.file.fileType !== 'image') setFiles(prev => [...prev, data.file])
      setLabel('')
    }
    setUploading(false)
  }

  async function deleteFile(id: string) {
    await fetch(`/api/home/devices/${deviceId}/files/${id}`, { method: 'DELETE', credentials: 'include' })
    setFiles(prev => prev.filter(f => f.id !== id))
    setDeleteId(null)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Input placeholder="Label (optional)" value={label} onChange={e => setLabel(e.target.value)} className="h-8 text-sm" />
        <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
          {uploading ? <Loader2 className="size-3 animate-spin" /> : <Upload className="size-3 mr-1" />}
          Upload
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept=".pdf,.doc,.docx"
          onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = '' }}
        />
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : files.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">No files attached. Upload manuals, receipts, or warranty cards.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {files.map(f => (
            <div key={f.id} className="flex items-center gap-3 rounded-lg border p-3">
              <span className="text-xl">{f.fileType === 'pdf' ? '📄' : '📎'}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{f.label}</p>
                {f.sizeBytes && <p className="text-xs text-muted-foreground">{formatBytes(f.sizeBytes)}</p>}
              </div>
              <div className="flex items-center gap-1">
                <Button size="icon" variant="ghost" className="size-7" asChild>
                  <a href={`/api/home/devices/${deviceId}/files/${f.id}`} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-3" />
                  </a>
                </Button>
                <Button size="icon" variant="ghost" className="size-7" onClick={() => setDeleteId(f.id)}>
                  <X className="size-3" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!deleteId}
        onOpenChange={open => { if (!open) setDeleteId(null) }}
        title="Delete file?"
        confirmLabel="Delete"
        destructive
        onConfirm={() => deleteId && deleteFile(deleteId)}
      />
    </div>
  )
}

// ── Ask AI Tab ────────────────────────────────────────────────────────────────

function AskAITab({ device }: { device: HomeDevice }) {
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [asking, setAsking] = useState(false)

  async function ask() {
    if (!question.trim() || asking) return
    setAsking(true)
    setAnswer('')
    try {
      const res = await fetch(`/api/home/devices/${device.id}/ask`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      })
      if (!res.ok || !res.body) { setAsking(false); return }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const payload = JSON.parse(line.slice(6)) as { token?: string; done?: boolean }
          if (payload.token) setAnswer(prev => prev + payload.token)
        }
      }
    } finally {
      setAsking(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">Ask anything about this device — error codes, maintenance, compatibility, etc.</p>
      <div className="flex gap-2">
        <Input
          placeholder="e.g. What does error E5 mean?"
          value={question}
          onChange={e => setQuestion(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') ask() }}
          disabled={asking}
        />
        <Button size="icon" onClick={ask} disabled={asking || !question.trim()}>
          {asking ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </Button>
      </div>
      {answer && (
        <div className="rounded-lg bg-muted/50 p-3 text-sm whitespace-pre-wrap">{answer}</div>
      )}
    </div>
  )
}

// ── Main Sheet ────────────────────────────────────────────────────────────────

type TabId = 'overview' | 'links' | 'photos' | 'specs' | 'service' | 'files' | 'ask'
const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'links', label: 'Links' },
  { id: 'photos', label: 'Photos' },
  { id: 'specs', label: 'Specs' },
  { id: 'service', label: 'Service' },
  { id: 'files', label: 'Files' },
  { id: 'ask', label: 'Ask AI' },
]

export function DeviceSheet({ device, open, onOpenChange, onUpdated, onDeleted }: DeviceSheetProps) {
  const [activeTab, setActiveTab] = useState<TabId>('overview')
  const [confirmDelete, setConfirmDelete] = useState(false)

  async function handleDelete() {
    await fetch(`/api/home/devices/${device.id}`, { method: 'DELETE', credentials: 'include' })
    onDeleted(device.id)
    onOpenChange(false)
  }

  async function handleLookup() {
    await fetch(`/api/home/devices/${device.id}/lookup`, { method: 'POST', credentials: 'include' })
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full sm:max-w-lg flex flex-col gap-0 p-0 overflow-hidden">
          <SheetHeader className="px-6 py-4 border-b shrink-0">
            <SheetTitle className="truncate">{device.name}</SheetTitle>
          </SheetHeader>

          {/* Tab bar — horizontally scrollable so all 7 tabs fit */}
          <div className="flex gap-0.5 px-3 pt-2 border-b shrink-0 overflow-x-auto scrollbar-none">
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={cn(
                  'px-2.5 py-2 text-sm font-medium rounded-t-md border-b-2 transition-colors whitespace-nowrap shrink-0',
                  activeTab === t.id
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            {activeTab === 'overview' && (
              <OverviewTab
                device={device}
                onUpdated={onUpdated}
                onDelete={() => setConfirmDelete(true)}
                onLookup={handleLookup}
              />
            )}
            {activeTab === 'links'    && <LinksTab device={device} />}
            {activeTab === 'photos'   && <PhotosTab device={device} onUpdated={onUpdated} />}
            {activeTab === 'specs'    && <SpecsTab device={device} onUpdated={onUpdated} />}
            {activeTab === 'service'  && <ServiceTab deviceId={device.id} />}
            {activeTab === 'files'    && <FilesTab deviceId={device.id} />}
            {activeTab === 'ask'      && <AskAITab device={device} />}
          </div>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete "${device.name}"?`}
        description="This will permanently delete the device, all service records, and attached files."
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
      />
    </>
  )
}
