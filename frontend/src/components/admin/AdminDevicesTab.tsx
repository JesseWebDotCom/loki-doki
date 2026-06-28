import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, Cpu, Copy, Check, Radio, Usb, Volume2, Settings2, Antenna, AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { FlashDeviceWizard } from '@/components/admin/FlashDeviceWizard'
import { DeviceGroupsPanel } from '@/components/admin/DeviceGroupsPanel'
import { DeviceCameraTestCard } from '@/components/admin/DeviceCameraTestCard'
import { DeviceLayoutsPanel } from '@/components/admin/DeviceLayoutsPanel'
import { DeviceSoundsPanel } from '@/components/admin/DeviceSoundsPanel'
import { DeviceAlarmsPanel } from '@/components/admin/DeviceAlarmsPanel'
import { DeviceHelpDialog } from '@/components/admin/DeviceHelpDialog'
import { DeviceManageSheet } from '@/components/admin/DeviceManageSheet'
import { DeviceArt } from '@/components/admin/DeviceArt'
import { DEVICE_MODELS, resolveDeviceModel, deviceModelName } from '@/lib/deviceCatalog'
import { toast } from '@/lib/toast'

// Admin → Devices: physical ESP32 voice satellites. Flash new hardware over USB
// (FlashDeviceWizard), claim devices that announce themselves, and manage the fleet
// as App-Store-style cards. The legacy "create with pairing code" path lives under
// an Advanced section for screened devices (e.g. Tab5) that can type a code.

interface DeviceRow {
  id: string
  userId: string
  characterId: string | null
  name: string
  kind: string
  model: string | null
  wakeWord: string | null
  groupId: string | null
  pairingCode: string | null
  pairingExpiresAt: string | null
  lastSeenAt: string | null
  createdAt: string
  paired: boolean
  online: boolean
  activity: string  // live conversation state: idle | listening | thinking | talking
}
interface UserRow { id: string; firstName: string; lastName: string; nickname: string }
interface Companion { id: string; name: string; wakeWordPhrase?: string | null; wakeWordModelId?: string | null }
interface Detector { id: string; label: string }
interface DiscoveredDevice { hwid: string; model: string | null; firstSeen: number }

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, opts)
  if (!r.ok) throw new Error(`Failed to load ${url}`)
  return r.json() as Promise<T>
}

interface StreamHealth {
  mac: string; addr: string; name: string | null; deviceId: string | null
  sourceFps: number; sentFps: number; receivedFps: number; decodedFps: number
  lossPct: number; lastBytes: number; ageMs: number; status: 'ok' | 'warn' | 'bad'
}

interface GatewayStatus { enabled: boolean; listening: boolean; port: number; error: string; connections: number }

// Wyoming gateway health banner. The gateway is the TCP listener every Pod connects
// to; if it's down (e.g. a `bun --hot` reload dropped the listener), devices silently
// can't connect — so make it visible and one-click restartable.
function GatewayBanner() {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['pod-gateway-status'],
    queryFn: () => getJSON<GatewayStatus>('/api/pod/gateway/status'),
    refetchInterval: 4000,
  })
  const [restarting, setRestarting] = useState(false)
  if (!data || !data.enabled) return null
  const up = data.listening

  async function restart() {
    setRestarting(true)
    try {
      const r = await fetch('/api/pod/gateway/restart', { ...opts, method: 'POST', headers: J, body: '{}' })
      if (!r.ok) throw new Error()
      toast.success('Gateway restarted')
      qc.invalidateQueries({ queryKey: ['pod-gateway-status'] })
    } catch { toast.error('Couldn’t restart the gateway') } finally { setRestarting(false) }
  }

  // Healthy: a quiet one-line confirmation. Down: a loud, actionable error.
  if (up) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border/50 bg-card px-3 py-2 text-xs text-muted-foreground">
        <Antenna className="size-4 text-green-500" />
        <span className="font-medium text-foreground">Device gateway online</span>
        <span>· port {data.port} · {data.connections} connected</span>
        <button onClick={restart} disabled={restarting} className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
          {restarting ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Restart
        </button>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3">
      <AlertTriangle className="size-5 shrink-0 text-red-500" />
      <div className="min-w-0 text-sm">
        <p className="font-semibold text-red-600 dark:text-red-400">Device gateway is down</p>
        <p className="text-xs text-muted-foreground">
          Pods can’t connect on port {data.port}{data.error ? ` — ${data.error}` : ''}. Voice, mode switching, and camera all need this. It self-heals, or restart it now.
        </p>
      </div>
      <Button size="sm" variant="destructive" className="ml-auto gap-1.5" onClick={restart} disabled={restarting}>
        {restarting ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Restart gateway
      </Button>
    </div>
  )
}

