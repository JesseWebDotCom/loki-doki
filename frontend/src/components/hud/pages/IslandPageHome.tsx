import { Music, Volume1, Volume2, VolumeX, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NowPlayingCard } from '../NowPlayingModule'
import { useTodayItems } from '../useTodayItems'
import type { NowPlayingInfo } from '../useNowPlaying'

// Home page of the island panel, NotchNook-style: two zones split by a hairline
// divider. Left = media, stacked vertically (art / title / artist / seek /
// transport). Right = calendar with a big date and event cards. Nothing else;
// weather lives on its own tab.

function EventCard({ icon: Icon, label, sublabel, nearby }: { icon: typeof Music; label: string; sublabel?: string; nearby?: boolean }) {
  return (
    // design-ok(glass-on-plain-bg): event card inside the black island surface
    <div className="flex items-center gap-2.5 rounded-[10px] bg-white/[0.07] px-2.5 py-2">
      <span className={`h-7 w-[3px] shrink-0 rounded-full ${nearby ? 'bg-white/25' : 'bg-brand'}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Icon className="size-3.5 shrink-0 text-white/50" />
          <span className="truncate text-sm font-semibold text-white/90">{label}</span>
          {nearby && (
            // design-ok(glass-on-plain-bg): source chip inside the black island surface
            <span className="shrink-0 rounded-full bg-white/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-white/45">Nearby</span>
          )}
        </div>
        {sublabel && <div className="text-xs text-white/45">{sublabel}</div>}
      </div>
    </div>
  )
}

// System volume of the dock's machine, shell-mediated (desktop/src/volume.js).
// Feature-detected: browsers without the bridge never see the cluster.
const VOLUME_ACTIONS: { action: 'mute' | 'down' | 'up'; icon: LucideIcon; label: string }[] = [
  { action: 'mute', icon: VolumeX, label: 'Mute' },
  { action: 'down', icon: Volume1, label: 'Volume down' },
  { action: 'up', icon: Volume2, label: 'Volume up' },
]

function VolumeCluster() {
  if (!window.maipaiDesktop?.volumeCommand) return null
  return (
    <div className="flex items-center gap-1">
      {VOLUME_ACTIONS.map((v) => (
        <Button
          key={v.action}
          variant="ghost"
          size="icon"
          aria-label={v.label}
          title={v.label}
          onClick={() => void window.maipaiDesktop?.volumeCommand?.(v.action)}
          // design-ok(glass-on-plain-bg): sits inside the black island surface
          className="size-7 rounded-full text-white/50 hover:bg-white/10 hover:text-white"
        >
          <v.icon className="size-4" />
        </Button>
      ))}
    </div>
  )
}

export function IslandPageHome({ nowPlaying }: { nowPlaying: NowPlayingInfo | null }) {
  const { items } = useTodayItems()
  const now = new Date()

  return (
    <div className="grid h-full grid-cols-[1.15fr_1fr] gap-5">
      {/* Media zone */}
      <div className="flex min-w-0 flex-col items-center justify-center gap-2">
        {nowPlaying ? (
          <NowPlayingCard info={nowPlaying} />
        ) : (
          <div className="flex w-full flex-col items-center gap-2 text-white/35">
            <Music className="size-8" />
            <span className="text-sm">Nothing playing</span>
          </div>
        )}
        <VolumeCluster />
      </div>

      {/* Calendar zone */}
      {/* design-ok(glass-on-plain-bg): hairline zone divider inside the black island surface */}
      <div className="flex min-w-0 flex-col border-l border-white/[0.08] pl-5">
        <div className="self-end text-right">
          <div className="text-xs font-bold uppercase tracking-widest text-brand">
            {now.toLocaleDateString(undefined, { weekday: 'short' })}
          </div>
          <div className="text-[42px] font-bold leading-none text-white">{now.getDate()}</div>
        </div>
        <div className="mt-2 flex-1 space-y-2 overflow-y-auto">
          {items.length === 0 ? (
            <div className="pt-4">
              <p className="text-base font-bold text-white/90">No events today</p>
              <p className="text-sm text-white/40">Enjoy your free time!</p>
            </div>
          ) : (
            items.slice(0, 3).map((it) => (
              <EventCard key={it.key} icon={it.icon} label={it.label} sublabel={it.sublabel} nearby={it.kind === 'nearby'} />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
