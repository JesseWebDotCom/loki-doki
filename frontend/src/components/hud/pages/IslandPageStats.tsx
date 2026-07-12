import { useEffect, useState } from 'react'
import { Zap } from 'lucide-react'
import { cn } from '@/lib/cn'
import { timeAgo } from '@/lib/notifications'
import type { ResourceState } from '@/types/desktop'

// System page of the island panel: live gauges for the machine Doki Dock runs
// on (CPU / memory / disk / battery from desktop/src/resources.js) plus the
// recent threshold alerts. Read-only glance; thresholds live in Settings.

const POLL_MS = 10_000

function Gauge({ label, valueText, pct, firing, hint }: {
  label: string
  valueText: string
  /** 0-100 fill; meaning depends on the metric (usage for CPU/mem, fullness for disk). */
  pct: number | null
  firing: boolean
  hint?: string
}) {
  const fill = firing ? 'bg-destructive' : pct != null && pct >= 75 ? 'bg-warning' : 'bg-success'
  return (
    <div className="py-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className={cn('text-sm', firing ? 'text-destructive' : 'text-white/85')}>{label}</span>
        <span className={cn('text-[11px] tabular-nums', firing ? 'text-destructive' : 'text-white/60')}>{valueText}</span>
      </div>
      {/* design-ok(glass-on-plain-bg): meter track inside the black island surface */}
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
        {pct != null && <div className={cn('h-full rounded-full transition-[width]', fill)} style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} />}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-white/40">{hint}</div>}
    </div>
  )
}

export function IslandPageStats() {
  const [state, setState] = useState<ResourceState | null>(null)

  useEffect(() => {
    if (!window.lokiDesktop?.getResources) return
    let cancelled = false
    const tick = () => {
      void window.lokiDesktop?.getResources?.().then((s) => { if (!cancelled) setState(s) })
    }
    tick()
    const t = setInterval(tick, POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  if (!window.lokiDesktop?.getResources) {
    return <p className="pt-2 text-xs text-white/40">Machine stats are available in the desktop app.</p>
  }
  if (!state?.snapshot) {
    return <p className="pt-2 text-xs text-white/40">{state && !state.enabled ? 'Machine monitoring is turned off in Settings.' : 'Reading machine stats…'}</p>
  }

  const s = state.snapshot
  const firing = new Set(state.firing)
  const diskUsedPct = s.diskFreePct != null ? 100 - s.diskFreePct : null

  return (
    <div className="flex h-full flex-col gap-0.5 overflow-y-auto">
      <div className="flex items-baseline justify-between pt-1">
        <span className="text-[11px] uppercase tracking-wide text-white/40">{state.hostname}</span>
        {!state.enabled && <span className="text-[11px] text-warning">monitoring off</span>}
      </div>

      <Gauge
        label="Processor"
        valueText={s.cpuPct != null ? `${s.cpuPct}%` : '–'}
        pct={s.cpuPct}
        firing={firing.has('cpu')}
        hint={`${s.cpuCount} cores · load ${s.loadAvg1m.toFixed(1)}`}
      />
      <Gauge
        label="Memory"
        valueText={s.memUsedPct != null ? `${s.memUsedPct}% used` : '–'}
        pct={s.memUsedPct}
        firing={firing.has('memory')}
        hint={`${s.memFreeGb} GB free of ${s.memTotalGb} GB`}
      />
      <Gauge
        label="Disk"
        valueText={s.diskFreeGb != null ? `${s.diskFreeGb} GB free` : '–'}
        pct={diskUsedPct}
        firing={firing.has('disk')}
        hint={s.diskFreePct != null ? `${s.diskFreePct}% of ${s.diskTotalGb} GB free` : undefined}
      />
      {s.battery && (
        <Gauge
          label="Battery"
          valueText={`${s.battery.percent}%`}
          pct={s.battery.percent}
          firing={firing.has('battery')}
          hint={s.battery.charging ? 'Charging' : 'On battery'}
        />
      )}

      {state.recentAlerts.length > 0 && (
        <div className="pt-1">
          <div className="text-[11px] uppercase tracking-wide text-white/40">Recent alerts</div>
          <div className="mt-1 space-y-1">
            {state.recentAlerts.slice(0, 6).map((a) => (
              <div key={a.id} className="flex items-start gap-1.5 text-[11px] leading-snug">
                <Zap className={cn('mt-0.5 size-3 shrink-0', a.state === 'firing' ? 'text-destructive' : 'text-success')} />
                <span className="min-w-0 flex-1 text-white/70">{a.message}</span>
                <span className="shrink-0 text-white/35">{timeAgo(a.at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