const healthTone = (s: string) => s === 'ok'
  ? 'text-green-600 dark:text-green-400 bg-green-500/15'
  : s === 'warn' ? 'text-amber-600 dark:text-amber-400 bg-amber-500/15'
    : 'text-red-600 dark:text-red-400 bg-red-500/15'
const healthLabel = (s: string) => s === 'ok' ? 'Healthy' : s === 'warn' ? 'Lossy' : 'Poor signal'

// Compact per-device camera pipeline (source→sent→received→decoded + loss%), shown inside
// each device card when that Pod is actively streaming video. loss% is the health signal
// (it tracks Wi-Fi/RF); frame rate follows the camera's own source rate.
function StreamHealthInline({ h }: { h: StreamHealth }) {
  return (
    <div className="rounded-xl bg-muted/40 px-3 py-2" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">Camera stream</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${healthTone(h.status)}`}>
          {healthLabel(h.status)} · {h.lossPct}% loss
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-1">
        <Stat label="source" v={h.sourceFps} />
        <Arrow />
        <Stat label="sent" v={h.sentFps} />
        <Arrow />
        <Stat label="recv" v={h.receivedFps} />
        <Arrow />
        <Stat label="decoded" v={h.decodedFps} highlight />
        <span className="ml-auto text-[10px] text-muted-foreground">{Math.round(h.lastBytes / 1024)} KB</span>
      </div>
    </div>
  )
}

function Stat({ label, v, highlight }: { label: string; v: number; highlight?: boolean }) {
  return (
    <div className="flex flex-col items-center">
      <span className={`font-mono text-sm ${highlight ? 'text-foreground font-semibold' : 'text-foreground/80'}`}>{v}</span>
      <span className="text-[10px]">{label}</span>
    </div>
  )
}
function Arrow() { return <span className="text-muted-foreground/50">→</span> }

