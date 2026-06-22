import { useState } from 'react'
import { Clock, Globe, AlarmClock, Timer, Watch, type LucideIcon } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { cn } from '@/lib/cn'
import { useTimeApp } from '@/context/TimeAlarmContext'
import { WorldClockTab } from '@/components/time/WorldClockTab'
import { AlarmsTab } from '@/components/time/AlarmsTab'
import { TimersTab } from '@/components/time/TimersTab'
import { StopwatchTab } from '@/components/time/StopwatchTab'

type TabKey = 'clock' | 'alarms' | 'timers' | 'stopwatch'

const TABS: { key: TabKey; label: string; icon: LucideIcon }[] = [
  { key: 'clock', label: 'World Clock', icon: Globe },
  { key: 'alarms', label: 'Alarms', icon: AlarmClock },
  { key: 'timers', label: 'Timers', icon: Timer },
  { key: 'stopwatch', label: 'Stopwatch', icon: Watch },
]

export function TimePage() {
  const [tab, setTab] = useState<TabKey>('clock')
  const { locations, alarms, timers, running, stopwatch } = useTimeApp()

  // Glanceable count per tab: cities, alarms, timers (running + saved), and laps.
  const counts: Record<TabKey, number> = {
    clock: locations.length,
    alarms: alarms.length,
    timers: running.length + timers.length,
    stopwatch: stopwatch.laps.length,
  }

  return (
    <PageShell GhostIcon={Clock}>
      <div className="mx-auto w-full max-w-2xl px-5 py-8">
        <header className="mb-6">
          <h1 className="text-3xl font-black tracking-tight sm:text-4xl">Time</h1>
          <p className="mt-1 text-sm text-muted-foreground">World clock, alarms, timers, and a stopwatch.</p>
        </header>

        <div className="mb-6 inline-flex w-full rounded-xl bg-foreground/8 p-1 sm:w-auto">
          {TABS.map(({ key, label, icon: Icon }) => {
            const active = tab === key
            const count = counts[key]
            return (
              <button key={key} onClick={() => setTab(key)}
                className={cn('flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition-colors sm:flex-none',
                  active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                <Icon className="size-4" />
                <span className="hidden sm:inline">{label}</span>
                {count > 0 && (
                  <span className={cn('inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-[10px] font-bold tabular-nums',
                    active ? 'bg-brand text-brand-foreground' : 'bg-foreground/10 text-muted-foreground')}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {tab === 'clock' && <WorldClockTab />}
        {tab === 'alarms' && <AlarmsTab />}
        {tab === 'timers' && <TimersTab />}
        {tab === 'stopwatch' && <StopwatchTab />}
      </div>
    </PageShell>
  )
}
