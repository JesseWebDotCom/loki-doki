import { useCallback, useEffect, useState } from 'react'
import { useCompanionState } from '@/lib/companionState'
import { CompanionOverlay } from '@/components/shell/CompanionOverlay'
import { DeviceLayoutDisplay, type Descriptor } from '@/components/display/DeviceLayoutDisplay'
import { ControllerDisplay, type ControllerPage } from '@/components/display/ControllerDisplay'
import { StatusDisplay } from '@/components/display/StatusDisplay'
import { ActivityDisplay } from '@/components/display/ActivityDisplay'
import { SleepingDisplay } from '@/components/display/SleepingDisplay'
import { AlertDisplay } from '@/components/display/AlertDisplay'
import type { UserPresence } from '@/lib/presence'

// Full-screen ambient "home screen" for a screen device (Tab5 / Show / tablet Pod):
// point the device's browser at /display. Chrome-less by design — it renders the
// device's assigned SLOT LAYOUT (the unified Layouts system: clock/weather/mic/mute
// widgets in a themed grid) with live clock + weather. The server screenshots this
// exact page into the JPEG it streams to the firmware. The CompanionOverlay is mounted
// for browser viewers so the wake-word toggle engages the mic.
//
// Views (selected by ?view= param, set per-device by Admin or by the user):
//   (default)   — ambient clock/weather layout (DeviceLayoutDisplay)
//   controller  — button-grid controller (ControllerDisplay)
//   status      — full-frame status color + label (BUSY-Bar style)
//   activity    — now-playing music/Plex/YouTube
//   sleeping    — near-black dim display + optional sleep ambient

export function DisplayPage() {
  const { voiceOn, handsFreeOn, setVoice, setHandsFree } = useCompanionState()
  const params = new URLSearchParams(window.location.search)
  // Server-rendered device frames pass ?device=1 (mic/mute become non-interactive — the
  // device can't tap a rendered image; the firmware draws native LVGL buttons instead)
  // and ?deviceId=<id> to select that device's assigned layout.
  const isDeviceRender = params.get('device') === '1'
  const deviceId = params.get('deviceId') ?? ''
  // ?view= selects the display mode.
  const view = params.get('view') ?? 'display'
  const isController = view === 'controller'
  const isStatus = view === 'status'
  const isActivity = view === 'activity'
  const isSleeping = view === 'sleeping'
  // Orientation is handled by LVGL on the firmware via lv_display_set_rotation().
  // The server no longer sends a pre-rotated JPEG — this param is unused but kept
  // for future admin-preview use.
  const orient = parseInt(params.get('orient') ?? '0') || 0
  const [descriptor, setDescriptor] = useState<Descriptor | null>(null)
  const [controllerPage, setControllerPage] = useState<ControllerPage | null>(null)
  const [presence, setPresence] = useState<UserPresence | null>(null)
  // Dismissed alerts — cleared locally before the server TTL lapses so the UI reacts instantly.
  const [dismissedAlert, setDismissedAlert] = useState<number | null>(null)
  const dismissAlert = useCallback(() => setDismissedAlert(Date.now()), [])

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
    if (isStatus || isActivity || isSleeping) return  // these views use the presence poller for primary data
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
  }, [deviceId, isController, isStatus, isActivity, isSleeping])  // eslint-disable-line react-hooks/exhaustive-deps

  // Poll presence for all views — status/activity/sleeping use it for their primary data;
  // ambient/controller use it only for the alert overlay.
  useEffect(() => {
    const q = deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''
    let last = ''
    let alive = true
    const tick = async () => {
      try {
        const r = await fetch(`/api/pod/presence${q}`, { credentials: 'include' })
        if (!r.ok || !alive) return
        const d = await r.json() as UserPresence
        const sig = JSON.stringify(d)
        if (sig === last) return
        last = sig
        setPresence(d)
        // When a new alert arrives, reset any local dismiss so it shows.
        if (d.alert) setDismissedAlert(prev => (prev && d.alert && prev > d.alert.expiresAt - 30_000 ? prev : null))
      } catch { /* offline */ }
    }
    void tick()
    const t = setInterval(tick, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [deviceId])

  return (
    <div className="fixed inset-0 z-0 select-none overflow-hidden bg-[#05080c]">
      {/* Controller button-grid */}
      {isController && controllerPage && <ControllerDisplay page={controllerPage} interactive={!isDeviceRender} deviceId={deviceId} />}

      {/* Ambient clock/weather layout (default) */}
      {!isController && !isStatus && !isActivity && !isSleeping && descriptor && (
        <DeviceLayoutDisplay
          descriptor={descriptor}
          isDeviceRender={isDeviceRender}
          voiceOn={voiceOn}
          handsFreeOn={handsFreeOn}
          onToggleVoice={() => setVoice(!voiceOn)}
          onToggleHandsFree={() => { const next = !handsFreeOn; setHandsFree(next); if (next) setVoice(true) }}
        />
      )}

      {/* Status display — full-frame color flood + label */}
      {isStatus && <StatusDisplay presence={presence} />}

      {/* Activity display — now-playing music / Plex / YouTube */}
      {isActivity && <ActivityDisplay presence={presence} />}

      {/* Sleeping display — dim/off + optional ambient */}
      {isSleeping && <SleepingDisplay presence={presence} />}

      {/* Alert overlay — ephemeral flash on top of any view (timer done, download, etc.) */}
      {(() => {
        const a = presence?.alert ?? null
        if (!a || (dismissedAlert !== null && dismissedAlert >= a.expiresAt - 30_000)) return null
        return <AlertDisplay key={a.expiresAt} alert={a} onExpired={dismissAlert} />
      })()}

      {/* The companion's floating chat UI is for browser viewers; on the device the
          screen is an ambient display (the companion talks via the satellite). */}
      {!isDeviceRender && <CompanionOverlay />}
    </div>
  )
}
