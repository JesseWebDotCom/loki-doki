import { useEffect, useState } from 'react'
import { Volume2, VolumeX, Mic, MicOff } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { useCompanionState } from '@/lib/companionState'
import { CompanionOverlay } from '@/components/shell/CompanionOverlay'
import { HomeDisplayCanvas } from '@/components/display/HomeDisplayCanvas'
import { loadHomeDisplay, DEFAULT_HOME_DISPLAY, type HomeDisplayConfig } from '@/lib/homeDisplay'
import { cn } from '@/lib/cn'

// Full-screen ambient "home screen" for a screen device (Tab5 / Show / tablet
// Pod): point the device's browser at /display. Chrome-less by design (no sidebar,
// no boot UI) — just the clock/date/weather canvas plus on-display mute + wake-word
// controls. The CompanionOverlay is mounted here so the wake-word toggle actually
// engages the mic and the companion can speak/listen on the device itself.

function ControlButton({
  active,
  ActiveIcon,
  InactiveIcon,
  label,
  pulse,
  onClick,
}: {
  active: boolean
  ActiveIcon: React.ElementType
  InactiveIcon: React.ElementType
  label: string
  pulse?: boolean
  onClick: () => void
}) {
  const Icon = active ? ActiveIcon : InactiveIcon
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        'relative flex size-14 items-center justify-center rounded-2xl border backdrop-blur-md transition-all sm:size-16',
        active
          ? 'border-white/30 bg-white/20 text-white shadow-lg'
          : 'border-white/10 bg-black/30 text-white/55 hover:bg-black/45 hover:text-white',
      )}
    >
      {active && pulse && <span className="absolute inset-0 animate-ping rounded-2xl border border-white/40" />}
      <Icon className="size-6 sm:size-7" />
    </button>
  )
}

export function DisplayPage() {
  const { user } = useAuth()
  const [config, setConfig] = useState<HomeDisplayConfig>(DEFAULT_HOME_DISPLAY)
  const { voiceOn, handsFreeOn, setVoice, setHandsFree } = useCompanionState()
  // Server-rendered device frames pass ?device=1: hide the web control buttons, since
  // the device can't tap a rendered image — it draws native LVGL buttons instead.
  const isDeviceRender = new URLSearchParams(window.location.search).get('device') === '1'

  useEffect(() => {
    if (user?.id) loadHomeDisplay(user.id).then(setConfig)
  }, [user?.id])

  return (
    <div className="fixed inset-0 z-0 select-none bg-[#05080c]">
      <HomeDisplayCanvas config={config} className="h-full w-full" />

      {/* On-display controls, top-center (bottom is reserved for the companion message
          area). On a real browser these drive the shared companion state; the device
          render hides them (?device=1) and draws native firmware buttons that work. */}
      {!isDeviceRender && (
        <div className="absolute top-0 left-0 z-20 flex flex-col items-start gap-3 p-6 sm:p-8">
          <ControlButton
            active={voiceOn}
            ActiveIcon={Volume2}
            InactiveIcon={VolumeX}
            label={voiceOn ? 'Mute companion audio' : 'Unmute companion audio'}
            onClick={() => setVoice(!voiceOn)}
          />
          <ControlButton
            active={handsFreeOn}
            ActiveIcon={Mic}
            InactiveIcon={MicOff}
            label={handsFreeOn ? 'Wake word on — listening' : 'Wake word off'}
            pulse
            onClick={() => {
              const next = !handsFreeOn
              setHandsFree(next)
              if (next) setVoice(true)
            }}
          />
        </div>
      )}

      {/* The companion's floating chat UI is for browser viewers; on the device the
          screen is an ambient display (and the companion talks via the satellite), so
          drop it from the device render. */}
      {!isDeviceRender && <CompanionOverlay />}
    </div>
  )
}
