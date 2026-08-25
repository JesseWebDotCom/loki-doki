// The server wall: monitoring state, integration health tiles, a big clock,
// and an on-watch timer. Panels that the viewer cannot see (admin-only data)
// simply stay hidden.

import { useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, Server } from 'lucide-react'
import { StatusDot, type StatusDotStatus } from '@/components/shared/StatusDot'
import type { TvScreenProps } from './index'
import { ScreenFrame, StatusPanel, getJson, useTick } from './shared'

type IntegrationState = 'connected' | 'configured' | 'not_configured' | 'error'

interface IntegrationRow {
  id: string
  state: IntegrationState
  url: string | null
  detail: string | null
  error: string | null
}

const DOT_FOR_STATE: Record<IntegrationState, StatusDotStatus> = {
  connected: 'ok',
  configured: 'info',
  not_configured: 'off',
  error: 'error',
}

const STATE_LABEL: Record<IntegrationState, string> = {
  connected: 'Connected',
  configured: 'Configured',
  not_configured: 'Not configured',
  error: 'Unreachable',
}

function tileName(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1).replace(/[-_]/g, ' ')
}

function elapsedLabel(sinceMs: number, now: number): string {
  const total = Math.max(0, Math.floor((now - sinceMs) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

export function NocScreen({ channel, title, subtitle }: TvScreenProps) {
  const now = useTick(1_000)
  const wentOnAirAt = useRef(Date.now())

  const monitoring = useQuery({
    queryKey: ['maipaitv', 'noc', 'monitoring'],
    queryFn: () => getJson<{ enabled: boolean }>('/api/monitoring/status'),
    refetchInterval: 60_000,
    retry: 1,
  })
  // Admin-only aggregate: non-admin viewers get a 403 and the panel hides.
  const integrations = useQuery({
    queryKey: ['maipaitv', 'noc', 'integrations'],
    queryFn: () => getJson<{ rows: IntegrationRow[] }>('/api/integrations/status'),
    refetchInterval: 60_000,
    retry: false,
  })

  const rows = integrations.data?.rows ?? []
  const nothingToShow = monitoring.isError && (integrations.isError || rows.length === 0)

  if (nothingToShow) {
    return (
      <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel channel={channel} icon={Server} headline="The control room is quiet" note="Waiting for data" />
      </ScreenFrame>
    )
  }

  return (
    <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
      <div className="flex h-full flex-col gap-6">
        <div className="flex items-center justify-between gap-8 rounded-sheet border border-border/50 bg-card/40 px-10 py-6">
          <div>
            <p className="text-6xl font-bold tracking-tight tabular-nums">
              {new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
            </p>
            <p className="mt-1 text-xl text-muted-foreground">
              {new Date(now).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm font-bold uppercase tracking-[0.3em] text-muted-foreground">On watch</p>
            <p className="mt-1 text-4xl font-semibold tabular-nums" style={{ color: channel.color }}>
              {elapsedLabel(wentOnAirAt.current, now)}
            </p>
          </div>
        </div>

        {!monitoring.isError ? (
          <div className="flex shrink-0 items-center gap-4 rounded-card border border-border/50 bg-card/50 px-7 py-5">
            <Activity className="size-7" style={{ color: channel.color }} />
            <p className="text-2xl font-semibold">Uptime monitoring</p>
            <span className="ml-auto flex items-center gap-3 text-xl">
              <StatusDot status={monitoring.data?.enabled ? 'ok' : 'off'} className="size-3" />
              <span className="text-muted-foreground">
                {monitoring.isPending ? 'Checking' : monitoring.data?.enabled ? 'Reporting' : 'Not configured'}
              </span>
            </span>
          </div>
        ) : null}

        {rows.length > 0 ? (
          <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-3 gap-4 overflow-hidden xl:grid-cols-4">
            {rows.map((r) => (
              <div key={r.id} className="flex items-center gap-4 rounded-card border border-border/50 bg-card/50 px-6 py-5">
                <StatusDot status={DOT_FOR_STATE[r.state]} className="size-3.5" />
                <div className="min-w-0">
                  <p className="truncate text-xl font-semibold">{tileName(r.id)}</p>
                  <p className="truncate text-base text-muted-foreground">
                    {STATE_LABEL[r.state]}
                    {r.detail ? <span className="ml-2">{r.detail}</span> : null}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center rounded-sheet border border-border/50 bg-card/30">
            <p className="text-xl text-muted-foreground">
              {integrations.isPending ? 'Scanning integrations' : 'Integration details are visible to admins'}
            </p>
          </div>
        )}
      </div>
    </ScreenFrame>
  )
}
