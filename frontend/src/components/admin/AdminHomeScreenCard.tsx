import { useEffect, useState } from 'react'
import { Clock, CalendarDays, CloudSun, Sparkles, MonitorPlay, ExternalLink, Loader2, Video } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/context/AuthContext'
import { toast } from '@/lib/toast'
import { HomeDisplayCanvas } from '@/components/display/HomeDisplayCanvas'
import {
  loadHomeDisplay,
  saveHomeDisplay,
  DEFAULT_HOME_DISPLAY,
  type ClockStyle,
  type HomeDisplayConfig,
} from '@/lib/homeDisplay'
import { cn } from '@/lib/cn'

// Admin → Devices → "Home screen": customize the ambient /display screen a Tab5 /
// Show / tablet Pod shows. Saved per-user via preferences (optimistic), so the
// device bound to this user picks it up. A live preview renders the real canvas.

const CLOCK_STYLES: { value: ClockStyle; label: string; hint: string }[] = [
  { value: 'digital', label: 'Digital', hint: 'Clean LCD numerals' },
  { value: 'flip', label: 'Flip', hint: 'Split-flap flip-clock cards' },
]

const TOGGLES: { key: keyof HomeDisplayConfig; label: string; description: string; Icon: React.ElementType }[] = [
  { key: 'clock', label: 'Clock', description: 'Big clock in the center of the screen', Icon: Clock },
  { key: 'date', label: 'Date', description: 'Weekday and date under the clock', Icon: CalendarDays },
  { key: 'weather', label: 'Weather', description: 'Animated icon + temperature, upper-right', Icon: CloudSun },
  { key: 'weatherBackground', label: 'Weather background', description: 'Animated sky — rain, snow, stars, sun', Icon: Sparkles },
]