export function AdminDevicesTab() {
  const qc = useQueryClient()
  // Poll briskly so the live activity badge (listening/thinking/speaking) tracks a
  // conversation in near-real-time — those states only last a couple of seconds each.
  const { data: devices = [], isLoading } = useQuery({ queryKey: ['pod-devices'], queryFn: () => getJSON<DeviceRow[]>('/api/pod/devices'), refetchInterval: 2000 })
  const { data: users = [] } = useQuery({ queryKey: ['admin-users'], queryFn: () => getJSON<UserRow[]>('/api/users') })
  const { data: companions = [] } = useQuery({ queryKey: ['companions-list'], queryFn: () => getJSON<Companion[]>('/api/companions') })
  const { data: wakewords } = useQuery({ queryKey: ['wakewords-list'], queryFn: () => getJSON<{ detectors: Detector[] }>('/api/voice/wakewords') })
  const { data: discovered = [] } = useQuery({ queryKey: ['pod-discovered'], queryFn: () => getJSON<DiscoveredDevice[]>('/api/pod/discovered'), refetchInterval: 4000 })
  // Live camera stream health, keyed by device id (shown inside each card while streaming).
  const { data: streamHealth } = useQuery({
    queryKey: ['pod-stream-health'],
    queryFn: () => getJSON<{ devices: StreamHealth[] }>('/api/pod/devices/stream-health'),
    refetchInterval: 2000,
  })
  const healthById = new Map((streamHealth?.devices ?? []).filter((h) => h.deviceId).map((h) => [h.deviceId as string, h]))

  const [flashOpen, setFlashOpen] = useState(false)
  // When set, the wizard runs in streamlined "reinstall" mode for this existing
  // device (skips detection / Wi-Fi / naming — it's already known and configured).
  const [reflashDevice, setReflashDevice] = useState<DeviceRow | null>(null)
  const [del, setDel] = useState<DeviceRow | null>(null)
  const [help, setHelp] = useState<DeviceRow | null>(null)
  const [manage, setManage] = useState<DeviceRow | null>(null)
  // Keep the open manage sheet in sync with fresh poll data (live status/activity).
  const managed = manage ? devices.find((x) => x.id === manage.id) ?? manage : null

  // Manual "create with pairing code" form (Advanced).
  const [name, setName] = useState('')
  const [deviceType, setDeviceType] = useState<string>('atom-echo')
  const [userId, setUserId] = useState('')
  const [characterId, setCharacterId] = useState('')
  const [wakeWord, setWakeWord] = useState('')
  const [busy, setBusy] = useState(false)

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['pod-devices'] })
    qc.invalidateQueries({ queryKey: ['pod-discovered'] })
  }
  const userName = (id: string) => {
    const u = users.find((x) => x.id === id)
    return u ? (u.nickname?.trim() || `${u.firstName} ${u.lastName}`.trim()) : id
  }

  async function createDevice() {
    if (!name.trim() || !userId) { toast.error('Name and user are required'); return }
    setBusy(true)
    try {
      const kind = DEVICE_MODELS.find((m) => m.id === deviceType)?.kind ?? 'pod'
      const r = await fetch('/api/pod/devices', {
        ...opts, method: 'POST', headers: J,
        body: JSON.stringify({ name: name.trim(), kind, model: deviceType, userId, characterId: characterId || null, wakeWord: wakeWord || null }),
      })
      if (!r.ok) throw new Error('Failed')
      toast.success('Device created — share its pairing code')
      setName(''); setCharacterId(''); setWakeWord(''); invalidate()
    } catch { toast.error('Failed to create device') } finally { setBusy(false) }
  }

  async function testDevice(d: DeviceRow) {
    if (!d.online) { toast.error('Power on the device to test it'); return }
    const r = await fetch(`/api/pod/devices/${d.id}/test`, { ...opts, method: 'POST', headers: J, body: '{}' })
    if (r.ok) toast.success('Playing a test sound…')
    else if (r.status === 409) toast.error('Device isn’t connected right now')
    else toast.error('Couldn’t reach the device')
  }

  return (
    <div className="space-y-6 p-5">
      {/* Header */}
      <div className="flex items-start gap-3">
        <DeviceTile gradient="linear-gradient(135deg,#a78bfa,#7c3aed)" className="size-10 rounded-xl">
          <Cpu className="size-5 text-white" />
        </DeviceTile>
        <div className="flex-1">
          <h2 className="text-base font-semibold">Devices</h2>
          <p className="text-sm text-muted-foreground">
            Your voice devices around the home. Add a new one and it’ll show up here, ready in a couple of minutes.
          </p>
        </div>
        <Button onClick={() => { setReflashDevice(null); setFlashOpen(true) }}><Plus className="size-4" /> Add a device</Button>
      </div>

      <GatewayBanner />

      <FlashDeviceWizard
        open={flashOpen}
        onOpenChange={(o) => { setFlashOpen(o); if (!o) setReflashDevice(null) }}
        onFlashed={invalidate}
        reflash={reflashDevice ? { name: reflashDevice.name, model: reflashDevice.model } : null}
      />

      {/* Unclaimed devices — powered-on satellites not bound to anyone yet */}
      {discovered.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Radio className="size-4 text-amber-500" />
            <h3 className="text-sm font-semibold">Ready to set up</h3>
            <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">{discovered.length}</span>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {discovered.map((d) => (
              <UnclaimedCard key={d.hwid} d={d} users={users} companions={companions} onClaimed={invalidate} />
            ))}
          </div>
        </section>
      )}

      {/* Your devices */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Your devices</h3>
        {isLoading ? (
          <div className="py-10 text-center"><Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" /></div>
        ) : devices.length === 0 ? (
          <button
            onClick={() => { setReflashDevice(null); setFlashOpen(true) }}
            className="flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border/60 bg-card/40 p-10 text-center text-muted-foreground transition-colors hover:border-brand/40 hover:text-foreground"
          >
            <Usb className="size-6" />
            <span className="text-sm font-medium">No devices yet — add your first one</span>
          </button>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {devices.map((d) => (
              <DeviceCard key={d.id} d={d} userName={userName(d.userId)} health={healthById.get(d.id)} onManage={() => setManage(d)} onTest={() => testDevice(d)} />
            ))}
          </div>
        )}
      </section>

      {/* Slot-based dashboard (the unified ambient-display system): named layouts,
          sound packs/chimes, centralised alarms. */}
      <DeviceLayoutsPanel id="devices-layouts" />
      <DeviceSoundsPanel id="devices-sounds" />
      <DeviceAlarmsPanel id="devices-alarms" />

      {/* Server-drives-the-screen camera test */}
      <DeviceCameraTestCard />

      {/* Central settings, grouped (dimming, …) — deployed live over the gateway */}
      <DeviceGroupsPanel />

      {/* Advanced: manual create with a pairing code (for screened devices like the Tab5) */}
      <details className="max-w-2xl rounded-2xl border border-border/40 bg-card/40">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-muted-foreground hover:text-foreground">
          Add manually with a pairing code
        </summary>
        <div className="space-y-2 border-t border-border/40 p-4">
          <p className="text-xs text-muted-foreground">
            For a device with a screen that can show/enter a code (e.g. Tab5). Most devices should use “Add a device” above instead.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input placeholder="Device name (e.g. Living Room Tab)" value={name} onChange={(e) => setName(e.target.value)} />
            <Select value={deviceType} onChange={setDeviceType}>
              {DEVICE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.make} {m.model}</option>)}
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
        </div>
      </details>

      <DeviceManageSheet
        device={managed}
        users={users}
        companions={companions}
        wakewords={wakewords?.detectors ?? []}
        onOpenChange={(o) => { if (!o) setManage(null) }}
        onChanged={invalidate}
        onReflash={() => { setReflashDevice(managed); setManage(null); setFlashOpen(true) }}
        onHelp={() => { if (managed) setHelp(managed) }}
        onDelete={() => { if (managed) setDel(managed); setManage(null) }}
      />

      <DeviceHelpDialog device={help} onOpenChange={(o) => { if (!o) setHelp(null) }} />

      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => { if (!o) setDel(null) }}
        title="Remove this device?"
        description={del ? `"${del.name}" will be unpaired and its token revoked. The device will need to be added again.` : undefined}
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

