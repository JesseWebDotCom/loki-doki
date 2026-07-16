import { useEffect, useState } from 'react'
import { Battery, Cpu, HardDrive, MemoryStick, Zap, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { timeAgo } from '@/lib/notifications'
import type { ResourceState } from '@/types/desktop'

// System page of the island panel: live ring gauges for the machine Doki Dock
// runs on (CPU / memory / disk / battery from desktop/src/resources.js) plus
// the recent threshold alerts. Read-only glance; thresholds live in Settings.

const POLL_MS = 10_000

type Tone = 'ok' | 'warn' | 'bad'

const RING_TONE: Record<Tone, string> = {
  ok: 'text-success',
  warn: 'text-warning',
  bad: 'text-destructive',
}

function Ring({ pct, tone, children }: { pct: number | null; tone: Tone; children: React.ReactNode }) {
  const R = 24
  const C = 2 * Math.PI * R
  const shown = pct != null ? Math.min(100, Math.max(0, pct)) : 0
  return (
    <div className="relative size-14 shrink-0">
      <svg viewBox="0 0 56 56" className="size-14 -rotate-90">
        {/* design-ok(glass-on-plain-bg): gauge track inside the black island surface */}
        <circle cx="28" cy="28" r={R} fill="none" strokeWidth="5" className="stroke-white/10" />
        {pct != null && (
          <circle
            cx="28" cy="28" r={R} fill="none" strokeWidth="5" strokeLinecap="round"
            strokeDasharray={`${(C * shown) / 100} ${C}`}
            className={cn('stroke-current transition-[stroke-dasharray] duration-700', RING_TONE[tone])}
          />
        )}
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold tabular-nums text-white/90">
        {children}
      </span>
    </div>
  )
}

function MetricCard({ icon: Icon, label, pct, tone, value, hint }: {
  icon: LucideIcon
  label: string
  /** 0-100 ring fill; meaning depends on the metric (usage, fullness, charge). */
  pct: number | null
  tone: Tone
  value: React.ReactNode
  hint?: string
}) {
  return (
    <div className={cn(
      'flex flex-col items-center gap-1 rounded-[14px] px-2 py-2.5 text-center',
      // design-ok(glass-on-plain-bg): metric card inside the black island surface
      tone === 'bad' ? 'bg-destructive/15 ring-1 ring-inset ring-destructive/30' : 'bg-white/[0.06]',
    )}>
      <Ring pct={pct} tone={tone}>{value}</Ring>
      <span className="flex items-center gap-1 text-[11px] font-semibold text-white/85">
        <Icon className="size-3 text-white/45" />
        {label}
      </span>
      {hint && <span className="text-[10px] leading-tight text-white/40">{hint}</span>}
    </div>
  )
}

function usageTone(pct: number | null, firing: boolean): Tone {
  if (firing) return 'bad'
  return pct != null && pct >= 75 ? 'warn' : 'ok'
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
  const allClear = state.firing.length === 0

  const batteryTone: Tone = firing.has('battery') ? 'bad'
    : !s.battery?.charging && (s.battery?.percent ?? 100) <= 20 ? 'warn' : 'ok'

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto">
      <div className="flex items-baseline justify-between pt-1">
        <span className="text-[11px] uppercase tracking-wide text-white/40">{state.hostname}</span>
        {!state.enabled
          ? <span className="text-[11px] text-warning">monitoring off</span>
          : <span className={cn('flex items-center gap-1.5 text-[11px]', allClear ? 'text-white/40' : 'text-destructive')}>
              <span className={cn('size-1.5 rounded-full', allClear ? 'bg-success' : 'bg-destructive')} />
              {allClear ? 'All systems normal' : `${state.firing.length} alert${state.firing.length === 1 ? '' : 's'} firing`}
            </span>}
      </div>

      <div className={cn('grid gap-2.5', s.battery ? 'grid-cols-4' : 'grid-cols-3')}>
        <MetricCard
          icon={Cpu}
          label="Processor"
          pct={s.cpuPct}
          tone={usageTone(s.cpuPct, firing.has('cpu'))}
          value={s.cpuPct != null ? `${s.cpuPct}%` : '–'}
          hint={`${s.cpuCount} cores · load ${s.loadAvg1m.toFixed(1)}`}
        />
        <MetricCard
          icon={MemoryStick}
          label="Memory"
          pct={s.memUsedPct}
          tone={usageTone(s.memUsedPct, firing.has('memory'))}
          value={s.memUsedPct != null ? `${s.memUsedPct}%` : '–'}
          hint={`${s.memFreeGb} GB free of ${s.memTotalGb} GB`}
        />
        <MetricCard
          icon={HardDrive}
          label="Disk"
          pct={diskUsedPct}
          tone={usageTone(diskUsedPct, firing.has('disk'))}
          value={diskUsedPct != null ? `${diskUsedPct}%` : '–'}
          hint={s.diskFreeGb != null ? `${s.diskFreeGb} GB free` : undefined}
        />
        {s.battery && (
          <MetricCard
            icon={Battery}
            label="Battery"
            pct={s.battery.percent}
            tone={batteryTone}
            value={`${s.battery.percent}%`}
            hint={s.battery.charging ? 'Charging' : 'On battery'}
          />
        )}
      </div>

      {state.recentAlerts.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wide text-white/40">Recent alerts</div>
          <div className="mt-1 space-y-1">
            {state.recentAlerts.slice(0, 4).map((a) => (
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
