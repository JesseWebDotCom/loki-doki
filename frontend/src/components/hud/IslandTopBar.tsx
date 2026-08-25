import { Activity, AppWindow, Bell, CalendarDays, CloudSun, Command, FolderUp, Home, Lamp, Music, Settings, Timer, Zap } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { useInstalledTools, isAppVisible } from '@/hooks/useInstalledTools'
import { useNotifications } from '@/hooks/useNotifications'
import { useServerHealth } from '@/context/ServerHealthContext'
import { useBattery } from './useBattery'
import { NOTCH_CORE_W } from './IslandCompact'

// Top bar of the island's full panel, living IN the notch strip like
// SuperIsland's toolbar: icon tabs in the LEFT shoulder, status cluster in the
// RIGHT shoulder, and a dead center gap where the physical notch cuts the
// screen. Content below the bar is therefore always notch-safe.

export type IslandTab = 'home' | 'actions' | 'devices' | 'music' | 'weather' | 'calendar' | 'shelf' | 'focus' | 'stats' | 'settings'

/** Cycle order for the side chevrons; settings is gear-only by design. */
export const ISLAND_TABS: IslandTab[] = ['home', 'actions', 'devices', 'music', 'weather', 'calendar', 'shelf', 'focus', 'stats']

/** Tabs visible on this install: Devices only exists when the Home Assistant
 *  app is installed, matching launcher visibility. Drives both the tab bar
 *  and the chevron/swipe cycle so hidden tabs are never reachable. */
export function useIslandTabs(): IslandTab[] {
  const { enabledToolIds } = useInstalledTools()
  return ISLAND_TABS.filter((t) => t !== 'devices' || isAppVisible('homeAssistant', enabledToolIds))
}

const TAB_META: { tab: IslandTab; icon: typeof Home; label: string }[] = [
  { tab: 'home', icon: Home, label: 'Home' },
  { tab: 'actions', icon: Command, label: 'Actions' },
  { tab: 'devices', icon: Lamp, label: 'Devices' },
  { tab: 'music', icon: Music, label: 'Music' },
  { tab: 'weather', icon: CloudSun, label: 'Weather' },
  { tab: 'calendar', icon: CalendarDays, label: 'Calendar' },
  { tab: 'shelf', icon: FolderUp, label: 'Shelf' },
  { tab: 'focus', icon: Timer, label: 'Focus' },
  { tab: 'stats', icon: Activity, label: 'System' },
]

// Colored battery glyph, TheBoringNotch style: green when healthy/charging,
// amber under 20, red under 10, bolt while charging.
function BatteryGlyph({ percent, charging }: { percent: number; charging: boolean }) {
  const fill = charging || percent > 20 ? 'bg-success' : percent > 10 ? 'bg-warning' : 'bg-destructive'
  return (
    <span className="flex items-center gap-1.5 text-[11px] tabular-nums text-white/70" title={charging ? 'Charging' : 'On battery'}>
      {percent}%
      {/* design-ok(glass-on-plain-bg): battery outline inside the black island surface */}
      <span className="relative flex h-[11px] w-[22px] items-center rounded-[3px] border border-white/35 px-[1.5px]">
        <span className={cn('h-[6px] rounded-[1px]', fill)} style={{ width: `${Math.max(6, percent)}%` }} />
        {charging && <Zap className="absolute inset-0 m-auto size-2.5 fill-black stroke-black" />}
        {/* design-ok(glass-on-plain-bg): battery nub inside the black island surface */}
        <span className="absolute -right-[3.5px] top-1/2 h-[5px] w-[2px] -translate-y-1/2 rounded-r-[1px] bg-white/35" />
      </span>
    </span>
  )
}

export function IslandTopBar({ tab, setTab, topInset }: {
  tab: IslandTab
  setTab: (t: IslandTab) => void
  /** Height of the menu-bar/notch strip; the bar fills it so page content starts below the notch. */
  topInset: number
}) {
  const { unreadCount } = useNotifications()
  const { reachable } = useServerHealth()
  const battery = useBattery()
  const visibleTabs = useIslandTabs()

  return (
    <div className="flex items-center" style={{ height: Math.max(topInset, 36) }}>
      {/* Left shoulder: module tabs */}
      <div className="flex flex-1 items-center gap-0.5">
        {TAB_META.filter((m) => visibleTabs.includes(m.tab)).map((m) => (
          <Button
            key={m.tab}
            variant="ghost"
            size="icon"
            aria-label={m.label}
            aria-pressed={tab === m.tab}
            title={m.label}
            onClick={() => setTab(m.tab)}
            // design-ok(glass-on-plain-bg): tab chips inside the black island surface
            className={cn(
              'h-7 w-8 rounded-full',
              tab === m.tab ? 'bg-white/15 text-white hover:bg-white/20' : 'text-white/50 hover:bg-white/10 hover:text-white',
            )}
          >
            <m.icon className="size-4" />
          </Button>
        ))}
      </div>

      {/* The physical notch: nothing may render here. */}
      <div style={{ width: NOTCH_CORE_W }} className="shrink-0" />

      {/* Right shoulder: status cluster */}
      <div className="flex flex-1 items-center justify-end gap-1.5">
        {!reachable && (
          <span className="flex items-center gap-1 text-[11px] text-destructive" title="Server unreachable">
            <span className="size-1.5 rounded-full bg-destructive" /> offline
          </span>
        )}
        {battery && <BatteryGlyph percent={battery.percent} charging={battery.charging} />}
        {unreadCount > 0 && (
          <button
            type="button"
            aria-label={`${unreadCount} unread notifications`}
            title={`${unreadCount} unread notifications`}
            onClick={() => window.maipaiDesktop?.openMainWindow()}
            className="flex items-center gap-1 text-[11px] tabular-nums text-white/60 hover:text-white"
          >
            <Bell className="size-3.5" />
            {unreadCount}
          </button>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open MaiPai Home"
          title="Open MaiPai Home"
          onClick={() => window.maipaiDesktop?.openMainWindow()}
          // design-ok(glass-on-plain-bg): sits inside the black island surface
          className="h-7 w-8 rounded-full text-white/50 hover:bg-white/10 hover:text-white"
        >
          <AppWindow className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Settings"
          aria-pressed={tab === 'settings'}
          title="Settings"
          onClick={() => setTab('settings')}
          // design-ok(glass-on-plain-bg): sits inside the black island surface
          className={cn(
            'h-7 w-8 rounded-full',
            tab === 'settings' ? 'bg-white/15 text-white hover:bg-white/20' : 'text-white/50 hover:bg-white/10 hover:text-white',
          )}
        >
          <Settings className="size-4" />
        </Button>
      </div>
    </div>
  )
}
