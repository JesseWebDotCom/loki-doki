import { useEffect, useState } from 'react'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DeviceArt } from '@/components/admin/DeviceArt'
import { resolveDeviceModel, deviceModelName } from '@/lib/deviceCatalog'
import { Volume2, Wifi, RefreshCw, Trash2, ChevronRight, Loader2, HelpCircle } from 'lucide-react'
import { toast } from '@/lib/toast'

// Apple-style slide-over for managing one device: a big Test button up top, grouped
// settings (name / owner / companion / wake word), network + firmware actions, and a
// danger zone. Edits batch into a single Save (PATCH /api/pod/devices/:id).

export interface ManagedDevice {
  id: string
  userId: string
  characterId: string | null
  name: string
  kind: string
  model: string | null
  wakeWord: string | null
  groupId: string | null
  paired: boolean
  online: boolean
  activity: string
}
interface UserRow { id: string; firstName: string; lastName: string; nickname: string }
interface Companion { id: string; name: string; wakeWordPhrase?: string | null; wakeWordModelId?: string | null }
interface Detector { id: string; label: string }

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }

const ACTIVITY: Record<string, { label: string; cls: string; dot: string; pulse?: boolean }> = {
  idle: { label: 'Ready', cls: 'text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-500' },
  listening: { label: 'Listening', cls: 'text-green-600 dark:text-green-400', dot: 'bg-green-500', pulse: true },
  thinking: { label: 'Thinking', cls: 'text-blue-600 dark:text-blue-400', dot: 'bg-blue-500', pulse: true },
  talking: { label: 'Speaking', cls: 'text-cyan-600 dark:text-cyan-400', dot: 'bg-cyan-500', pulse: true },
}

