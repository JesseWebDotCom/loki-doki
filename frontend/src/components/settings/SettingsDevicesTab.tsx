import { useEffect, useState } from 'react'
import { Loader2, Cpu } from 'lucide-react'
import { DeviceScreenDeckEditor, type DeckLocks } from '@/components/shared/DeviceScreenDeckEditor'
import { resolveDeviceModel } from '@/lib/deviceCatalog'
import { cn } from '@/lib/cn'

// Settings → Devices: the owner-facing screen-deck editor. Reads/writes the exact same
// device_screens rows as Admin → Devices → (device) → Display — a change made here shows
// up there and vice versa. An admin can lock screen selection and/or configuration per
// device; this page renders read-only for whichever capability is locked (also enforced
// server-side, so it can't be bypassed by calling the API directly).
//
// Screenless Pods (e.g. Atom Echo — mic/speaker only) have nothing to swipe between, so
// they're filtered out here entirely (mirrors the isScreen check gating the Display tab
// in Admin → Devices).

const SCREEN_KINDS = ['tablet', 'show']
function isScreenDevice(d: { kind: string; model: string | null }): boolean {
  const art = resolveDeviceModel(d.model, d.kind)
  return art.capabilities.includes('Touchscreen') || SCREEN_KINDS.includes(d.kind)
}

interface MyDevice {
  id: string; name: string; kind: string; model: string | null; online: boolean
  lockScreenSelection?: boolean; lockScreenConfig?: boolean
}

const opts: RequestInit = { credentials: 'include' }

export function SettingsDevicesTab() {
  const [devices, setDevices] = useState<MyDevice[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/pod/my/devices', opts)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: MyDevice[]) => {
        const screens = Array.isArray(rows) ? rows.filter(isScreenDevice) : []
        setDevices(screens)
        setSelectedId((prev) => prev ?? screens[0]?.id ?? null)
      })
      .catch(() => setDevices([]))
  }, [])

  if (devices === null) {
    return <div className="flex justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
  }

  if (devices.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
        <Cpu className="size-10 opacity-30" />
        <p className="text-sm">None of your devices have a screen to customize.</p>
        <p className="text-xs opacity-70">Speaker-only Pods (like an Atom Echo) don't have screens to swipe between.</p>
      </div>
    )
  }

  const selected = devices.find((d) => d.id === selectedId) ?? devices[0]!
  const locks: DeckLocks = { lockScreenSelection: selected.lockScreenSelection ?? false, lockScreenConfig: selected.lockScreenConfig ?? false }

  return (
    <div className="space-y-5 p-1">
      <div>
        <h2 className="text-base font-semibold">Devices</h2>
        <p className="text-sm text-muted-foreground">
          Customize which screens your device shows, in what order — including the controller's buttons.
        </p>
      </div>

      {devices.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {devices.map((d) => (
            <button
              key={d.id}
              onClick={() => setSelectedId(d.id)}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-sm transition-colors',
                d.id === selected.id ? 'border-brand bg-brand/10 text-brand' : 'border-border/50 text-muted-foreground hover:bg-muted/40',
              )}
            >
              {d.name}
            </button>
          ))}
        </div>
      )}

      <DeviceScreenDeckEditor deviceId={selected.id} asAdmin={false} locks={locks} />
    </div>
  )
}
