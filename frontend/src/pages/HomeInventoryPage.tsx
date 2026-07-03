import { useState, useEffect, useRef, useCallback } from 'react'
import { Plus, Package, AlertTriangle, ChevronRight, CheckCircle2, Clock, WifiOff, Camera, FileText, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cardVariants } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'
import { PageShell } from '@/components/shared/PageShell'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { DeviceSheet } from './home/DeviceSheet'
import { AddDeviceModal } from './home/AddDeviceModal'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'

export type DeviceCategory = 'appliance' | 'electronics' | 'vehicle' | 'tool' | 'furniture' | 'other'
export type LookupStatus = 'pending' | 'complete' | 'failed' | 'skipped'

export interface HomeDevice {
  id: string
  name: string
  brand: string | null
  model: string | null
  serialNumber: string | null
  category: DeviceCategory
  location: string | null
  owner: string | null
  description: string | null
  manufacturedDate: string | null
  specs: string | null  // JSON key-value string
  photoPath: string | null
  mainPhotoId: string | null
  purchaseDate: string | null
  purchasePrice: number | null
  purchaseStore: string | null
  warrantyExpires: string | null
  warrantyNotes: string | null
  supportUrl: string | null
  supportPhone: string | null
  rawLabelText: string | null
  manualPath: string | null
  manualUrl: string | null
  manualText: string | null
  notes: string | null
  lookupStatus: LookupStatus
  addedBy: string
  createdAt: string
  updatedAt: string
}

const CATEGORIES: { value: string; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'appliance', label: 'Appliances' },
  { value: 'electronics', label: 'Electronics' },
  { value: 'vehicle', label: 'Vehicles' },
  { value: 'tool', label: 'Tools' },
  { value: 'furniture', label: 'Furniture' },
  { value: 'other', label: 'Other' },
]

const CATEGORY_ICONS: Record<string, string> = {
  appliance: '🏠', electronics: '📱', vehicle: '🚗', tool: '🔧', furniture: '🛋️', other: '📦',
}

function warrantyDaysLeft(expires: string | null): number | null {
  if (!expires) return null
  const now = new Date()
  const exp = new Date(expires)
  return Math.ceil((exp.getTime() - now.getTime()) / 86_400_000)
}

function WarrantyBadge({ expires }: { expires: string | null }) {
  if (!expires) return null
  const days = warrantyDaysLeft(expires)
  if (days === null) return null
  if (days < 0) return <Badge variant="destructive" className="text-xs">Warranty expired</Badge>
  if (days <= 30) return <Badge variant="destructive" className="text-xs">Expires in {days}d</Badge>
  if (days <= 90) return <Badge className="text-xs bg-warning text-warning-foreground hover:bg-warning">Expires in {days}d</Badge>
  return null
}

function LookupStatusIcon({ status }: { status: LookupStatus }) {
  if (status === 'pending') return <Clock className="size-3 text-muted-foreground" />
  if (status === 'complete') return <CheckCircle2 className="size-3 text-success" />
  if (status === 'failed') return <WifiOff className="size-3 text-muted-foreground" />
  return null
}

