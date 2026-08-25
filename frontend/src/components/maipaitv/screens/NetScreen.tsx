// Live network health: client-measured round-trip latency every 5 seconds,
// a sparkline of recent samples, and a plain-English status word.

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Gauge } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { TvScreenProps } from './index'
import { HttpError, ScreenFrame, StatusPanel, getJson } from './shared'

interface PingSample { at: number; ms: number }
interface SpeedThresholds { goodMbps: number; okMbps: number }

const MAX_SAMPLES = 60

function statusForLatency(ms: number): { word: string; className: string } {
  if (ms < 60) return { word: 'Good', className: 'text-success' }
  if (ms < 150) return { word: 'Okay', className: 'text-warning' }
  return { word: 'Poor', className: 'text-destructive' }
}

function Sparkline({ samples, color }: { samples: PingSample[]; color: string }) {
  const w = 600
  const h = 150
  const max = Math.max(200, ...samples.map((s) => s.ms))
  const step = samples.length > 1 ? w / (samples.length - 1) : w
  const points = samples
    .map((s, i) => `${(i * step).toFixed(1)},${(h - (s.ms / max) * h).toFixed(1)}`)
    .join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-full w-full">
      {[50, 100, 150].map((ms) => (
        <line
          key={ms}
          x1={0}
          x2={w}
          y1={h - (ms / max) * h}
          y2={h - (ms / max) * h}
          className="stroke-border/60"
          strokeWidth={1}
          strokeDasharray="4 6"
        />
      ))}
      {samples.length > 1 ? (
        <polyline points={points} fill="none" stroke={color} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
      ) : null}
    </svg>
  )
}

export function NetScreen({ channel, title, subtitle }: TvScreenProps) {
  const [samples, setSamples] = useState<PingSample[]>([])

  const ping = useQuery({
    queryKey: ['maipaitv', 'net', 'ping'],
    queryFn: async () => {
      const t0 = performance.now()
      const r = await fetch('/api/speedtest/ping', { credentials: 'include', cache: 'no-store' })
      if (!r.ok) throw new HttpError(r.status)
      return { at: Date.now(), ms: Math.round(performance.now() - t0) }
    },
    refetchInterval: 5_000,
    gcTime: 0,
    retry: false,
  })

  useEffect(() => {
    const sample = ping.data
    if (!sample) return
    setSamples((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].at === sample.at) return prev
      return [...prev.slice(-(MAX_SAMPLES - 1)), sample]
    })
  }, [ping.data])

  const thresholds = useQuery({
    queryKey: ['maipaitv', 'net', 'thresholds'],
    queryFn: () => getJson<SpeedThresholds>('/api/admin/speedtest'),
    refetchInterval: 30 * 60_000,
    retry: false,
  })

  if (samples.length === 0 && ping.isError) {
    return (
      <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel channel={channel} icon={Gauge} headline="The network is not responding" note="We will keep trying every few seconds" />
      </ScreenFrame>
    )
  }
  if (samples.length === 0) {
    return (
      <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel channel={channel} icon={Gauge} headline="Measuring the line" note="Waiting for data" />
      </ScreenFrame>
    )
  }

  const latest = samples[samples.length - 1]
  const recent = samples.slice(-12)
  const avg = Math.round(recent.reduce((sum, s) => sum + s.ms, 0) / recent.length)
  const jitter = recent.length > 1 ? Math.max(...recent.map((s) => s.ms)) - Math.min(...recent.map((s) => s.ms)) : 0
  const status = statusForLatency(avg)

  return (
    <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
      <div className="flex h-full flex-col gap-6">
        <div className="flex items-end justify-between gap-8">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.3em] text-muted-foreground">Round trip to the hub</p>
            <p className="mt-2 text-[8rem] font-bold leading-none tracking-tighter tabular-nums">
              {latest.ms}
              <span className="ml-3 align-baseline text-4xl font-semibold text-muted-foreground">ms</span>
            </p>
          </div>
          <div className="pb-3 text-right">
            <p className={cn('text-6xl font-bold tracking-tight', status.className)}>{status.word}</p>
            {ping.isError ? <p className="mt-2 text-lg text-destructive">Last check failed, retrying</p> : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 rounded-sheet border border-border/50 bg-card/40 p-6">
          <Sparkline samples={samples} color={channel.color} />
        </div>

        <div className="grid shrink-0 grid-cols-3 gap-4">
          <div className="rounded-card border border-border/50 bg-card/50 px-6 py-4">
            <p className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Average</p>
            <p className="mt-1 text-4xl font-bold tabular-nums">{avg} <span className="text-xl text-muted-foreground">ms</span></p>
          </div>
          <div className="rounded-card border border-border/50 bg-card/50 px-6 py-4">
            <p className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Jitter</p>
            <p className="mt-1 text-4xl font-bold tabular-nums">{jitter} <span className="text-xl text-muted-foreground">ms</span></p>
          </div>
          <div className="rounded-card border border-border/50 bg-card/50 px-6 py-4">
            <p className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Speed targets</p>
            <p className="mt-1 text-2xl font-semibold">
              {thresholds.data
                ? `Good over ${thresholds.data.goodMbps} Mbps, okay over ${thresholds.data.okMbps}`
                : `${samples.length} samples collected`}
            </p>
          </div>
        </div>
      </div>
    </ScreenFrame>
  )
}
