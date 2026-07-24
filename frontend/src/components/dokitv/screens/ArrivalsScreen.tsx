// Package arrivals board, styled like an airport arrivals wall: monospace
// rows of vendor, item, tracking, and a status pill per delivery.

import { useQuery } from '@tanstack/react-query'
import { PackageCheck } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { TvScreenProps } from './index'
import { ScreenFrame, StatusPanel, dateLabel, getJson, isFeatureOff, retryUnlessOff, toMs } from './shared'

interface Delivery {
  id: string
  vendor: string
  title: string | null
  trackingNumber: string | null
  status: string | null
  eventDate: number | string
  member?: string
}

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  delivered: { label: 'Delivered', className: 'bg-success/15 text-success' },
  out_for_delivery: { label: 'Out for delivery', className: 'bg-warning/15 text-warning' },
  shipped: { label: 'Shipped', className: 'bg-info/15 text-info' },
}

function statusPill(status: string | null): { label: string; className: string } {
  if (status && STATUS_STYLES[status]) return STATUS_STYLES[status]
  const label = status ? status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'In transit'
  return { label, className: 'bg-muted text-muted-foreground' }
}

export function ArrivalsScreen({ channel, title, subtitle }: TvScreenProps) {
  const deliveries = useQuery({
    queryKey: ['dokitv', 'arrivals'],
    queryFn: () => getJson<{ deliveries: Delivery[] }>('/api/icloud/ledger/deliveries'),
    refetchInterval: 5 * 60_000,
    retry: retryUnlessOff,
  })

  if (deliveries.isError) {
    const off = isFeatureOff(deliveries.error)
    return (
      <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel
          channel={channel}
          icon={PackageCheck}
          headline={off ? 'Connect iCloud Mail to see deliveries' : 'The arrivals board is dark'}
          note={off ? 'Delivery emails become arrivals once mail is connected' : 'We could not load deliveries'}
        />
      </ScreenFrame>
    )
  }
  if (deliveries.isPending) {
    return (
      <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel channel={channel} icon={PackageCheck} headline="Checking the manifest" note="Waiting for data" />
      </ScreenFrame>
    )
  }

  const rows = deliveries.data.deliveries.slice(0, 12)
  if (rows.length === 0) {
    return (
      <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel channel={channel} icon={PackageCheck} headline="No packages in flight" note="New deliveries will land on the board automatically" />
      </ScreenFrame>
    )
  }

  return (
    <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
      <div className="flex h-full flex-col overflow-hidden rounded-sheet border border-border/50 bg-card/40 font-mono">
        <div className="grid shrink-0 grid-cols-[7rem_11rem_1fr_10rem_13rem] items-center gap-4 border-b border-border/60 px-7 py-4 text-sm font-bold uppercase tracking-[0.25em] text-muted-foreground">
          <span>Date</span>
          <span>Carrier</span>
          <span>Item</span>
          <span>Tracking</span>
          <span className="text-right">Status</span>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {rows.map((d, i) => {
            const pill = statusPill(d.status)
            const at = toMs(d.eventDate)
            return (
              <div
                key={d.id}
                className={cn(
                  'grid grid-cols-[7rem_11rem_1fr_10rem_13rem] items-center gap-4 px-7 py-4',
                  i % 2 === 1 && 'bg-card/50',
                )}
              >
                <span className="text-lg text-muted-foreground tabular-nums">{at != null ? dateLabel(at) : '--'}</span>
                <span className="truncate text-xl font-bold" style={{ color: channel.color }}>{d.vendor}</span>
                <span className="truncate text-xl">{d.title ?? 'Package'}</span>
                <span className="truncate text-lg text-muted-foreground">
                  {d.trackingNumber ? `..${d.trackingNumber.slice(-8)}` : '--'}
                </span>
                <span className="flex justify-end">
                  <span className={cn('rounded-full px-4 py-1.5 text-base font-bold uppercase tracking-wider', pill.className)}>
                    {pill.label}
                  </span>
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </ScreenFrame>
  )
}
