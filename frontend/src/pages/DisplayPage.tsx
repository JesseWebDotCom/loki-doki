import { useEffect, useState } from 'react'
import { useCompanionState } from '@/lib/companionState'
import { CompanionOverlay } from '@/components/shell/CompanionOverlay'
import { DeviceLayoutDisplay, type Descriptor } from '@/components/display/DeviceLayoutDisplay'
import { ControllerDisplay, type ControllerPage } from '@/components/display/ControllerDisplay'

// Full-screen ambient "home screen" for a screen device (Tab5 / Show / tablet Pod):
// point the device's browser at /display. Chrome-less by design — it renders the
// device's assigned SLOT LAYOUT (the unified Layouts system: clock/weather/mic/mute
// widgets in a themed grid) with live clock + weather. The server screenshots this
// exact page into the JPEG it streams to the firmware. The CompanionOverlay is mounted
// for browser viewers so the wake-word toggle engages the mic.

export function DisplayPage() {
  const { voiceOn, handsFreeOn, setVoice, setHandsFree } = useCompanionState()
  const params = new URLSearchParams(window.location.search)
  // Server-rendered device frames pass ?device=1 (mic/mute become non-interactive — the
  // device can't tap a rendered image; the firmware draws native LVGL buttons instead)
  // and ?deviceId=<id> to select that device's assigned layout.
  const isDeviceRender = params.get('device') === '1'
  const deviceId = params.get('deviceId') ?? ''
  // ?view=controller renders the button-grid controller page instead of the ambient layout.
  const isController = params.get('view') === 'controller'
  const [descriptor, setDescriptor] = useState<Descriptor | null>(null)
  const [controllerPage, setControllerPage] = useState<ControllerPage | null>(null)

  // The screenshotted display must never show a scrollbar (it'd flash on the device
  // edge each render). Lock the document to no-scroll while /display is mounted.
  useEffect(() => {
    const prevHtml = document.documentElement.style.overflow
    const prevBody = document.body.style.overflow
    document.documentElement.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
    return () => { document.documentElement.style.overflow = prevHtml; document.body.style.overflow = prevBody }
  }, [])

  // Poll the assigned layout so an admin edit/assignment shows up on the device without
  // a reload — the server screenshots this very page for the Tab5, and the parked
  // headless tab never reloads on its own, so we re-fetch and swap the descriptor in
  // place when it changes. Only updates state when the payload actually differs (so the
  // live clock/weather keep ticking smoothly between layout changes).
  useEffect(() => {
    const q = deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''
    const url = isController ? `/api/pod/controller-layout${q}` : `/api/pod/display-layout${q}`
    let last = ''
    let alive = true
    const tick = async () => {
      try {
        const r = await fetch(url, { credentials: 'include' })
        if (!r.ok || !alive) return
        const d = await r.json()
        const sig = JSON.stringify(d)
        if (sig === last) return
        last = sig
        if (isController) {
          const page = Array.isArray(d?.pages) ? d.pages[0] : null
          if (page && Array.isArray(page.buttons)) setControllerPage(page)
        } else if (d?.theme && Array.isArray(d.widgets)) {
          setDescriptor(d)
        }
      } catch { /* offline — keep showing the last layout */ }
    }
    void tick()
    const t = setInterval(tick, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [deviceId, isController])

  return (
    <div className="fixed inset-0 z-0 select-none overflow-hidden bg-[#05080c]">
      {isController && controllerPage && <ControllerDisplay page={controllerPage} interactive={!isDeviceRender} deviceId={deviceId} />}
      {!isController && descriptor && (
        <DeviceLayoutDisplay
          descriptor={descriptor}
          isDeviceRender={isDeviceRender}
          voiceOn={voiceOn}
          handsFreeOn={handsFreeOn}
          onToggleVoice={() => setVoice(!voiceOn)}
          onToggleHandsFree={() => { const next = !handsFreeOn; setHandsFree(next); if (next) setVoice(true) }}
        />
      )}

      {/* The companion's floating chat UI is for browser viewers; on the device the
          screen is an ambient display (the companion talks via the satellite). */}
      {!isDeviceRender && <CompanionOverlay />}
    </div>
  )
}