// ── Device card (App-Store style) ──────────────────────────────────────────────

function DeviceCard({ d, userName, health, onManage, onTest }: { d: DeviceRow; userName: string; health?: StreamHealth; onManage: () => void; onTest: () => void }) {
  const art = resolveDeviceModel(d.model, d.kind)
  const expired = !!d.pairingExpiresAt && new Date(d.pairingExpiresAt).getTime() < Date.now()
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn() }
  return (
    <div
      onClick={onManage}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onManage() }}
      className="group flex cursor-pointer flex-col gap-4 rounded-3xl border border-border/40 bg-card p-5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center gap-3.5">
        {/* Color-coded by device type, App-Store style. */}
        <DeviceArt resolved={art} solid className="size-12 rounded-2xl" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold leading-tight">{d.name}</p>
          <p className="truncate text-xs text-muted-foreground">{deviceModelName(d.model, d.kind)}</p>
        </div>
        <StatusBadge d={d} />
      </div>

      <div className="-mt-1 text-xs text-muted-foreground">
        {userName}
        {!d.online && d.lastSeenAt ? ` · seen ${new Date(d.lastSeenAt).toLocaleDateString()}` : ''}
      </div>

      {/* Pairing code (only for manually-created devices that show/enter a code) */}
      {!d.paired && d.pairingCode && (
        <div className="flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-2" onClick={(e) => e.stopPropagation()}>
          <code className="font-mono text-base font-semibold tracking-widest">{d.pairingCode}</code>
          <CopyButton value={d.pairingCode} />
          <span className="ml-auto text-[10px] text-muted-foreground">{expired ? 'expired' : 'enter on device'}</span>
        </div>
      )}

      {/* Live camera stream health (only while this Pod is streaming video) */}
      {health && <StreamHealthInline h={health} />}

      <div className="mt-auto flex items-center gap-2">
        <Button size="sm" variant="secondary" className="h-9 flex-1 gap-1.5 rounded-xl text-xs" onClick={stop(onTest)} disabled={!d.online}>
          <Volume2 className="size-3.5" /> Test
        </Button>
        <Button size="sm" variant="ghost" className="h-9 gap-1.5 rounded-xl px-3 text-xs text-muted-foreground hover:text-foreground" onClick={stop(onManage)}>
          <Settings2 className="size-3.5" /> Manage
        </Button>
      </div>
    </div>
  )
}