function DeviceCard({ device, onClick }: { device: HomeDevice; onClick: () => void }) {
  const hasPhoto = !!device.photoPath
  const icon = CATEGORY_ICONS[device.category] ?? '📦'

  return (
    <button
      onClick={onClick}
      className={cn(cardVariants({ variant: 'interactive' }), 'group flex flex-col gap-3 p-4 text-left')}
    >
      <div className="flex items-start gap-3">
        {hasPhoto ? (
          <img
            src={`/api/home/devices/${device.id}/photo`}
            alt={device.name}
            className="size-14 shrink-0 rounded-control object-cover bg-muted"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
          />
        ) : (
          <div className="size-14 shrink-0 rounded-control bg-muted flex items-center justify-center text-2xl">
            {icon}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-medium text-sm truncate">{device.name}</span>
            <LookupStatusIcon status={device.lookupStatus} />
          </div>
          {(device.brand || device.model) && (
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {[device.brand, device.model].filter(Boolean).join(' · ')}
            </p>
          )}
          {device.location && (
            <p className="text-xs text-muted-foreground/70 truncate">{device.location}</p>
          )}
        </div>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors mt-0.5" />
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <Badge variant="secondary" className="text-xs capitalize">{device.category}</Badge>
        <WarrantyBadge expires={device.warrantyExpires} />
        {device.manualPath && (
          <Badge variant="outline" className="text-xs">Manual</Badge>
        )}
      </div>
    </button>
  )
}

function WarrantyAlerts({ devices }: { devices: HomeDevice[] }) {
  const today = new Date().toISOString().split('T')[0]
  const expiring = devices.filter(d => {
    if (!d.warrantyExpires) return false
    const days = warrantyDaysLeft(d.warrantyExpires)
    return days !== null && days >= 0 && days <= 30
  })
  const expired = devices.filter(d => d.warrantyExpires && d.warrantyExpires < today)

  if (expiring.length === 0 && expired.length === 0) return null

  return (
    <div className="rounded-control border border-warning/30 bg-warning/10 px-4 py-3 flex items-start gap-3">
      <AlertTriangle className="size-4 text-warning shrink-0 mt-0.5" />
      <div className="text-sm">
        {expired.length > 0 && (
          <p className="text-warning font-medium">
            {expired.length} warranty{expired.length > 1 ? 'ies' : 'y'} expired: {expired.map(d => d.name).join(', ')}
          </p>
        )}
        {expiring.length > 0 && (
          <p className="text-warning">
            {expiring.length} expiring soon: {expiring.map(d => `${d.name} (${warrantyDaysLeft(d.warrantyExpires)}d)`).join(', ')}
          </p>
        )}
      </div>
    </div>
  )
}

export function HomeInventoryPage() {
  const [devices, setDevices] = useState<HomeDevice[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  async function load(q?: string, cat?: string) {
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    if (cat && cat !== 'all') params.set('category', cat)
    const res = await fetch(`/api/home/devices?${params}`, { credentials: 'include' })
    if (res.ok) {
      const data = await res.json() as { devices: HomeDevice[] }
      setDevices(data.devices)
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  // Poll pending lookups every 3s
  useEffect(() => {
    const hasPending = devices.some(d => d.lookupStatus === 'pending')
    if (hasPending && !pollRef.current) {
      pollRef.current = setInterval(() => load(search, category), 3_000)
    } else if (!hasPending && pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    }
  }, [devices, search, category])

  const handleSearch = useCallback((val: string) => {
    setSearch(val)
    load(val, category)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category])

  useAppHeader({
    query: search,
    setQuery: handleSearch,
    placeholder: 'Search devices, brands, locations...',
  })

  function handleCategory(val: string) {
    setCategory(val)
    load(search, val)
  }

  function handleAdded(device: HomeDevice) {
    setDevices(prev => [device, ...prev])
    setSelectedId(device.id)
    setShowAdd(false)
  }

  function handleUpdated(device: HomeDevice) {
    setDevices(prev => prev.map(d => d.id === device.id ? device : d))
  }

  function handleDeleted(id: string) {
    setDevices(prev => prev.filter(d => d.id !== id))
    setSelectedId(null)
  }

  const selectedDevice = devices.find(d => d.id === selectedId) ?? null

  return (
    <PageShell className="h-full overflow-hidden">
      {/* Category filters + add button */}
      <div className="flex items-center gap-3 px-6 py-3 border-b shrink-0">
        <div className="flex gap-1.5 flex-wrap flex-1">
          {CATEGORIES.map(cat => (
            <button
              key={cat.value}
              onClick={() => handleCategory(cat.value)}
              className={cn(
                'px-3 py-1 rounded-full text-xs font-medium transition-colors border',
                category === cat.value
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-muted/50 text-muted-foreground border-transparent hover:border-border hover:text-foreground'
              )}
            >
              {cat.label}
            </button>
          ))}
        </div>
        <Button size="sm" variant="secondary" className="shrink-0" onClick={() => setShowAdd(true)}>
          <Plus className="size-3.5" />
          Add
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading ? (
          <div className="flex items-center justify-center h-40">
            <Spinner size="lg" />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <WarrantyAlerts devices={devices} />

            {devices.length === 0 ? (
              <EmptyAppState
                icon={Package}
                // design-ok(hex-in-tsx): registry identity fallback data
                gradient="linear-gradient(135deg,#1e3a5f,#1d4ed8)"
                title="Your home, fully documented"
                tagline="Add any appliance, device, or piece of equipment. Upload a photo and we'll find the manual, support info, and warranty details automatically."
                actions={
                  <Button onClick={() => setShowAdd(true)}>
                    <Plus className="mr-1.5 size-4" />Add your first device
                  </Button>
                }
                features={[
                  { icon: Camera, title: 'Photo identification', desc: 'Snap a label and AI reads the model number to find the manual.' },
                  { icon: FileText, title: 'Auto-fetched manuals', desc: 'PDF user manuals downloaded and stored locally for offline access.' },
                  { icon: AlertTriangle, title: 'Warranty alerts', desc: 'See which warranties are expiring so you never miss a claim window.' },
                  { icon: Wrench, title: 'Service log', desc: 'Track repairs and maintenance dates for every device you own.' },
                ]}
              />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {devices.map(device => (
                  <DeviceCard
                    key={device.id}
                    device={device}
                    onClick={() => setSelectedId(device.id)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Device detail sheet */}
      {selectedDevice && (
        <DeviceSheet
          device={selectedDevice}
          open={!!selectedId}
          onOpenChange={open => { if (!open) setSelectedId(null) }}
          onUpdated={handleUpdated}
          onDeleted={handleDeleted}
        />
      )}

      {/* Add device modal */}
      <AddDeviceModal
        open={showAdd}
        onOpenChange={setShowAdd}
        onAdded={handleAdded}
      />
    </PageShell>
  )
}
