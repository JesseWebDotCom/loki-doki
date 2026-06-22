import { useState, useRef } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Camera, Loader2, Sparkles, ChevronRight, ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { HomeDevice, DeviceCategory } from '../HomeInventoryPage'

interface AddDeviceModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: (device: HomeDevice) => void
}

const CATEGORIES: { value: DeviceCategory; label: string }[] = [
  { value: 'appliance', label: 'Appliance' },
  { value: 'electronics', label: 'Electronics' },
  { value: 'vehicle', label: 'Vehicle' },
  { value: 'tool', label: 'Tool' },
  { value: 'furniture', label: 'Furniture' },
  { value: 'other', label: 'Other' },
]

type Step = 'capture' | 'confirm'

interface Identified {
  name?: string | null
  brand?: string | null
  model?: string | null
  serialNumber?: string | null
  category?: string | null
  manufacturedDate?: string | null
  labelSpecs?: Record<string, string> | null
  rawLabelText?: string | null
  visualDescription?: string | null
  confidence?: string | null
}

export function AddDeviceModal({ open, onOpenChange, onAdded }: AddDeviceModalProps) {
  const [step, setStep] = useState<Step>('capture')
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const [identifying, setIdentifying] = useState(false)
  const [identified, setIdentified] = useState<Identified | null>(null)
  const [createdId, setCreatedId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [showDebug, setShowDebug] = useState(false)

  const [form, setForm] = useState({
    name: '',
    brand: '',
    model: '',
    serialNumber: '',
    category: 'other' as DeviceCategory,
    location: '',
    warrantyExpires: '',
    manufacturedDate: '',
  })

  const fileInputRef = useRef<HTMLInputElement>(null)

  function reset() {
    setStep('capture')
    setPhotoFile(null)
    setPhotoPreview(null)
    setIdentifying(false)
    setIdentified(null)
    setCreatedId(null)
    setSaving(false)
    setDragOver(false)
    setForm({ name: '', brand: '', model: '', serialNumber: '', category: 'other', location: '', warrantyExpires: '', manufacturedDate: '' })
  }

  function handleClose(open: boolean) {
    if (!open) reset()
    onOpenChange(open)
  }

  async function pickAndIdentify(file: File) {
    setPhotoFile(file)
    setPhotoPreview(URL.createObjectURL(file))
    setIdentifying(true)
    setStep('confirm') // show spinner immediately while AI works

    // Create device record with photo
    const fd = new FormData()
    fd.append('name', 'Identifying…')
    fd.append('photo', file)
    const createRes = await fetch('/api/home/devices', { method: 'POST', credentials: 'include', body: fd })
    if (!createRes.ok) { setIdentifying(false); setStep('confirm'); return }
    const { device } = await createRes.json() as { device: HomeDevice }
    setCreatedId(device.id)

    const identRes = await fetch(`/api/home/devices/${device.id}/identify`, {
      method: 'POST', credentials: 'include',
    })
    setIdentifying(false)

    if (identRes.ok) {
      const data = await identRes.json() as { identified: Identified }
      const d = data.identified
      setIdentified(d)
      setForm(f => ({
        ...f,
        name:             d.name             ?? f.name,
        brand:            d.brand            ?? f.brand,
        model:            d.model            ?? f.model,
        serialNumber:     d.serialNumber     ?? f.serialNumber,
        category:         (d.category as DeviceCategory) ?? f.category,
        manufacturedDate: d.manufacturedDate ?? f.manufacturedDate,
      }))

      // Kick off web lookup immediately if we have enough to search on — don't wait for save.
      // First patch the device so lookup has the right name/brand/model in the DB.
      if (d.brand || d.model || d.name) {
        const lfd = new FormData()
        if (d.name)         lfd.append('name', d.name)
        if (d.brand)        lfd.append('brand', d.brand)
        if (d.model)        lfd.append('model', d.model)
        if (d.serialNumber) lfd.append('serialNumber', d.serialNumber)
        if (d.category)     lfd.append('category', d.category)
        if (d.manufacturedDate) lfd.append('manufacturedDate', d.manufacturedDate)
        fetch(`/api/home/devices/${device.id}`, { method: 'PATCH', credentials: 'include', body: lfd })
          .then(() => fetch(`/api/home/devices/${device.id}/lookup`, { method: 'POST', credentials: 'include' }))
          .catch(() => {})
      }
    }

    setStep('confirm')
  }

  async function save() {
    if (!form.name.trim()) return
    setSaving(true)

    if (createdId) {
      const fd = new FormData()
      Object.entries(form).forEach(([k, v]) => { if (v) fd.append(k, v) })
      const res = await fetch(`/api/home/devices/${createdId}`, {
        method: 'PATCH', credentials: 'include', body: fd,
      })
      if (res.ok) {
        const data = await res.json() as { device: HomeDevice }
        if (data.device.brand && data.device.model) {
          fetch(`/api/home/devices/${createdId}/lookup`, { method: 'POST', credentials: 'include' }).catch(() => {})
        }
        onAdded(data.device)
      }
    } else {
      const fd = new FormData()
      Object.entries(form).forEach(([k, v]) => { if (v) fd.append(k, v) })
      if (photoFile) fd.append('photo', photoFile)
      const res = await fetch('/api/home/devices', { method: 'POST', credentials: 'include', body: fd })
      if (res.ok) {
        const { device } = await res.json() as { device: HomeDevice }
        if (device.brand && device.model) {
          fetch(`/api/home/devices/${device.id}/lookup`, { method: 'POST', credentials: 'include' }).catch(() => {})
        }
        onAdded(device)
      }
    }

    setSaving(false)
    handleClose(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {step === 'capture' ? 'Add Device' : 'Confirm Details'}
          </DialogTitle>
        </DialogHeader>

        {/* Step 1: Capture */}
        {step === 'capture' && (
          <div className="flex flex-col gap-4">
            <div
              className={cn(
                'flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8 cursor-pointer transition-colors',
                dragOver ? 'border-primary bg-primary/10' :
                'border-border hover:border-primary/40 hover:bg-muted/30'
              )}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => {
                e.preventDefault(); setDragOver(false)
                const f = e.dataTransfer.files[0]
                if (f && f.type.startsWith('image/')) pickAndIdentify(f)
              }}
            >
              <Camera className="size-8 text-muted-foreground" />
              <div className="text-center">
                <p className="text-sm font-medium">Drop a photo here or click to browse</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Close-up, in-focus shot of the label sticker only — AI will read the text
                </p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) pickAndIdentify(f); e.target.value = '' }}
              />
            </div>

            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <Button variant="outline" className="w-full" onClick={() => setStep('confirm')}>
              Enter details manually
              <ChevronRight className="size-4 ml-1" />
            </Button>
          </div>
        )}

        {/* Step 2: Confirm (with optional AI pre-fill) */}
        {step === 'confirm' && (
          <div className="flex flex-col gap-3">
            {/* Photo thumbnail + status */}
            {photoPreview && (
              <div className="flex items-center gap-3">
                <img src={photoPreview} alt="Device" className="size-14 rounded-lg object-cover shrink-0 border" />
                {identifying
                  ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Reading label…</div>
                  : identified
                  ? <div className="flex flex-col gap-1 flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 rounded-lg px-3 py-2">
                        <Sparkles className="size-3 shrink-0" />
                        Label scanned — review below
                        {identified.confidence && <span className="ml-auto opacity-60">{identified.confidence} confidence</span>}
                      </div>
                    </div>
                  : <div className="text-xs text-muted-foreground">Could not read label — fill in manually</div>
                }
              </div>
            )}

            {/* Debug panel — what AI actually read */}
            {identified && (identified.rawLabelText || identified.visualDescription) && (
              <div className="rounded-lg border border-border overflow-hidden text-xs">
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-2 bg-muted/40 hover:bg-muted/60 transition-colors font-medium"
                  onClick={() => setShowDebug(v => !v)}
                >
                  <span>AI scan details</span>
                  {showDebug ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                </button>
                {showDebug && (
                  <div className="divide-y divide-border">
                    {identified.rawLabelText && (
                      <div className="px-3 py-2">
                        <p className="font-medium text-muted-foreground mb-1">OCR text (Tesseract)</p>
                        <pre className="whitespace-pre-wrap font-mono text-[10px] leading-relaxed max-h-32 overflow-y-auto">{identified.rawLabelText}</pre>
                      </div>
                    )}
                    {identified.visualDescription && (
                      <div className="px-3 py-2">
                        <p className="font-medium text-muted-foreground mb-1">Visual assessment (AI)</p>
                        <p className="leading-relaxed">{identified.visualDescription}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="grid gap-3">
              <div>
                <Label className="text-xs">Name *</Label>
                <Input
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  className="mt-1"
                  placeholder="e.g. Lenovo Legion T7 34IMZ5"
                  autoFocus
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Brand</Label>
                  <Input value={form.brand} onChange={e => setForm(f => ({ ...f, brand: e.target.value }))} className="mt-1" placeholder="Lenovo" />
                </div>
                <div>
                  <Label className="text-xs">Model</Label>
                  <Input value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} className="mt-1" placeholder="34IMZ5" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Serial Number</Label>
                  <Input value={form.serialNumber} onChange={e => setForm(f => ({ ...f, serialNumber: e.target.value }))} className="mt-1" placeholder="Optional" />
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
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Location</Label>
                  <Input value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} className="mt-1" placeholder="Office" />
                </div>
                <div>
                  <Label className="text-xs">Warranty Expires</Label>
                  <Input type="date" value={form.warrantyExpires} onChange={e => setForm(f => ({ ...f, warrantyExpires: e.target.value }))} className="mt-1" />
                </div>
              </div>
            </div>
          </div>
        )}

        {step === 'confirm' && (
          <DialogFooter>
            <Button variant="outline" onClick={() => { reset(); setStep('capture') }}>
              Back
            </Button>
            <Button onClick={save} disabled={saving || identifying || !form.name.trim()}>
              {saving && <Loader2 className="size-4 mr-2 animate-spin" />}
              Add Device
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
