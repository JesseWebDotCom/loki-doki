// The admin front door: at-a-glance stats, a "needs attention" list built from live
// signals (pending install requests, unreachable integrations, feature install
// failures), and a directory of every admin section driven by the registry, so it
// can never drift from the sidebar.

import { useEffect, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Users, HardDrive, Brain, WifiOff, Activity, ChevronRight, TriangleAlert, Inbox, PlugZap,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useServerHealth } from '@/context/ServerHealthContext'
import { orderedSections } from '@/components/admin/adminRegistry'

interface UserRow { id: string; role: 'admin' | 'user' }
interface MemRow { memories: number; entities: number; episodes: number }
interface StorageStatus { totalFormatted: string; appTotalFormatted?: string; freeFormatted: string | null }
interface Connectivity { globalMode: string; allowDownloads: boolean }
interface NotificationRow { id: string; type: string; readAt: string | null }
interface IntegrationRow { id: string; state: string; error: string | null }
interface FeatureRow { id: string; label: string; state: string }

async function getJSON<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { credentials: 'include' })
    return r.ok ? (await r.json() as T) : null
  } catch { return null }
}

interface Stats {
  users: number
  admins: number
  memories: number
  offline: boolean
}

interface StorageStats {
  storageUsed: string
  storageFree: string | null
}

interface AttentionItem {
  key: string
  icon: LucideIcon
  text: string
  go: () => void
}

function StatCard({ icon: Icon, label, value, sub, tone }: {
  icon: LucideIcon
  label: string
  value: React.ReactNode
  sub?: string
  tone?: 'default' | 'good' | 'warn'
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-caption text-muted-foreground">
        <Icon className={cn('size-4',
          tone === 'good' ? 'text-success' : tone === 'warn' ? 'text-warning' : 'text-muted-foreground')} />
        {label}
      </div>
      <div className="mt-2 text-2xl font-bold tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 text-caption text-muted-foreground">{sub}</div>}
    </Card>
  )
}

