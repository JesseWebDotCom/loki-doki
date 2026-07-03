import { useEffect, useState } from 'react'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { StatusDot, type StatusDotStatus } from '@/components/shared/StatusDot'
import { ListRow } from '@/components/shared/ListRow'
import { DeviceArt } from '@/components/admin/DeviceArt'
import { resolveDeviceModel, deviceModelName } from '@/lib/deviceCatalog'
import { Volume2, Wifi, RefreshCw, Trash2, ChevronRight, HelpCircle, Clock, Camera, Pointer, Monitor, LayoutGrid } from 'lucide-react'
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

const ACTIVITY: Record<string, { label: string; cls: string; dotStatus: StatusDotStatus; pulse?: boolean }> = {
  idle: { label: 'Ready', cls: 'text-success', dotStatus: 'ok' },
  listening: { label: 'Listening', cls: 'text-success', dotStatus: 'ok', pulse: true },
  thinking: { label: 'Thinking', cls: 'text-info', dotStatus: 'info', pulse: true },
  talking: { label: 'Speaking', cls: 'text-info', dotStatus: 'info', pulse: true },
}

// Screen-mode test options for screen Pods (Tab5). The server pushes the chosen mode
// to the device over its live socket; the device swaps its whole LVGL UI to match.
const MODES = [
  { id: 'normal', label: 'Normal', desc: 'Ambient clock', icon: <Clock className="size-5" /> },
  { id: 'camera-test', label: 'Camera', desc: 'Live test feed', icon: <Camera className="size-5" /> },
  { id: 'touch-test', label: 'Touch', desc: 'Tap to draw', icon: <Pointer className="size-5" /> },
]
const MODE_LABEL: Record<string, string> = { normal: 'Normal', 'camera-test': 'Camera test', 'touch-test': 'Touch test', 'stream-deck': 'Controller' }
// Kinds that have a screen (so the Testing section only shows where it's meaningful).
const SCREEN_KINDS = ['tablet', 'show']

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
  const [mode, setMode] = useState('normal')
  const [modeBusy, setModeBusy] = useState(false)

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
    fetch(`/api/pod/devices/${device.id}/mode`, opts)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setMode(d?.mode ?? 'normal'))
      .catch(() => setMode('normal'))
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

  async function changeMode(next: string) {
    if (next === mode || modeBusy) return
    const prev = mode
    setMode(next) // optimistic
    setModeBusy(true)
    try {
      const r = await fetch(`/api/pod/devices/${device!.id}/mode`, { ...opts, method: 'POST', headers: J, body: JSON.stringify({ mode: next }) })
      if (!r.ok) throw new Error()
      const d = (await r.json()) as { online?: boolean }
      toast.success(d.online ? `Switched to ${MODE_LABEL[next]}` : `${MODE_LABEL[next]} set — applies when the device reconnects`)
    } catch { setMode(prev); toast.error('Couldn’t switch mode') } finally { setModeBusy(false) }
  }

  if (!device) return null
  const art = resolveDeviceModel(device.model, device.kind)
  // Show the Testing section for any device with a screen. Gate on the resolved
  // capability (from the model), NOT device.kind — claimed devices can land with a
  // generic kind ('dot') even when their model (tab5) clearly has a touchscreen.
  const isScreen = art.capabilities.includes('Touchscreen') || SCREEN_KINDS.includes(device.kind)
  const companionName = companions.find((c) => c.id === device.characterId)?.name
  // The companion currently chosen in the form (not the saved one) drives the wake-word
  // options, so picking a companion immediately offers its wake word (e.g. "Hey Loki").
  const selectedCompanion = companions.find((c) => c.id === characterId)
  const companionPhrase = selectedCompanion?.wakeWordPhrase?.trim()
  const status: { label: string; cls: string; dotStatus: StatusDotStatus; pulse?: boolean } = !device.paired
    ? { label: 'Needs setup', cls: 'text-warning', dotStatus: 'warn' }
    : !device.online
      ? { label: 'Offline', cls: 'text-muted-foreground', dotStatus: 'off' }
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
            <div className="flex size-20 shrink-0 items-center justify-center rounded-sheet bg-card shadow-sm ring-1 ring-border/50">
              <DeviceArt resolved={art} className="size-16" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-lg font-bold leading-tight">{name || device.name}</h2>
              <p className="text-xs font-medium text-muted-foreground/80">{deviceModelName(device.model, device.kind)}</p>
              <span className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-medium">
                <StatusDot status={status.dotStatus} pulse={status.pulse} />
                <span className={status.cls}>{status.label}</span>
                {companionName && <span className="text-muted-foreground/70">· {companionName}</span>}
              </span>
            </div>
          </div>

          {/* Test sound — the headline action */}
          <Button onClick={test} disabled={testing || !device.online} className="mt-5 w-full gap-2" size="lg">
            {testing ? <Spinner className="text-current" /> : <Volume2 className="size-4" />}
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

          {/* Display / Controller — top-level mode toggle for screen devices */}
          {isScreen && (() => {
            const isController = mode === 'stream-deck'
            return (
              <Group title="Mode">
                {/* Level 1: Display vs Controller */}
                <div className="grid grid-cols-2 gap-2 p-3">
                  <button
                    onClick={() => changeMode('normal')}
                    disabled={modeBusy}
                    className={`flex flex-col items-center gap-2 rounded-card border p-4 text-center transition-colors disabled:opacity-60 ${
                      !isController ? 'border-brand bg-brand/10 text-brand' : 'border-border/50 hover:bg-muted/40'
                    }`}
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
                    className={`flex flex-col items-center gap-2 rounded-card border p-4 text-center transition-colors disabled:opacity-60 ${
                      isController ? 'border-brand bg-brand/10 text-brand' : 'border-border/50 hover:bg-muted/40'
                    }`}
                  >
                    <LayoutGrid className="size-6" />
                    <div>
                      <p className="text-sm font-semibold">Controller</p>
                      <p className="text-[10px] leading-tight text-muted-foreground">Button grid</p>
                    </div>
                  </button>
                </div>

                {/* Level 2: Display sub-modes (testing) — hidden when Controller active */}
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
                            className={`flex flex-col items-center gap-1.5 rounded-card border p-3 text-center transition-colors disabled:opacity-60 ${
                              active ? 'border-brand bg-brand/10 text-brand' : 'border-border/50 hover:bg-muted/40'
                            }`}
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

                {/* Controller quick-link */}
                {isController && (
                  <div className="border-t border-border/40 px-4 py-3">
                    <a
                      href="/settings/stream-deck"
                      className="inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:underline"
                    >
                      Configure buttons <ChevronRight className="size-4" />
                    </a>
                  </div>
                )}
              </Group>
            )
          })()}

          {/* Network & software */}
          <Group title="Network & software">
            <ActionRow icon={<Wifi className="size-4 text-brand" />} label="Wi-Fi network" value={wifiSsid || 'Not set'} onClick={onReflash} />
            <ActionRow icon={<RefreshCw className="size-4 text-brand" />} label="Reinstall software" value="" onClick={onReflash} />
            <ActionRow icon={<HelpCircle className="size-4 text-muted-foreground" />} label="How to use" value="" onClick={onHelp} />
          </Group>

          {/* Danger */}
          <Group>
            <ListRow
              leading={<Trash2 className="size-4 text-destructive" />}
              title="Remove this device"
              onClick={onDelete}
              className="text-destructive hover:bg-destructive/5"
            />
          </Group>
        </div>

        {/* Sticky save bar — only when there are unsaved edits */}
        {/* design-ok(backdrop-blur-outside-chrome): sticky save bar pinned to sheet bottom, content scrolls under */}
        {dirty && (
          <div className="absolute inset-x-0 bottom-0 flex gap-2 border-t border-border/50 bg-background/95 p-4 backdrop-blur">
            <Button variant="ghost" className="flex-1" onClick={() => { setName(device.name); setUserId(device.userId); setCharacterId(device.characterId ?? ''); setWakeWord(device.wakeWord ?? '') }}>
              Discard
            </Button>
            <Button className="flex-1 gap-2" onClick={save} disabled={saving}>
              {saving && <Spinner className="text-current" />} Save changes
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
      <div className="divide-y divide-border/40 overflow-hidden rounded-card border border-border/50 bg-card">{children}</div>
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
    <ListRow
      leading={icon}
      title={label}
      onClick={onClick}
      trailing={
        <>
          {value && <span className="max-w-[10rem] truncate">{value}</span>}
          <ChevronRight className="size-4 text-muted-foreground/60" />
        </>
      }
    />
  )
}

function Picker({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 max-w-[12rem] rounded-control border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {children}
    </select>
  )
}
