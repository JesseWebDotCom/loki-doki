import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Loader2, Plus, Cpu, Copy, Check, Radio, Usb, Volume2, Settings2, Antenna,
  AlertTriangle, RefreshCw, ChevronLeft, LayoutGrid, Music2, Wifi,
  Monitor, Pointer, Camera, Clock, Trash2, Save, HelpCircle,
} from 'lucide-react'
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
import { DeviceArt } from '@/components/admin/DeviceArt'
import { DEVICE_MODELS, resolveDeviceModel, deviceModelName } from '@/lib/deviceCatalog'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/cn'

// Admin → Devices: physical ESP32 voice satellites. Three top-level tabs:
//   Devices  — fleet overview and per-device full-page detail
//   Layouts  — display and controller layout templates
//   Sounds   — sound packs, earcons, and centralised alarms

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
  activity: string
  hwid: string | null
  layoutTemplateId: string | null
}
interface UserRow { id: string; firstName: string; lastName: string; nickname: string }
interface Companion { id: string; name: string; wakeWordPhrase?: string | null; wakeWordModelId?: string | null }
interface Detector { id: string; label: string }
interface DiscoveredDevice { hwid: string; model: string | null; firstSeen: number }
interface TemplateRow { id: string; name: string; builtin: boolean }

type AdminTab = 'devices' | 'layouts' | 'sounds'
type LayoutSubTab = 'display' | 'controller'

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
    } catch { toast.error("Couldn't restart the gateway") } finally { setRestarting(false) }
  }

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
          Pods can't connect on port {data.port}{data.error ? ` — ${data.error}` : ''}. Voice, mode switching, and camera all need this. It self-heals, or restart it now.
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

// ── Testing mode constants (screen devices) ─────────────────────────────────────
const MODES = [
  { id: 'normal', label: 'Normal', desc: 'Ambient clock', icon: <Clock className="size-5" /> },
  { id: 'camera-test', label: 'Camera', desc: 'Live test feed', icon: <Camera className="size-5" /> },
  { id: 'touch-test', label: 'Touch', desc: 'Tap to draw', icon: <Pointer className="size-5" /> },
]
const MODE_LABEL: Record<string, string> = { normal: 'Normal', 'camera-test': 'Camera test', 'touch-test': 'Touch test', 'stream-deck': 'Controller' }
const SCREEN_KINDS = ['tablet', 'show']