export function AdminHomeScreenCard() {
  const { user } = useAuth()
  const [config, setConfig] = useState<HomeDisplayConfig>(DEFAULT_HOME_DISPLAY)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!user?.id) return
    loadHomeDisplay(user.id).then((c) => {
      setConfig(c)
      setLoaded(true)
    })
  }, [user?.id])

  function patch(next: Partial<HomeDisplayConfig>) {
    if (!user?.id) return
    const merged = { ...config, ...next }
    setConfig(merged) // optimistic
    setSaving(true)
    saveHomeDisplay(user.id, merged).finally(() => setSaving(false))
  }

  // ── Camera test: prove the server can drive a flashed device's screen ──────────
  const [testDevices, setTestDevices] = useState<{ id: string; name: string }[]>([])
  const [testDevice, setTestDevice] = useState('')
  const [cameraUrl, setCameraUrl] = useState('')
  const [testBusy, setTestBusy] = useState(false)

  useEffect(() => {
    fetch('/api/pod/devices', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then((d: { id: string; name: string }[]) => {
        setTestDevices(d.map((x) => ({ id: x.id, name: x.name })))
        setTestDevice((cur) => cur || d[0]?.id || '')
      })
      .catch(() => {})
  }, [])

  async function driveDisplay(body: { mode: 'auto' } | { mode: 'camera'; url: string }) {
    if (!testDevice) return
    setTestBusy(true)
    try {
      const r = await fetch(`/api/pod/devices/${testDevice}/display`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error()
      toast.success(body.mode === 'camera' ? 'Pushed camera to the device' : 'Device back to clock/weather')
    } catch {
      toast.error('Failed to update the device screen')
    } finally {
      setTestBusy(false)
    }
  }

  return (
    <section id="devices-home-screen" className="space-y-3 scroll-mt-20">
      <div className="flex items-center gap-2">
        <MonitorPlay className="size-4 text-cyan-500" />
        <h3 className="text-sm font-semibold">Home screen</h3>
        <span className="text-xs text-muted-foreground">— the ambient display on screen devices</span>
        {saving && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
        <Button asChild size="sm" variant="ghost" className="ml-auto h-8 gap-1.5 text-xs">
          <a href="/display" target="_blank" rel="noreferrer">
            <ExternalLink className="size-3.5" /> Open display
          </a>
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Live preview — the exact canvas the device renders. */}
        <div className="overflow-hidden rounded-2xl border border-border/50 bg-black shadow-inner">
          <div className="relative aspect-video w-full">
            <HomeDisplayCanvas config={config} className="absolute inset-0" />
          </div>
        </div>

        {/* Controls */}
        <div className="flex flex-col gap-3 rounded-2xl border border-border/50 bg-card p-4">
          {TOGGLES.map(({ key, label, description, Icon }) => (
            <div key={key} className="flex items-center gap-3">
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{description}</p>
              </div>
              <Switch
                checked={config[key] as boolean}
                onCheckedChange={(v) => patch({ [key]: v } as Partial<HomeDisplayConfig>)}
                disabled={!loaded}
              />
            </div>
          ))}

          {/* Clock style + format — only meaningful while the clock is shown. */}
          <div className={cn('space-y-3 rounded-xl bg-muted/40 p-3 transition-opacity', config.clock ? '' : 'pointer-events-none opacity-40')}>
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">Clock style</p>
              <div className="flex gap-2">
                {CLOCK_STYLES.map((s) => (
                  <button
                    key={s.value}
                    onClick={() => patch({ clockStyle: s.value })}
                    className={cn(
                      'flex-1 rounded-lg border px-3 py-2 text-left transition-colors',
                      config.clockStyle === s.value
                        ? 'border-cyan-500/60 bg-cyan-500/10 text-foreground'
                        : 'border-border/50 bg-background text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <span className="block text-sm font-medium">{s.label}</span>
                    <span className="block text-[11px] text-muted-foreground">{s.hint}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">24-hour time</p>
                <p className="text-xs text-muted-foreground">Hide AM/PM and use a 24-hour clock</p>
              </div>
              <Switch checked={config.hour24} onCheckedChange={(v) => patch({ hour24: v })} disabled={!loaded} />
            </div>
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Show seconds</p>
                <p className="text-xs text-muted-foreground">Tick a seconds field alongside the time</p>
              </div>
              <Switch checked={config.showSeconds} onCheckedChange={(v) => patch({ showSeconds: v })} disabled={!loaded} />
            </div>
          </div>
        </div>
      </div>

      {/* Camera test — server-drives-the-screen pipeline. The chosen device shows the
          camera instead of the clock until "Back to clock". Needs the device flashed
          with the latest firmware (it polls the server for its frame). */}
      <div className="space-y-3 rounded-2xl border border-border/50 bg-card p-4">
        <div className="flex items-center gap-2">
          <Video className="size-4 text-amber-500" />
          <h4 className="text-sm font-semibold">Camera test</h4>
          <span className="text-xs text-muted-foreground">— push a live camera to a device's screen</span>
        </div>
        <p className="text-xs text-muted-foreground">
          The device shows whatever the server serves. Enter a camera snapshot or MJPEG URL (e.g.
          <code className="mx-1 rounded bg-muted px-1">http://cam.local/snapshot.jpg</code>) and push it to a
          flashed screen device; "Back to clock" returns it to the ambient display.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <select
            value={testDevice}
            onChange={(e) => setTestDevice(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {testDevices.length === 0 && <option value="">No devices</option>}
            {testDevices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <Input placeholder="http://camera/snapshot.jpg" value={cameraUrl} onChange={(e) => setCameraUrl(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => driveDisplay({ mode: 'camera', url: cameraUrl.trim() })} disabled={!testDevice || !cameraUrl.trim() || testBusy}>
            {testBusy ? <Loader2 className="size-4 animate-spin" /> : <><Video className="size-3.5" /> Show camera</>}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => driveDisplay({ mode: 'auto' })} disabled={!testDevice || testBusy}>
            Back to clock
          </Button>
        </div>
      </div>
    </section>
  )
}