export function AdminOverview({ onNavigate }: { onNavigate: (sectionId: string, subId?: string) => void }) {
  const { reachable } = useServerHealth()
  const [stats, setStats] = useState<Stats | null>(null)
  const [storage, setStorage] = useState<StorageStats | null>(null)
  const [attention, setAttention] = useState<AttentionItem[] | null>(null)

  useEffect(() => {
    let cancelled = false

    // Fast fetches: resolve together, render immediately
    Promise.all([
      getJSON<UserRow[]>('/api/users'),
      getJSON<MemRow[]>('/api/admin/memory'),
      getJSON<Connectivity>('/api/admin/connectivity'),
    ]).then(([users, mem, conn]) => {
      if (cancelled) return
      setStats({
        users: users?.length ?? 0,
        admins: users?.filter(u => u.role === 'admin').length ?? 0,
        memories: (mem ?? []).reduce((n, m) => n + m.memories, 0),
        offline: conn?.globalMode === 'offline',
      })
    })

    // Needs-attention signals (all cheap reads; each degrades to absent on failure).
    Promise.all([
      getJSON<{ notifications: NotificationRow[] } | NotificationRow[]>('/api/notifications'),
      getJSON<{ rows: IntegrationRow[] }>('/api/integrations/status'),
      getJSON<{ features: FeatureRow[] }>('/api/features'),
    ]).then(([notifRaw, integ, feat]) => {
      if (cancelled) return
      const items: AttentionItem[] = []
      const notifications = Array.isArray(notifRaw) ? notifRaw : notifRaw?.notifications ?? []
      const pending = notifications.filter((n) => n.type === 'install_request' && !n.readAt).length
      if (pending > 0) {
        items.push({
          key: 'requests', icon: Inbox,
          text: `${pending} pending app install request${pending === 1 ? '' : 's'}`,
          go: () => onNavigate('apps', 'requests'),
        })
      }
      for (const row of integ?.rows ?? []) {
        if (row.state !== 'error') continue
        items.push({
          key: `integration-${row.id}`, icon: PlugZap,
          text: `Integration "${row.id}" is unreachable${row.error ? `: ${row.error}` : ''}`,
          go: () => onNavigate('integrations', 'overview'),
        })
      }
      for (const f of feat?.features ?? []) {
        if (f.state !== 'error') continue
        items.push({
          key: `feature-${f.id}`, icon: TriangleAlert,
          text: `${f.label} needs attention (an install failed)`,
          go: () => onNavigate('features'),
        })
      }
      setAttention(items)
    })

    // Slow fetch: directory walk can take seconds; arrives whenever it's ready
    getJSON<StorageStatus>('/api/admin/storage').then((s) => {
      if (cancelled) return
      setStorage({
        storageUsed: s?.appTotalFormatted ?? s?.totalFormatted ?? '–',
        storageFree: s?.freeFormatted ?? null,
      })
    })

    return () => { cancelled = true }
  }, [onNavigate])

  // Registry-driven directory, grouped exactly like the sidebar.
  const groups: { name: string; sections: ReturnType<typeof orderedSections> }[] = []
  for (const section of orderedSections()) {
    if (section.id === 'overview') continue
    const name = section.group ?? 'Other'
    const g = groups.find((x) => x.name === name)
    if (g) g.sections.push(section)
    else groups.push({ name, sections: [section] })
  }

  return (
    <div className="space-y-6 p-5">
      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats ? (
          <>
            <StatCard icon={Users} label="Users" value={stats.users}
              sub={`${stats.admins} admin${stats.admins === 1 ? '' : 's'}`} />
            <Card className="p-4">
              <div className="flex items-center gap-2 text-caption text-muted-foreground">
                <HardDrive className="size-4 text-muted-foreground" />
                Storage used
              </div>
              {storage ? (
                <>
                  <div className="mt-2 text-2xl font-bold tracking-tight">{storage.storageUsed}</div>
                  {storage.storageFree && (
                    <div className="mt-0.5 text-caption text-muted-foreground">{storage.storageFree} free</div>
                  )}
                </>
              ) : (
                <div className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Spinner size="sm" className="text-current" />
                  Calculating…
                </div>
              )}
            </Card>
            <StatCard icon={Brain} label="Memories" value={stats.memories.toLocaleString()}
              sub="across all users" />
            <StatCard
              icon={reachable ? Activity : WifiOff}
              label="Server"
              value={reachable ? 'Healthy' : 'Unreachable'}
              sub={stats.offline ? 'Offline mode on' : 'Online'}
              tone={reachable ? 'good' : 'warn'}
            />
          </>
        ) : (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="p-4">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="mt-3 h-7 w-16" />
              <Skeleton className="mt-2 h-3 w-24" />
            </Card>
          ))
        )}
      </div>

      {/* Connectivity banner mirror */}
      {stats?.offline && (
        <div className="flex items-start gap-3 rounded-card border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          <WifiOff className="mt-0.5 size-4 shrink-0" />
          <span>Global offline mode is active. Internet features are disabled for users.</span>
        </div>
      )}

      {/* Needs attention (only when something does) */}
      {attention !== null && attention.length > 0 && (
        <div className="space-y-2.5">
          <h2 className="flex items-center gap-2 text-section">
            <TriangleAlert className="size-4 text-warning" /> Needs attention
          </h2>
          <div className="space-y-2">
            {attention.map((item) => {
              const Icon = item.icon
              return (
                <Card key={item.key} variant="interactive" onClick={item.go}
                  className="flex items-center gap-3 px-4 py-3 text-sm">
                  <Icon className="size-4 shrink-0 text-warning" />
                  <span className="min-w-0 flex-1 truncate">{item.text}</span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </Card>
              )
            })}
          </div>
        </div>
      )}

      {/* Directory: every admin section, grouped like the sidebar */}
      <div className="space-y-4">
        {groups.map((group) => (
          <div key={group.name} className="space-y-2">
            <p className="text-overline text-muted-foreground/60">{group.name}</p>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {group.sections.map((section) => {
                const Icon = section.icon
                return (
                  <Card key={section.id} variant="interactive" onClick={() => onNavigate(section.id)}
                    className="flex items-start gap-2.5 px-3.5 py-3 text-left">
                    <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{section.label}</span>
                      {section.description && (
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{section.description}</span>
                      )}
                    </span>
                    <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  </Card>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
