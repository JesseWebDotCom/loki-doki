// Price history chart — hand-rolled inline SVG (the SpeedTestPage precedent; no chart
// dependency in this app). Step-after interpolation because a price holds until the next
// observation; out-of-stock stretches render as gaps. One colored series per retailer
// listing, with an optional dashed rule line for a watch target.

import { useMemo, useState } from 'react'
import { cn } from '@/lib/cn'

export interface ChartSeries {
  listingId: string
  retailer: string
  retailerLabel: string
  points: { t: number; p: number | null; inStock?: boolean }[]
}

export const RETAILER_COLORS: Record<string, string> = {
  amazon: '#f59e0b',
  walmart: '#2563eb',
  target: '#dc2626',
  homedepot: '#ea580c',
  lowes: '#0369a1',
  bestbuy: '#eab308',
  ebay: '#7c3aed',
  apple: '#a1a1aa',
  costco: '#e11d48',
  bjs: '#f97316',
  generic: '#10b981',
}

const RANGES = [
  { key: '1M', days: 30 },
  { key: '3M', days: 90 },
  { key: '1Y', days: 365 },
  { key: 'All', days: 3650 },
] as const

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`
}

export function PriceChart({ series, targetCents }: { series: ChartSeries[]; targetCents?: number | null }) {
  const [range, setRange] = useState<(typeof RANGES)[number]['key']>('3M')

  const { paths, min, max, from, to, empty } = useMemo(() => {
    const days = RANGES.find(r => r.key === range)!.days
    const to = Date.now()
    const from = to - days * 86_400_000
    const clipped = series.map(s => ({ ...s, points: s.points.filter(pt => pt.t >= from) }))
    const prices = clipped.flatMap(s => s.points.map(pt => pt.p)).filter((p): p is number => p != null)
    if (targetCents != null) prices.push(targetCents)
    if (!prices.length) return { paths: [], min: 0, max: 0, from, to, empty: true }
    let min = Math.min(...prices)
    let max = Math.max(...prices)
    if (min === max) { min -= 100; max += 100 }
    const pad = (max - min) * 0.08
    min -= pad; max += pad

    const W = 600
    const H = 180
    const x = (t: number) => ((t - from) / (to - from)) * W
    const y = (p: number) => H - ((p - min) / (max - min)) * H

    const paths = clipped.map(s => {
      let d = ''
      let prev: { t: number; p: number | null } | null = null
      for (const pt of s.points) {
        if (pt.p == null) { prev = pt; continue } // OOS → break the line
        if (prev == null || prev.p == null) {
          d += `M${x(pt.t).toFixed(1)},${y(pt.p).toFixed(1)}`
        } else {
          // step-after: hold the previous price until this observation
          d += `H${x(pt.t).toFixed(1)}V${y(pt.p).toFixed(1)}`
        }
        prev = pt
      }
      // Extend the last known price to "now".
      if (prev && prev.p != null) d += `H${W}`
      const last = [...s.points].reverse().find(pt => pt.p != null)
      return { ...s, d, lastPrice: last?.p ?? null, lastY: last?.p != null ? y(last.p) : null }
    })
    return { paths, min, max, from, to, empty: false }
  }, [series, range, targetCents])

  const W = 600
  const H = 180
  const yFor = (p: number) => H - ((p - min) / (max - min)) * H

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap items-center gap-3">
          {series.map(s => (
            <span key={s.listingId} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="size-2 rounded-full" style={{ background: RETAILER_COLORS[s.retailer] ?? '#10b981' }} />
              {s.retailerLabel}
            </span>
          ))}
        </div>
        <div className="flex gap-1">
          {RANGES.map(r => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={cn(
                'rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors',
                range === r.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {r.key}
            </button>
          ))}
        </div>
      </div>

      {empty ? (
        <div className="flex h-[120px] items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">
          No price history in this range yet — it builds as checks run.
        </div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" role="img" aria-label="Price history chart">
            {/* min/max gridlines */}
            {[min, (min + max) / 2, max].map((v, i) => (
              <line key={i} x1={0} x2={W} y1={yFor(v)} y2={yFor(v)} stroke="currentColor" strokeOpacity={0.08} strokeWidth={1} />
            ))}
            {targetCents != null && targetCents >= min && targetCents <= max && (
              <line x1={0} x2={W} y1={yFor(targetCents)} y2={yFor(targetCents)} stroke="#10b981" strokeDasharray="6 4" strokeWidth={1.5} strokeOpacity={0.7} />
            )}
            {paths.map(p => (
              <path key={p.listingId} d={p.d} fill="none" stroke={RETAILER_COLORS[p.retailer] ?? '#10b981'} strokeWidth={2} vectorEffect="non-scaling-stroke" />
            ))}
          </svg>
          <div className="pointer-events-none absolute inset-y-0 left-1 flex flex-col justify-between py-0.5 text-[10px] text-muted-foreground/70">
            <span>{fmt(Math.round(max))}</span>
            <span>{fmt(Math.round(min))}</span>
          </div>
        </div>
      )}
      <div className="flex justify-between text-[10px] text-muted-foreground/60">
        <span>{new Date(from).toLocaleDateString()}</span>
        <span>{new Date(to).toLocaleDateString()}</span>
      </div>
    </div>
  )
}

/** Tiny inline sparkline for tracked-list cards. */
export function Sparkline({ points, color = '#10b981' }: { points: { t: number; p: number | null }[]; color?: string }) {
  const d = useMemo(() => {
    const priced = points.filter((pt): pt is { t: number; p: number } => pt.p != null)
    if (priced.length < 2) return null
    const min = Math.min(...priced.map(p => p.p))
    const max = Math.max(...priced.map(p => p.p))
    const t0 = priced[0]!.t
    const t1 = priced[priced.length - 1]!.t
    if (t1 === t0) return null
    const x = (t: number) => ((t - t0) / (t1 - t0)) * 80
    const y = (p: number) => (max === min ? 10 : 20 - ((p - min) / (max - min)) * 16 - 2)
    let path = `M${x(priced[0]!.t).toFixed(1)},${y(priced[0]!.p).toFixed(1)}`
    for (const pt of priced.slice(1)) path += `H${x(pt.t).toFixed(1)}V${y(pt.p).toFixed(1)}`
    return path
  }, [points])
  if (!d) return null
  return (
    <svg viewBox="0 0 80 20" className="h-5 w-20" preserveAspectRatio="none" aria-hidden>
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
