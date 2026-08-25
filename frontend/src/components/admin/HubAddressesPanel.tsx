// Admin -> Server -> Addresses. Every way a client can reach this hub, named and ordered.
//
// Apps fetch this list whenever they are connected and cache it to disk, then on the next
// cold start they try the entries top to bottom until one answers. So the order here is
// literally the order a phone will attempt, which is why reordering is drag-and-drop
// rather than a number field: the list IS the setting.
//
// Detected rows (this machine's LAN addresses, the tailnet name) are shown inline but not
// editable. They are recomputed on every read, so a new DHCP lease or a tailnet reconnect
// never strands a client on a stale address.

import { useCallback, useEffect, useState } from 'react'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Check, GripVertical, Globe, Network, Pencil, Plus, RefreshCw, Shield, Trash2, X,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'

// ── Types ─────────────────────────────────────────────────────────────────────

type EndpointKind = 'lan' | 'overlay' | 'public'

interface HubEndpoint {
  id: string
  name: string
  url: string
  kind: EndpointKind
  priority: number
  enabled: boolean
  source: 'detected' | 'managed'
}

interface AddressesPayload {
  instanceId: string
  name: string
  servedFrom: string
  endpoints: HubEndpoint[]
}

const KIND_META: Record<EndpointKind, { label: string; icon: typeof Network; hint: string }> = {
  lan: { label: 'Home network', icon: Network, hint: 'Only works while the device is on your home wifi' },
  overlay: { label: 'Tailscale', icon: Shield, hint: 'Works anywhere the device is signed in to your tailnet' },
  public: { label: 'Internet', icon: Globe, hint: 'Reachable from anywhere' },
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/admin/hub-addresses${path}`, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  const body = await r.json().catch(() => null)
  if (!r.ok) throw new Error((body as { error?: string })?.error ?? `Request failed (${r.status})`)
  return body as T
}

// ── Row ───────────────────────────────────────────────────────────────────────

interface RowProps {
  endpoint: HubEndpoint
  position: number
  active: boolean
  onSave: (patch: { name?: string; url?: string; kind?: EndpointKind; enabled?: boolean }) => Promise<void>
  onDelete: () => Promise<void>
}

function AddressRow({ endpoint, position, active, onSave, onDelete }: RowProps) {
  const managed = endpoint.source === 'managed'
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: endpoint.id, disabled: !managed })
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(endpoint.name)
  const [url, setUrl] = useState(endpoint.url)
  const [kind, setKind] = useState<EndpointKind>(endpoint.kind)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (editing) return
    setName(endpoint.name)
    setUrl(endpoint.url)
    setKind(endpoint.kind)
  }, [editing, endpoint.name, endpoint.url, endpoint.kind])

  const Icon = KIND_META[endpoint.kind].icon

  async function commit() {
    setBusy(true)
    try {
      await onSave({ name, url, kind })
      setEditing(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the address')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group flex items-center gap-3 rounded-control border border-border/60 bg-card/40 px-3 py-2.5 transition-colors',
        isDragging && 'relative z-10 shadow-lg',
        !endpoint.enabled && 'opacity-55',
      )}
    >
      {/* design-ok(hand-styled-button): drag grip, mirrors the Family Jam queue row */}
      <button
        type="button"
        {...attributes}
        {...listeners}
        disabled={!managed}
        className={cn(
          'grid size-7 shrink-0 place-items-center rounded-control text-muted-foreground/40 transition',
          managed ? 'cursor-grab hover:text-foreground active:cursor-grabbing' : 'cursor-default opacity-0',
        )}
        aria-label={`Reorder ${endpoint.name}`}
        title="Drag to reorder"
      >
        <GripVertical className="size-4" />
      </button>

      <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted-foreground">{position}</span>
      <Icon className="size-4 shrink-0 text-muted-foreground" />

      {editing ? (
        <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="sm:w-40" />
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="192.168.1.50:3000" className="flex-1" />
          {/* Where it works. Only a label the apps show next to the address, but a wrong
              one reads as a promise the address cannot keep, so it is editable. */}
          <div className="flex shrink-0 gap-1">
            {(Object.keys(KIND_META) as EndpointKind[]).map((k) => (
              <Button key={k} variant={kind === k ? 'secondary' : 'ghost'} size="sm"
                onClick={() => setKind(k)} title={KIND_META[k].hint}>
                {KIND_META[k].label}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium">{endpoint.name}</p>
            {active && (
              <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px] font-normal">
                you are here
              </Badge>
            )}
            {!managed && (
              <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px] font-normal">
                detected
              </Badge>
            )}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">{endpoint.url}</p>
        </div>
      )}

      {editing ? (
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={() => void commit()} disabled={busy} aria-label="Save">
            {busy ? <Spinner className="size-3.5" /> : <Check className="size-4" />}
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setEditing(false)} aria-label="Cancel">
            <X className="size-4" />
          </Button>
        </div>
      ) : managed ? (
        <div className="flex shrink-0 items-center gap-1">
          <Switch
            checked={endpoint.enabled}
            onCheckedChange={(v) => void onSave({ enabled: v }).catch(() => toast.error('Could not update the address'))}
            aria-label={`${endpoint.enabled ? 'Stop' : 'Start'} offering ${endpoint.name} to apps`}
          />
          <Button variant="ghost" size="icon-sm" onClick={() => setEditing(true)}
            className="opacity-0 transition group-hover:opacity-100" aria-label={`Edit ${endpoint.name}`}>
            <Pencil className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-sm"
            onClick={() => void onDelete().catch(() => toast.error('Could not remove the address'))}
            className="text-muted-foreground/60 opacity-0 transition hover:text-destructive group-hover:opacity-100"
            aria-label={`Remove ${endpoint.name}`}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground">{KIND_META[endpoint.kind].label}</span>
      )}
    </div>
  )
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export function HubAddressesPanel() {
  const [data, setData] = useState<AddressesPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [busy, setBusy] = useState(false)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const load = useCallback(async () => {
    try {
      setData(await api<AddressesPayload>(''))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not read the address list')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  function applyEndpoints(next: { endpoints: HubEndpoint[] }) {
    setData((prev) => (prev ? { ...prev, endpoints: next.endpoints } : prev))
  }

  async function add() {
    if (!newName.trim() || !newUrl.trim()) return
    setBusy(true)
    try {
      applyEndpoints(await api<{ endpoints: HubEndpoint[] }>('', {
        method: 'POST',
        body: JSON.stringify({ name: newName, url: newUrl }),
      }))
      setNewName('')
      setNewUrl('')
      setAdding(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add the address')
    } finally {
      setBusy(false)
    }
  }

  async function onDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id || !data) return
    const managed = data.endpoints.filter((e) => e.source === 'managed')
    const from = managed.findIndex((e) => e.id === active.id)
    const to = managed.findIndex((e) => e.id === over.id)
    if (from < 0 || to < 0) return

    // Optimistic: the list must not jump under the cursor while the PUT is in flight.
    const reordered = [...managed]
    const [moved] = reordered.splice(from, 1)
    reordered.splice(to, 0, moved)
    setData({ ...data, endpoints: [...reordered, ...data.endpoints.filter((e) => e.source === 'detected')] })

    try {
      applyEndpoints(await api<{ endpoints: HubEndpoint[] }>('/order', {
        method: 'PUT',
        body: JSON.stringify({ ids: reordered.map((e) => e.id) }),
      }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the new order')
      void load()
    }
  }

  if (loading) return <div className="flex justify-center py-10"><Spinner /></div>
  if (!data) return <div className="p-5 text-sm text-destructive">Could not read the address list.</div>

  const sortableIds = data.endpoints.filter((e) => e.source === 'managed').map((e) => e.id)

  return (
    <div className="space-y-4 p-5">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-xl text-sm text-muted-foreground">
          Every address your apps can use to reach this hub. They download this list, keep a copy
          for when they are offline, and try the addresses in this order until one answers.
          Drag to change the order.
        </p>
        <Button variant="ghost" size="icon-sm" onClick={() => void load()} aria-label="Refresh">
          <RefreshCw className="size-4" />
        </Button>
      </div>

      <div className="space-y-2">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => void onDragEnd(e)}>
          <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
            {data.endpoints.map((endpoint, i) => (
              <AddressRow
                key={endpoint.id}
                endpoint={endpoint}
                position={i + 1}
                active={endpoint.url === data.servedFrom}
                onSave={async (patch) => {
                  applyEndpoints(await api<{ endpoints: HubEndpoint[] }>(`/${endpoint.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify(patch),
                  }))
                }}
                onDelete={async () => {
                  applyEndpoints(await api<{ endpoints: HubEndpoint[] }>(`/${endpoint.id}`, { method: 'DELETE' }))
                }}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      {adding ? (
        <div className="flex flex-col gap-2 rounded-control border border-border/60 bg-card/40 p-3 sm:flex-row sm:items-center">
          <Input value={newName} onChange={(e) => setNewName(e.target.value)}
            placeholder="Name (Local DNS)" className="sm:w-48" autoFocus />
          <Input value={newUrl} onChange={(e) => setNewUrl(e.target.value)}
            placeholder="maipai.home.arpa:3000" className="flex-1"
            onKeyDown={(e) => { if (e.key === 'Enter') void add() }} />
          <div className="flex shrink-0 gap-2">
            <Button onClick={() => void add()} disabled={busy || !newName.trim() || !newUrl.trim()}>
              {busy ? <Spinner className="size-4" /> : 'Add'}
            </Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" onClick={() => setAdding(true)}>
          <Plus className="size-4" />
          Add an address
        </Button>
      )}

      <p className="text-xs text-muted-foreground">
        Apps check that each address really is this hub before they use it, so a stray device
        answering on the same IP somewhere else can never impersonate it.
      </p>
    </div>
  )
}