// ── Unclaimed device card (self-contained claim) ───────────────────────────────

function UnclaimedCard({ d, users, companions, onClaimed }: { d: DiscoveredDevice; users: UserRow[]; companions: Companion[]; onClaimed: () => void }) {
  const art = resolveDeviceModel(d.model, null)
  const [expanded, setExpanded] = useState(false)
  const [name, setName] = useState(deviceModelName(d.model, null))
  const [userId, setUserId] = useState(users[0]?.id ?? '')
  const [characterId, setCharacterId] = useState('')
  const [busy, setBusy] = useState(false)

  async function claim() {
    if (!name.trim() || !userId) { toast.error('Name and user are required'); return }
    setBusy(true)
    try {
      const r = await fetch('/api/pod/devices/claim', {
        ...opts, method: 'POST', headers: J,
        body: JSON.stringify({ hwid: d.hwid, model: d.model, name: name.trim(), userId, characterId: characterId || null }),
      })
      if (!r.ok) throw new Error('Failed')
      toast.success('Device claimed — it’s online now')
      onClaimed()
    } catch { toast.error('Failed to claim device') } finally { setBusy(false) }
  }

  return (
    <div className="flex flex-col gap-4 rounded-3xl border border-amber-500/30 bg-amber-500/5 p-5">
      <div className="flex items-center gap-3.5">
        <DeviceArt resolved={art} solid className="size-12 rounded-2xl" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold leading-tight">{deviceModelName(d.model, null)}</p>
          <p className="text-xs text-muted-foreground">Ready to set up</p>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
          <span className="size-1.5 animate-pulse rounded-full bg-amber-500" /> New
        </span>
      </div>

      {!expanded ? (
        <Button className="mt-auto w-full" onClick={() => setExpanded(true)}>Claim</Button>
      ) : (
        <div className="space-y-2">
          <Input placeholder="Device name" value={name} onChange={(e) => setName(e.target.value)} />
          <Select value={userId} onChange={setUserId}>
            <option value="">Assign to user…</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.nickname?.trim() || `${u.firstName} ${u.lastName}`.trim()}</option>)}
          </Select>
          <Select value={characterId} onChange={setCharacterId}>
            <option value="">Companion (optional)</option>
            {companions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <div className="flex gap-2">
            <Button className="flex-1" onClick={claim} disabled={busy || !name.trim() || !userId}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <><Check className="size-4" /> Claim</>}
            </Button>
            <Button variant="ghost" onClick={() => setExpanded(false)} disabled={busy}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── shared bits ────────────────────────────────────────────────────────────────

function DeviceTile({ gradient, className, children }: { gradient: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`flex shrink-0 items-center justify-center shadow-md ${className ?? 'size-14 rounded-2xl'}`} style={{ backgroundImage: gradient }}>
      {children}
    </div>
  )
}

// Live conversation states (when a device is online). Colours mirror the device's
// own status LED legend: green listening · blue thinking · cyan speaking.
const ACTIVITY: Record<string, { label: string; dot: string; cls: string; pulse?: boolean }> = {
  idle: { label: 'Ready', dot: 'bg-emerald-500', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  listening: { label: 'Listening', dot: 'bg-green-500', cls: 'bg-green-500/15 text-green-600 dark:text-green-400', pulse: true },
  thinking: { label: 'Thinking', dot: 'bg-blue-500', cls: 'bg-blue-500/15 text-blue-600 dark:text-blue-400', pulse: true },
  talking: { label: 'Speaking', dot: 'bg-cyan-500', cls: 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400', pulse: true },
}

function StatusBadge({ d }: { d: DeviceRow }) {
  // Needs setup (not paired) → amber · Offline → grey · Online → live conversation
  // state (Ready when idle, else Listening/Thinking/Speaking with a pulsing dot).
  const s = !d.paired
    ? { label: 'Needs setup', dot: 'bg-amber-500', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', pulse: false }
    : !d.online
      ? { label: 'Offline', dot: 'bg-muted-foreground/50', cls: 'bg-muted text-muted-foreground', pulse: false }
      : ACTIVITY[d.activity] ?? ACTIVITY.idle
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${s.cls}`}>
      <span className={`size-1.5 rounded-full ${s.dot} ${'pulse' in s && s.pulse ? 'animate-pulse' : ''}`} />
      {s.label}
    </span>
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
