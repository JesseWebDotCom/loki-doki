import { useEffect, useState } from 'react'
import { Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'

// Admin → Devices: prove the server can drive a flashed device's screen — push a live
// camera feed to a device instead of its ambient layout, then return it to the layout.
// (The ambient display itself is now customised in Devices → Layouts; this is the
// server-drives-the-screen test that used to live under the old "Home screen" card.)
export function DeviceCameraTestCard() {
  const [devices, setDevices] = useState<{ id: string; name: string }[]>([])
  const [device, setDevice] = useState('')
  const [cameraUrl, setCameraUrl] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/pod/devices', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then((d: { id: string; name: string }[]) => {
        setDevices(d.map((x) => ({ id: x.id, name: x.name })))
        setDevice((cur) => cur || d[0]?.id || '')
      })
      .catch(() => {})
  }, [])

  async function driveDisplay(body: { mode: 'auto' } | { mode: 'camera'; url: string }) {
    if (!device) return
    setBusy(true)
    try {
      const r = await fetch(`/api/pod/devices/${device}/display`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error()
      toast.success(body.mode === 'camera' ? 'Pushed camera to the device' : 'Device back to its layout')
    } catch { toast.error('Failed to update the device screen') } finally { setBusy(false) }
  }

  return (
    <Card variant="surface" id="devices-camera-test" className="space-y-3 border-border/50 p-4 scroll-mt-20">
      <div className="flex items-center gap-2">
        <Video className="size-4 text-brand" />
        <h4 className="text-sm font-semibold">Camera test</h4>
        <span className="text-xs text-muted-foreground">Push a live camera to a device's screen</span>
      </div>
      <p className="text-xs text-muted-foreground">
        The device shows whatever the server serves. Enter a camera snapshot or MJPEG URL (e.g.
        <code className="mx-1 rounded bg-muted px-1">http://cam.local/snapshot.jpg</code>) and push it to a
        flashed screen device; "Back to layout" returns it to the ambient display.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <select value={device} onChange={(e) => setDevice(e.target.value)} className="h-9 rounded-control border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          {devices.length === 0 && <option value="">No devices</option>}
          {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <Input placeholder="http://camera/snapshot.jpg" value={cameraUrl} onChange={(e) => setCameraUrl(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => driveDisplay({ mode: 'camera', url: cameraUrl.trim() })} disabled={!device || !cameraUrl.trim() || busy}>
          {busy ? <Spinner className="text-current" /> : <><Video className="size-3.5" /> Show camera</>}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => driveDisplay({ mode: 'auto' })} disabled={!device || busy}>
          Back to layout
        </Button>
      </div>
    </Card>
  )
}