// ── Main export ─────────────────────────────────────────────────────────────────
export function AdminDevicesTab() {
  const qc = useQueryClient()
  const { data: devices = [], isLoading } = useQuery({ queryKey: ['pod-devices'], queryFn: () => getJSON<DeviceRow[]>('/api/pod/devices'), refetchInterval: 2000 })
  const { data: users = [] } = useQuery({ queryKey: ['admin-users'], queryFn: () => getJSON<UserRow[]>('/api/users') })
  const { data: companions = [] } = useQuery({ queryKey: ['companions-list'], queryFn: () => getJSON<Companion[]>('/api/companions') })
  const { data: wakewords } = useQuery({ queryKey: ['wakewords-list'], queryFn: () => getJSON<{ detectors: Detector[] }>('/api/voice/wakewords') })
  const { data: discovered = [] } = useQuery({ queryKey: ['pod-discovered'], queryFn: () => getJSON<DiscoveredDevice[]>('/api/pod/discovered'), refetchInterval: 4000 })
  const { data: streamHealth } = useQuery({
    queryKey: ['pod-stream-health'],
    queryFn: () => getJSON<{ devices: StreamHealth[] }>('/api/pod/devices/stream-health'),
    refetchInterval: 2000,
  })
  const healthById = new Map((streamHealth?.devices ?? []).filter((h) => h.deviceId).map((h) => [h.deviceId as string, h]))

  const [activeTab, setActiveTab] = useState<AdminTab>('devices')
  const [layoutSubTab, setLayoutSubTab] = useState<LayoutSubTab>('display')
  const [selectedDevice, setSelectedDevice] = useState<DeviceRow | null>(null)

  // Keep selected device in sync with live poll data (status, activity).
  const selectedDeviceLive = selectedDevice ? devices.find((x) => x.id === selectedDevice.id) ?? selectedDevice : null

  const [flashOpen, setFlashOpen] = useState(false)
  const [reflashDevice, setReflashDevice] = useState<DeviceRow | null>(null)
  const [del, setDel] = useState<DeviceRow | null>(null)
  const [help, setHelp] = useState<DeviceRow | null>(null)

  // Manual pairing code form (Advanced section).
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

  // Full-page device detail view.
  if (activeTab === 'devices' && selectedDeviceLive) {
    return (
      <div className="flex flex-col">
        {/* Top navigation tabs remain visible */}
        <TabBar activeTab={activeTab} onChange={(t) => { setActiveTab(t); setSelectedDevice(null) }} />
        <DeviceDetailPage
          device={selectedDeviceLive}
          users={users}
          companions={companions}
          wakewords={wakewords?.detectors ?? []}
          onBack={() => setSelectedDevice(null)}
          onChanged={invalidate}
          onReflash={() => { setReflashDevice(selectedDeviceLive); setSelectedDevice(null); setFlashOpen(true) }}
          onHelp={() => { setHelp(selectedDeviceLive); setSelectedDevice(null) }}
          onDelete={() => { setDel(selectedDeviceLive); setSelectedDevice(null) }}
        />
        <FlashDeviceWizard
          open={flashOpen}
          onOpenChange={(o) => { setFlashOpen(o); if (!o) setReflashDevice(null) }}
          onFlashed={invalidate}
          reflash={reflashDevice ? { name: reflashDevice.name, model: reflashDevice.model } : null}
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

  return (
    <div className="flex flex-col">
      <TabBar activeTab={activeTab} onChange={setActiveTab} />

      {/* ── Devices tab ── */}
      {activeTab === 'devices' && (
        <div className="space-y-6 p-5">
          <div className="flex items-start gap-3">
            <DeviceTile gradient="linear-gradient(135deg,#a78bfa,#7c3aed)" className="size-10 rounded-xl">
              <Cpu className="size-5 text-white" />
            </DeviceTile>
            <div className="flex-1">
              <h2 className="text-base font-semibold">Devices</h2>
              <p className="text-sm text-muted-foreground">
                Your voice devices around the home. Add a new one and it'll show up here, ready in a couple of minutes.
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
                  <DeviceCard
                    key={d.id}
                    d={d}
                    userName={userName(d.userId)}
                    health={healthById.get(d.id)}
                    onManage={() => setSelectedDevice(d)}
                    onTest={async () => {
                      if (!d.online) { toast.error('Power on the device to test it'); return }
                      const r = await fetch(`/api/pod/devices/${d.id}/test`, { ...opts, method: 'POST', headers: J, body: '{}' })
                      if (r.ok) toast.success('Playing a test sound…')
                      else if (r.status === 409) toast.error("Device isn't connected right now")
                      else toast.error("Couldn't reach the device")
                    }}
                  />
                ))}
              </div>
            )}
          </section>

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
                For a device with a screen that can show/enter a code (e.g. Tab5). Most devices should use "Add a device" above instead.
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
      )}

      {/* ── Layouts tab ── */}
      {activeTab === 'layouts' && (
        <div className="space-y-0">
          {/* Layout sub-tab bar */}
          <div className="flex gap-1 border-b border-border/50 px-5 pt-4 pb-0">
            {(['display', 'controller'] as LayoutSubTab[]).map((sub) => (
              <button
                key={sub}
                onClick={() => setLayoutSubTab(sub)}
                className={cn(
                  'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
                  layoutSubTab === sub
                    ? 'border-brand text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {sub === 'display' ? 'Display' : 'Controller'}
              </button>
            ))}
          </div>
          <div className="p-5" id={layoutSubTab === 'display' ? 'devices-layouts-tab' : 'devices-controller-tab'}>
            {layoutSubTab === 'display' && (
              <DeviceLayoutsPanel id="devices-layouts" />
            )}
            {layoutSubTab === 'controller' && (
              <ControllerLayoutsPlaceholder />
            )}
          </div>
        </div>
      )}

      {/* ── Sounds tab ── */}
      {activeTab === 'sounds' && (
        <div className="space-y-6 p-5" id="devices-sounds-tab">
          <DeviceSoundsPanel id="devices-sounds" />
          <DeviceAlarmsPanel id="devices-alarms" />
        </div>
      )}
    </div>
  )
}