export function DeviceManageSheet({
  device, users, companions, wakewords, onOpenChange, onChanged, onReflash, onHelp, onDelete,
}: {
  device: ManagedDevice | null
  users: UserRow[]
  companions: Companion[]
  wakewords: Detector[]
  onOpenChange: (o: boolean) => void
  onChanged: () => void
  onReflash: () => void
  onHelp: () => void
  onDelete: () => void
}) {
  const [name, setName] = useState('')
  const [userId, setUserId] = useState('')
  const [characterId, setCharacterId] = useState('')
  const [wakeWord, setWakeWord] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [wifiSsid, setWifiSsid] = useState<string | null>(null)
  const [groups, setGroups] = useState<{ id: string; name: string; isDefault: boolean }[]>([])
  const [groupId, setGroupId] = useState('default')

  // Re-seed the form whenever a different device opens.
  useEffect(() => {
    if (!device) return
    setName(device.name)
    setUserId(device.userId)
    setCharacterId(device.characterId ?? '')
    setWakeWord(device.wakeWord ?? '')
    setGroupId(device.groupId ?? 'default')
    fetch('/api/pod/firmware/wifi', opts)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setWifiSsid(d?.ssid ?? null))
      .catch(() => setWifiSsid(null))
    fetch('/api/pod/groups', opts)
      .then((r) => (r.ok ? r.json() : []))
      .then((g) => setGroups(Array.isArray(g) ? g : []))
      .catch(() => setGroups([]))
  }, [device?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Group assignment deploys immediately (it changes the device's effective settings).
  async function assignGroup(next: string) {
    setGroupId(next)
    try {
      const r = await fetch(`/api/pod/devices/${device!.id}/group`, {
        ...opts, method: 'PUT', headers: J,
        body: JSON.stringify({ groupId: next === 'default' ? null : next }),
      })
      if (!r.ok) throw new Error()
      toast.success(device!.online
        ? 'Group updated — settings sent to the device'
        : 'Group updated — will apply when the device is online')
      onChanged()
    } catch { toast.error('Couldn’t change group') }
  }

  if (!device) return null
  const art = resolveDeviceModel(device.model, device.kind)
  const companionName = companions.find((c) => c.id === device.characterId)?.name
  // The companion currently chosen in the form (not the saved one) drives the wake-word
  // options, so picking a companion immediately offers its wake word (e.g. "Hey Loki").
  const selectedCompanion = companions.find((c) => c.id === characterId)
  const companionPhrase = selectedCompanion?.wakeWordPhrase?.trim()
  const status = !device.paired
    ? { label: 'Needs setup', cls: 'text-amber-600 dark:text-amber-400', dot: 'bg-amber-500' }
    : !device.online
      ? { label: 'Offline', cls: 'text-muted-foreground', dot: 'bg-muted-foreground/50' }
      : ACTIVITY[device.activity] ?? ACTIVITY.idle

  const dirty =
    name.trim() !== device.name ||
    userId !== device.userId ||
    characterId !== (device.characterId ?? '') ||
    wakeWord !== (device.wakeWord ?? '')

  async function test() {
    setTesting(true)
    try {
      const r = await fetch(`/api/pod/devices/${device!.id}/test`, { ...opts, method: 'POST', headers: J, body: JSON.stringify({}) })
      if (r.ok) toast.success('Playing a test sound on your device…')
      else if (r.status === 409) toast.error('Device isn’t connected right now')
      else throw new Error()
    } catch { toast.error('Couldn’t reach the device') } finally { setTesting(false) }
  }

  async function save() {
    if (!name.trim()) { toast.error('Give your device a name'); return }
    setSaving(true)
    try {
      const r = await fetch(`/api/pod/devices/${device!.id}`, {
        ...opts, method: 'PATCH', headers: J,
        body: JSON.stringify({ name: name.trim(), userId, characterId: characterId || null, wakeWord: wakeWord || null }),
      })
      if (!r.ok) throw new Error()
      toast.success('Saved')
      onChanged()
    } catch { toast.error('Couldn’t save changes') } finally { setSaving(false) }
  }

  return (
    <Sheet open={!!device} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto bg-background p-0 sm:max-w-md">
        {/* Hero */}
        <div className="relative bg-gradient-to-b from-brand/10 to-transparent px-5 pb-5 pt-7">
          <div className="flex items-center gap-4">
            <div className="flex size-20 shrink-0 items-center justify-center rounded-3xl bg-card shadow-sm ring-1 ring-border/50">
              <DeviceArt resolved={art} className="size-16" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-lg font-bold leading-tight">{name || device.name}</h2>
              <p className="text-xs font-medium text-muted-foreground/80">{deviceModelName(device.model, device.kind)}</p>
              <span className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-medium">
                <span className={`size-1.5 rounded-full ${status.dot} ${'pulse' in status && status.pulse ? 'animate-pulse' : ''}`} />
                <span className={status.cls}>{status.label}</span>
                {companionName && <span className="text-muted-foreground/70">· {companionName}</span>}
              </span>
            </div>
          </div>

          {/* Test sound — the headline action */}
          <Button onClick={test} disabled={testing || !device.online} className="mt-5 w-full gap-2" size="lg">
            {testing ? <Loader2 className="size-4 animate-spin" /> : <Volume2 className="size-4" />}
            Play a test sound
          </Button>
          {!device.online && <p className="mt-1.5 text-center text-[11px] text-muted-foreground">Power on the device to test it.</p>}
        </div>

        <div className="space-y-5 px-5 pb-28">
          {/* Details */}
          <Group title="Details">
            <FieldRow label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 w-44 text-right text-sm" />
            </FieldRow>
            <FieldRow label="Owner">
              <Picker value={userId} onChange={setUserId}>
                {users.map((u) => <option key={u.id} value={u.id}>{u.nickname?.trim() || `${u.firstName} ${u.lastName}`.trim()}</option>)}
              </Picker>
            </FieldRow>
            <FieldRow label="Companion">
              <Picker value={characterId} onChange={setCharacterId}>
                <option value="">None</option>
                {companions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Picker>
            </FieldRow>
            <FieldRow label="Settings group">
              <Picker value={groupId} onChange={assignGroup}>
                {groups.length === 0 && <option value="default">Default</option>}
                {groups.map((g) => <option key={g.id} value={g.isDefault ? 'default' : g.id}>{g.name}</option>)}
              </Picker>
            </FieldRow>
            <FieldRow label="Wake word">
              <Picker value={wakeWord} onChange={setWakeWord}>
                {/* The selected companion's own wake word (trains its model on first use).
                    Empty value = "use the companion's wake word", which the server resolves
                    to the companion model (or the app default until it's trained). */}
                {companionPhrase
                  ? <option value="">{companionPhrase} — {selectedCompanion?.name}’s wake word</option>
                  : <option value="">App default (Hey Jarvis)</option>}
                {/* Always-reliable built-in */}
                <option value="hey_jarvis">Hey Jarvis — always reliable</option>
                {/* Any other trained detectors (skip the reliable + this companion's own). */}
                {wakewords
                  .filter((d) => d.id !== 'hey_jarvis' && d.id !== selectedCompanion?.wakeWordModelId)
                  .map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              </Picker>
            </FieldRow>
          </Group>

          {/* Network & software */}
          <Group title="Network & software">
            <ActionRow icon={<Wifi className="size-4 text-sky-500" />} label="Wi-Fi network" value={wifiSsid || 'Not set'} onClick={onReflash} />
            <ActionRow icon={<RefreshCw className="size-4 text-violet-500" />} label="Reinstall software" value="" onClick={onReflash} />
            <ActionRow icon={<HelpCircle className="size-4 text-muted-foreground" />} label="How to use" value="" onClick={onHelp} />
          </Group>

          {/* Danger */}
          <Group>
            <button
              onClick={onDelete}
              className="flex w-full items-center gap-3 px-4 py-3 text-sm font-medium text-destructive transition-colors hover:bg-destructive/5"
            >
              <Trash2 className="size-4" /> Remove this device
            </button>
          </Group>
        </div>

        {/* Sticky save bar — only when there are unsaved edits */}
        {dirty && (
          <div className="absolute inset-x-0 bottom-0 flex gap-2 border-t border-border/50 bg-background/95 p-4 backdrop-blur">
            <Button variant="ghost" className="flex-1" onClick={() => { setName(device.name); setUserId(device.userId); setCharacterId(device.characterId ?? ''); setWakeWord(device.wakeWord ?? '') }}>
              Discard
            </Button>
            <Button className="flex-1 gap-2" onClick={save} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />} Save changes
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

// ── iOS-style grouped list bits ─────────────────────────────────────────────

function Group({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      {title && <p className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">{title}</p>}
      <div className="divide-y divide-border/40 overflow-hidden rounded-2xl border border-border/50 bg-card">{children}</div>
    </div>
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

function ActionRow({ icon, label, value, onClick }: { icon: React.ReactNode; label: string; value?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40">
      {icon}
      <span className="text-sm font-medium">{label}</span>
      <div className="ml-auto flex items-center gap-1.5 text-sm text-muted-foreground">
        {value && <span className="max-w-[10rem] truncate">{value}</span>}
        <ChevronRight className="size-4 text-muted-foreground/60" />
      </div>
    </button>
  )
}

function Picker({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) {
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
