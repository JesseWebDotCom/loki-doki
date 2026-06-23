import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, Trash2, Cpu, Copy, RefreshCw, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { toast } from '@/lib/toast'

// Admin → Devices: create & manage physical Pods (ESP32 voice satellites). Creating
// a device mints a one-time PAIRING CODE the installer types into the Pod during
// BLE setup; the Pod redeems it (POST /api/pod/pair) for a long-lived token.

interface DeviceRow {
  id: string
  userId: string
  characterId: string | null
  name: string
  kind: string
  wakeWord: string | null
  pairingCode: string | null
  pairingExpiresAt: string | null
  lastSeenAt: string | null
  createdAt: string
  paired: boolean
}
interface UserRow { id: string; firstName: string; lastName: string; nickname: string }
interface Companion { id: string; name: string }
interface Detector { id: string; label: string }

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }
const KINDS = ['dot', 'show', 'watch', 'tablet', 'pod'] as const

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, opts)
  if (!r.ok) throw new Error(`Failed to load ${url}`)
  return r.json() as Promise<T>
}

export function AdminDevicesTab() {
  const qc = useQueryClient()
  const { data: devices = [], isLoading } = useQuery({ queryKey: ['pod-devices'], queryFn: () => getJSON<DeviceRow[]>('/api/pod/devices') })
  const { data: users = [] } = useQuery({ queryKey: ['admin-users'], queryFn: () => getJSON<UserRow[]>('/api/users') })
  const { data: companions = [] } = useQuery({ queryKey: ['companions-list'], queryFn: () => getJSON<Companion[]>('/api/companions') })
  const { data: wakewords } = useQuery({ queryKey: ['wakewords-list'], queryFn: () => getJSON<{ detectors: Detector[] }>('/api/voice/wakewords') })

  const [name, setName] = useState('')
  const [kind, setKind] = useState<string>('dot')
  const [userId, setUserId] = useState('')
  const [characterId, setCharacterId] = useState('')
  const [wakeWord, setWakeWord] = useState('')
  const [busy, setBusy] = useState(false)
  const [del, setDel] = useState<DeviceRow | null>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['pod-devices'] })
  const userName = (id: string) => {
    const u = users.find((x) => x.id === id)
    return u ? (u.nickname?.trim() || `${u.firstName} ${u.lastName}`.trim()) : id
  }

  async function createDevice() {
    if (!name.trim() || !userId) { toast.error('Name and user are required'); return }
    setBusy(true)
    try {
      const r = await fetch('/api/pod/devices', {
        ...opts, method: 'POST', headers: J,
        body: JSON.stringify({ name: name.trim(), kind, userId, characterId: characterId || null, wakeWord: wakeWord || null }),
      })
      if (!r.ok) throw new Error('Failed')
      toast.success('Device created — share its pairing code')
      setName(''); setCharacterId(''); setWakeWord(''); invalidate()
    } catch { toast.error('Failed to create device') } finally { setBusy(false) }
  }

  async function reissue(d: DeviceRow) {
    const r = await fetch(`/api/pod/devices/${d.id}/pair-code`, { ...opts, method: 'POST', headers: J })
    if (r.ok) { toast.success('New pairing code issued'); invalidate() } else toast.error('Failed to issue code')
  }

  return (
    <div className="space-y-5 p-5">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-muted p-2"><Cpu className="size-5 text-muted-foreground" /></div>
        <div className="flex-1">
          <h2 className="text-base font-semibold">Devices</h2>
          <p className="text-sm text-muted-foreground">
            Physical Pods (ESP32 voice satellites). Create a device to get a one-time pairing
            code — enter it on the Pod during setup to bind it to a user and companion.
          </p>
        </div>
      </div>

      {/* Create form */}
      <div className="grid max-w-3xl gap-2 rounded-lg border bg-card p-4 sm:grid-cols-2">
        <Input placeholder="Device name (e.g. Kitchen Dot)" value={name} onChange={(e) => setName(e.target.value)} />
        <Select value={kind} onChange={setKind}>
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </Select>
        <Select value={userId} onChange={setUserId}>
          <option value="">Bind to user…</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.nickname?.trim() || `${u.firstName} ${u.lastName}`.trim()}</option>)}
        </Select>
        <Select value={characterId} onChange={setCharacterId}>
          <option value="">Companion (optional)</option>
          {companions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select value={wakeWord} onChange={setWakeWord}>
          <option value="">Wake word (app default)</option>
          {(wakewords?.detectors ?? []).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </Select>
        <Button onClick={createDevice} disabled={busy || !name.trim() || !userId}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <><Plus className="size-4" /> Create</>}
        </Button>
      </div>

      {isLoading && <div className="py-10 text-center"><Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" /></div>}
      {!isLoading && devices.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No devices yet.</p>}

      <div className="space-y-3">
        {devices.map((d) => (
          <DeviceCard key={d.id} d={d} userName={userName(d.userId)} onReissue={() => reissue(d)} onDelete={() => setDel(d)} />
        ))}
      </div>

      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => { if (!o) setDel(null) }}
        title="Remove this device?"
        description={del ? `"${del.name}" will be unpaired and its token revoked. The Pod will need to be paired again.` : undefined}
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (del) {
            const r = await fetch(`/api/pod/devices/${del.id}`, { ...opts, method: 'DELETE' })
            if (r.ok) { toast.success('Device removed'); invalidate() } else toast.error('Failed to remove')
          }
          setDel(null)
        }}
      />
    </div>
  )
}

function DeviceCard({ d, userName, onReissue, onDelete }: { d: DeviceRow; userName: string; onReissue: () => void; onDelete: () => void }) {
  const expired = !!d.pairingExpiresAt && new Date(d.pairingExpiresAt).getTime() < Date.now()
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium">{d.name}</h3>
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs uppercase text-muted-foreground">{d.kind}</span>
            {d.paired
              ? <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-600 dark:text-emerald-400">paired</span>
              : <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-600 dark:text-amber-400">awaiting pairing</span>}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            User: {userName}
            {d.wakeWord ? ` · Wake: ${d.wakeWord}` : ''}
            {d.lastSeenAt ? ` · Last seen ${new Date(d.lastSeenAt).toLocaleString()}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" onClick={onReissue} aria-label="Issue new pairing code" title="New pairing code">
            <RefreshCw className="size-4" />
          </Button>
          <Button size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-destructive" onClick={onDelete} aria-label="Remove device">
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      {!d.paired && d.pairingCode && (
        <div className="mt-3 flex items-center gap-3 rounded-md bg-muted/60 px-3 py-2">
          <span className="text-xs text-muted-foreground">Pairing code</span>
          <code className="font-mono text-lg font-semibold tracking-widest">{d.pairingCode}</code>
          <CopyButton value={d.pairingCode} />
          <span className="ml-auto text-xs text-muted-foreground">
            {expired ? 'expired — issue a new one' : 'enter this on the Pod'}
          </span>
        </div>
      )}
    </div>
  )
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="icon" variant="ghost" className="size-6"
      aria-label="Copy pairing code"
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { toast.error('Copy failed') }
      }}
    >
      {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
    </Button>
  )
}

function Select({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {children}
    </select>
  )
}