// ── Tab bar ──────────────────────────────────────────────────────────────────────

function TabBar({ activeTab, onChange }: { activeTab: AdminTab; onChange: (t: AdminTab) => void }) {
  const tabs: { id: AdminTab; label: string; icon: React.ReactNode }[] = [
    { id: 'devices', label: 'Devices', icon: <Cpu className="size-3.5" /> },
    { id: 'layouts', label: 'Layouts', icon: <LayoutGrid className="size-3.5" /> },
    { id: 'sounds', label: 'Sounds', icon: <Music2 className="size-3.5" /> },
  ]
  return (
    <div className="flex gap-1 border-b border-border/50 bg-card/30 px-5 pt-4 pb-0">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            'inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
            activeTab === t.id
              ? 'border-brand text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {t.icon} {t.label}
        </button>
      ))}
    </div>
  )
}

// ── Full-page device detail ───────────────────────────────────────────────────────

function DeviceDetailPage({
  device, users, companions, wakewords, onBack, onChanged, onReflash, onHelp, onDelete,
}: {
  device: DeviceRow
  users: UserRow[]
  companions: Companion[]
  wakewords: Detector[]
  onBack: () => void
  onChanged: () => void
  onReflash: () => void
  onHelp: () => void
  onDelete: () => void
}) {
  const art = resolveDeviceModel(device.model, device.kind)
  const isScreen = art.capabilities.includes('Touchscreen') || SCREEN_KINDS.includes(device.kind)

  // Identity form
  const [name, setName] = useState(device.name)
  const [userId, setUserId] = useState(device.userId)
  const [characterId, setCharacterId] = useState(device.characterId ?? '')
  const [wakeWord, setWakeWord] = useState(device.wakeWord ?? '')
  const [saving, setSaving] = useState(false)

  // Settings group
  const [groups, setGroups] = useState<{ id: string; name: string; isDefault: boolean }[]>([])
  const [groupId, setGroupId] = useState(device.groupId ?? 'default')

  // Screen mode
  const [mode, setMode] = useState('normal')
  const [modeBusy, setModeBusy] = useState(false)

  // Display layout template
  const [templates, setTemplates] = useState<TemplateRow[]>([])
  const [layoutTemplateId, setLayoutTemplateId] = useState(device.layoutTemplateId ?? '')
  const [layoutSaving, setLayoutSaving] = useState(false)

  // Test sound
  const [testing, setTesting] = useState(false)

  // Re-seed the form if the device changes.
  useEffect(() => {
    setName(device.name)
    setUserId(device.userId)
    setCharacterId(device.characterId ?? '')
    setWakeWord(device.wakeWord ?? '')
    setGroupId(device.groupId ?? 'default')
    setLayoutTemplateId(device.layoutTemplateId ?? '')
  }, [device.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch groups, mode, and templates on mount.
  useEffect(() => {
    fetch('/api/pod/groups', opts)
      .then((r) => (r.ok ? r.json() : []))
      .then((g) => setGroups(Array.isArray(g) ? g : []))
      .catch(() => setGroups([]))

    if (isScreen) {
      fetch(`/api/pod/devices/${device.id}/mode`, opts)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => setMode(d?.mode ?? 'normal'))
        .catch(() => setMode('normal'))
    }

    fetch('/api/pod/studio/templates', opts)
      .then((r) => (r.ok ? r.json() : []))
      .then((t) => setTemplates(Array.isArray(t) ? t : []))
      .catch(() => setTemplates([]))
  }, [device.id, isScreen]) // eslint-disable-line react-hooks/exhaustive-deps

  const dirty =
    name.trim() !== device.name ||
    userId !== device.userId ||
    characterId !== (device.characterId ?? '') ||
    wakeWord !== (device.wakeWord ?? '')

  const selectedCompanion = companions.find((c) => c.id === characterId)
  const companionPhrase = selectedCompanion?.wakeWordPhrase?.trim()
  const companionName = companions.find((c) => c.id === device.characterId)?.name

  const status = !device.paired
    ? { label: 'Needs setup', dot: 'bg-amber-500', cls: 'text-amber-600 dark:text-amber-400' }
    : !device.online
      ? { label: 'Offline', dot: 'bg-muted-foreground/50', cls: 'text-muted-foreground' }
      : ACTIVITY[device.activity] ?? ACTIVITY.idle

  async function save() {
    if (!name.trim()) { toast.error('Give your device a name'); return }
    setSaving(true)
    try {
      const r = await fetch(`/api/pod/devices/${device.id}`, {
        ...opts, method: 'PATCH', headers: J,
        body: JSON.stringify({ name: name.trim(), userId, characterId: characterId || null, wakeWord: wakeWord || null }),
      })
      if (!r.ok) throw new Error()
      toast.success('Saved')
      onChanged()
    } catch { toast.error("Couldn't save changes") } finally { setSaving(false) }
  }

  async function assignGroup(next: string) {
    setGroupId(next)
    try {
      const r = await fetch(`/api/pod/devices/${device.id}/group`, {
        ...opts, method: 'PUT', headers: J,
        body: JSON.stringify({ groupId: next === 'default' ? null : next }),
      })
      if (!r.ok) throw new Error()
      toast.success(device.online ? 'Group updated — settings sent to the device' : 'Group updated — will apply when the device is online')
      onChanged()
    } catch { toast.error("Couldn't change group") }
  }

  async function changeMode(next: string) {
    if (next === mode || modeBusy) return
    const prev = mode
    setMode(next)
    setModeBusy(true)
    try {
      const r = await fetch(`/api/pod/devices/${device.id}/mode`, { ...opts, method: 'POST', headers: J, body: JSON.stringify({ mode: next }) })
      if (!r.ok) throw new Error()
      const d = (await r.json()) as { online?: boolean }
      toast.success(d.online ? `Switched to ${MODE_LABEL[next]}` : `${MODE_LABEL[next]} set — applies when the device reconnects`)
    } catch { setMode(prev); toast.error("Couldn't switch mode") } finally { setModeBusy(false) }
  }

  async function saveLayout() {
    setLayoutSaving(true)
    try {
      const r = await fetch(`/api/pod/devices/${device.id}/layout`, {
        ...opts, method: 'PUT', headers: J,
        body: JSON.stringify({ templateId: layoutTemplateId || null }),
      })
      if (!r.ok) throw new Error()
      const d = (await r.json()) as { online?: boolean }
      toast.success(d.online ? 'Layout applied to device' : 'Layout saved — will apply when device is online')
      onChanged()
    } catch { toast.error("Couldn't save layout") } finally { setLayoutSaving(false) }
  }

  async function testSound() {
    if (!device.online) { toast.error('Power on the device to test it'); return }
    setTesting(true)
    try {
      const r = await fetch(`/api/pod/devices/${device.id}/test`, { ...opts, method: 'POST', headers: J, body: '{}' })
      if (r.ok) toast.success('Playing a test sound on your device…')
      else if (r.status === 409) toast.error("Device isn't connected right now")
      else throw new Error()
    } catch { toast.error("Couldn't reach the device") } finally { setTesting(false) }
  }

  const isController = mode === 'stream-deck'

  return (
    <div className="space-y-6 p-5">
      {/* Back + title bar */}
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          <ChevronLeft className="size-4" /> Back to Devices
        </button>
        <div className="flex flex-1 items-center gap-2 min-w-0">
          <DeviceArt resolved={art} solid className="size-8 rounded-xl" />
          <span className="truncate text-base font-semibold">{device.name}</span>
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium bg-muted ${status.cls}`}>
            <span className={`size-1.5 rounded-full ${status.dot} ${device.online && device.activity !== 'idle' ? 'animate-pulse' : ''}`} />
            {status.label}
          </span>
          {companionName && <span className="text-xs text-muted-foreground hidden sm:inline">· {companionName}</span>}
        </div>
        {/* Quick action buttons */}
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={onReflash}>
            <Wifi className="size-3.5" /> Reflash
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={testSound} disabled={testing || !device.online}>
            {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Volume2 className="size-3.5" />} Test Sound
          </Button>
          <Button size="sm" variant="ghost" className="gap-1.5 text-muted-foreground" onClick={onHelp}>
            <HelpCircle className="size-3.5" /> Help
          </Button>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ── Identity section ── */}
        <section className="space-y-1.5">
          <SectionLabel>Identity</SectionLabel>
          <div className="divide-y divide-border/40 overflow-hidden rounded-2xl border border-border/50 bg-card">
            <FieldRow label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 w-44 text-right text-sm" />
            </FieldRow>
            <FieldRow label="Owner">
              <DetailPicker value={userId} onChange={setUserId}>
                {users.map((u) => <option key={u.id} value={u.id}>{u.nickname?.trim() || `${u.firstName} ${u.lastName}`.trim()}</option>)}
              </DetailPicker>
            </FieldRow>
            <FieldRow label="Companion">
              <DetailPicker value={characterId} onChange={setCharacterId}>
                <option value="">None</option>
                {companions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </DetailPicker>
            </FieldRow>
            <FieldRow label="Wake word">
              <DetailPicker value={wakeWord} onChange={setWakeWord}>
                {companionPhrase
                  ? <option value="">{companionPhrase} — {selectedCompanion?.name}'s wake word</option>
                  : <option value="">App default (Hey Jarvis)</option>}
                <option value="hey_jarvis">Hey Jarvis — always reliable</option>
                {wakewords
                  .filter((d) => d.id !== 'hey_jarvis' && d.id !== selectedCompanion?.wakeWordModelId)
                  .map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              </DetailPicker>
            </FieldRow>
          </div>
          {dirty && (
            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="ghost" size="sm"
                onClick={() => { setName(device.name); setUserId(device.userId); setCharacterId(device.characterId ?? ''); setWakeWord(device.wakeWord ?? '') }}
              >
                Discard
              </Button>
              <Button size="sm" className="gap-1.5" onClick={save} disabled={saving}>
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} Save changes
              </Button>
            </div>
          )}
        </section>

        {/* ── Settings section ── */}
        <section className="space-y-1.5">
          <SectionLabel>Settings</SectionLabel>
          <div className="divide-y divide-border/40 overflow-hidden rounded-2xl border border-border/50 bg-card">
            <FieldRow label="Group">
              <DetailPicker value={groupId} onChange={assignGroup}>
                {groups.length === 0 && <option value="default">Default</option>}
                {groups.map((g) => <option key={g.id} value={g.isDefault ? 'default' : g.id}>{g.name}</option>)}
              </DetailPicker>
            </FieldRow>
          </div>
          <p className="px-1 text-[11px] text-muted-foreground">Changing the group deploys settings to the device immediately.</p>
        </section>

        {/* ── Display Layout section (screen devices only) ── */}
        {isScreen && (
          <section className="space-y-1.5">
            <SectionLabel>Display Layout</SectionLabel>
            <div className="divide-y divide-border/40 overflow-hidden rounded-2xl border border-border/50 bg-card">
              <FieldRow label="Template">
                <DetailPicker value={layoutTemplateId} onChange={setLayoutTemplateId}>
                  <option value="">Built-in default</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.builtin ? ' (built-in)' : ''}</option>)}
                </DetailPicker>
              </FieldRow>
            </div>
            {layoutTemplateId !== (device.layoutTemplateId ?? '') && (
              <div className="flex justify-end pt-1">
                <Button size="sm" className="gap-1.5" onClick={saveLayout} disabled={layoutSaving}>
                  {layoutSaving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} Apply layout
                </Button>
              </div>
            )}
          </section>
        )}

        {/* ── Mode section (screen devices only) ── */}
        {isScreen && (
          <section className="space-y-1.5">
            <SectionLabel>Mode</SectionLabel>
            <div className="overflow-hidden rounded-2xl border border-border/50 bg-card">
              {/* Display vs Controller toggle */}
              <div className="grid grid-cols-2 gap-2 p-3">
                <button
                  onClick={() => changeMode('normal')}
                  disabled={modeBusy}
                  className={cn(
                    'flex flex-col items-center gap-2 rounded-xl border p-4 text-center transition-colors disabled:opacity-60',
                    !isController ? 'border-brand bg-brand/10 text-brand' : 'border-border/50 hover:bg-muted/40',
                  )}
                >
                  <Monitor className="size-6" />
                  <div>
                    <p className="text-sm font-semibold">Display</p>
                    <p className="text-[10px] leading-tight text-muted-foreground">Ambient clock &amp; weather</p>
                  </div>
                </button>
                <button
                  onClick={() => changeMode('stream-deck')}
                  disabled={modeBusy}
                  className={cn(
                    'flex flex-col items-center gap-2 rounded-xl border p-4 text-center transition-colors disabled:opacity-60',
                    isController ? 'border-brand bg-brand/10 text-brand' : 'border-border/50 hover:bg-muted/40',
                  )}
                >
                  <LayoutGrid className="size-6" />
                  <div>
                    <p className="text-sm font-semibold">Controller</p>
                    <p className="text-[10px] leading-tight text-muted-foreground">Stream Deck button grid</p>
                  </div>
                </button>
              </div>

              {/* Testing sub-modes (Display only) */}
              {!isController && (
                <>
                  <div className="border-t border-border/40 px-4 pb-1 pt-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">Testing</p>
                  </div>
                  <div className="grid grid-cols-3 gap-2 px-3 pb-3">
                    {MODES.map((m) => {
                      const active = mode === m.id
                      return (
                        <button
                          key={m.id}
                          onClick={() => changeMode(m.id)}
                          disabled={modeBusy}
                          className={cn(
                            'flex flex-col items-center gap-1.5 rounded-xl border p-3 text-center transition-colors disabled:opacity-60',
                            active ? 'border-brand bg-brand/10 text-brand' : 'border-border/50 hover:bg-muted/40',
                          )}
                        >
                          {m.icon}
                          <span className="text-xs font-medium">{m.label}</span>
                          <span className="text-[10px] leading-tight text-muted-foreground">{m.desc}</span>
                        </button>
                      )
                    })}
                  </div>
                  <p className="px-4 pb-3 text-[11px] text-muted-foreground">
                    {device.online
                      ? 'Camera test streams a public feed (no Frigate needed). Touch test draws a pink dot wherever you press.'
                      : 'Device is offline — the chosen mode will apply when it reconnects.'}
                  </p>
                </>
              )}
            </div>
          </section>
        )}

        {/* ── Hardware section ── */}
        <section className="space-y-1.5">
          <SectionLabel>Hardware</SectionLabel>
          <div className="divide-y divide-border/40 overflow-hidden rounded-2xl border border-border/50 bg-card">
            <InfoRow label="Model" value={deviceModelName(device.model, device.kind)} />
            {device.hwid && <InfoRow label="HWID" value={<code className="font-mono text-xs">{device.hwid}</code>} />}
            <InfoRow label="Paired" value={device.paired ? 'Yes' : 'No — needs setup'} />
            {device.lastSeenAt && !device.online && (
              <InfoRow label="Last seen" value={new Date(device.lastSeenAt).toLocaleString()} />
            )}
          </div>
        </section>
      </div>

      {/* ── Danger zone ── */}
      <section className="space-y-1.5">
        <SectionLabel>Danger zone</SectionLabel>
        <div className="overflow-hidden rounded-2xl border border-destructive/20 bg-card">
          <button
            onClick={onDelete}
            className="flex w-full items-center gap-3 px-4 py-3 text-sm font-medium text-destructive transition-colors hover:bg-destructive/5"
          >
            <Trash2 className="size-4" /> Remove this device
          </button>
        </div>
        <p className="px-1 text-[11px] text-muted-foreground">This will unpair the device and revoke its token. It can be re-added at any time.</p>
      </section>
    </div>
  )
}

// ── Controller layouts placeholder ───────────────────────────────────────────────

function ControllerLayoutsPlaceholder() {
  return (
    <section className="space-y-4 rounded-3xl border border-border/40 bg-card p-5">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl" style={{ backgroundImage: 'linear-gradient(135deg,#60a5fa,#3b82f6)' }}>
          <LayoutGrid className="size-5 text-white" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold">Controller layouts</h3>
          <p className="text-sm text-muted-foreground">Button grid templates for Stream Deck mode. Assign them to screen devices from the device detail page.</p>
        </div>
      </div>
      <div className="rounded-2xl border border-dashed border-border/60 bg-background/40 px-6 py-10 text-center">
        <LayoutGrid className="mx-auto mb-2 size-8 text-muted-foreground/40" />
        <p className="text-sm font-medium text-muted-foreground">Controller layout editor coming soon</p>
        <p className="mt-1 text-xs text-muted-foreground/70">
          You can assign the built-in default controller layout to a screen device now from the device detail page.
        </p>
      </div>
    </section>
  )
}

// ── Device card (App-Store style) ──────────────────────────────────────────────

function DeviceCard({ d, userName, health, onManage, onTest }: { d: DeviceRow; userName: string; health?: StreamHealth; onManage: () => void; onTest: () => void }) {
  const art = resolveDeviceModel(d.model, d.kind)
  const expired = !!d.pairingExpiresAt && new Date(d.pairingExpiresAt).getTime() < Date.now()
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn() }
  const isScreen = art.capabilities.includes('Touchscreen') || SCREEN_KINDS.includes(d.kind)
  return (
    <div
      onClick={onManage}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onManage() }}
      className="group flex cursor-pointer flex-col gap-4 rounded-3xl border border-border/40 bg-card p-5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center gap-3.5">
        <DeviceArt resolved={art} solid className="size-12 rounded-2xl" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold leading-tight">{d.name}</p>
          <p className="truncate text-xs text-muted-foreground">{deviceModelName(d.model, d.kind)}</p>
        </div>
        <StatusBadge d={d} />
      </div>

      <div className="-mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>{userName}</span>
        {isScreen && (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px]">
            {d.kind === 'tablet' ? 'Display' : 'Screen'}
          </span>
        )}
        {!d.online && d.lastSeenAt ? <span>· seen {new Date(d.lastSeenAt).toLocaleDateString()}</span> : null}
      </div>

      {!d.paired && d.pairingCode && (
        <div className="flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-2" onClick={(e) => e.stopPropagation()}>
          <code className="font-mono text-base font-semibold tracking-widest">{d.pairingCode}</code>
          <CopyButton value={d.pairingCode} />
          <span className="ml-auto text-[10px] text-muted-foreground">{expired ? 'expired' : 'enter on device'}</span>
        </div>
      )}

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

// ── Unclaimed device card ────────────────────────────────────────────────────────

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
      toast.success("Device claimed — it's online now")
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

// ── Shared bits ─────────────────────────────────────────────────────────────────

function DeviceTile({ gradient, className, children }: { gradient: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`flex shrink-0 items-center justify-center shadow-md ${className ?? 'size-14 rounded-2xl'}`} style={{ backgroundImage: gradient }}>
      {children}
    </div>
  )
}

const ACTIVITY: Record<string, { label: string; dot: string; cls: string; pulse?: boolean }> = {
  idle: { label: 'Ready', dot: 'bg-emerald-500', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  listening: { label: 'Listening', dot: 'bg-green-500', cls: 'bg-green-500/15 text-green-600 dark:text-green-400', pulse: true },
  thinking: { label: 'Thinking', dot: 'bg-blue-500', cls: 'bg-blue-500/15 text-blue-600 dark:text-blue-400', pulse: true },
  talking: { label: 'Speaking', dot: 'bg-cyan-500', cls: 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400', pulse: true },
}

function StatusBadge({ d }: { d: DeviceRow }) {
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

// Used in device detail (right-aligned, compact).
function DetailPicker({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 max-w-[12rem] rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {children}
    </select>
  )
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-12 items-center gap-3 px-4 py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="ml-auto">{children}</div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-h-10 items-center gap-3 px-4 py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="ml-auto text-sm text-foreground">{value}</span>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">{children}</p>
}
