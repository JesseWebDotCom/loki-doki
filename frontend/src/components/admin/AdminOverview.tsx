import { useEffect, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Users, HardDrive, Brain, Wifi, WifiOff, Activity, ChevronRight,
  Sparkles, Store, ShieldCheck, LayoutGrid, Settings2, Loader2,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useServerHealth } from '@/context/ServerHealthContext'

interface UserRow { id: string; role: 'admin' | 'user' }
interface MemRow { memories: number; entities: number; episodes: number }
interface StorageStatus { totalFormatted: string; appTotalFormatted?: string; freeFormatted: string | null }
interface Connectivity { globalMode: string; allowDownloads: boolean }

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

function StatCard({ icon: Icon, label, value, sub, tone }: {
  icon: LucideIcon
  label: string
  value: React.ReactNode
  sub?: string
  tone?: 'default' | 'good' | 'warn'
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className={cn('size-4',
          tone === 'good' ? 'text-emerald-500' : tone === 'warn' ? 'text-amber-500' : 'text-muted-foreground')} />
        {label}
      </div>
      <div className="mt-2 text-2xl font-bold tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </Card>
  )
}

function QuickAction({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-card px-3.5 py-3 text-left text-sm transition-colors hover:border-brand/40 hover:bg-foreground/[0.03]"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex-1 font-medium">{label}</span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  )
}

export function AdminOverview({ onNavigate }: { onNavigate: (sectionId: string, subId?: string) => void }) {
  const { reachable } = useServerHealth()
  const [stats, setStats] = useState<Stats | null>(null)
  const [storage, setStorage] = useState<StorageStats | null>(null)

  useEffect(() => {
    let cancelled = false

    // Fast fetches — resolve together, render immediately
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

    // Slow fetch — directory walk can take seconds; arrives whenever it's ready
    getJSON<StorageStatus>('/api/admin/storage').then((s) => {
      if (cancelled) return
      setStorage({
        storageUsed: s?.appTotalFormatted ?? s?.totalFormatted ?? '—',
        storageFree: s?.freeFormatted ?? null,
      })
    })

    return () => { cancelled = true }
  }, [])

  return (
    <div className="space-y-6 p-5">
      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats ? (
          <>
            <StatCard icon={Users} label="Users" value={stats.users}
              sub={`${stats.admins} admin${stats.admins === 1 ? '' : 's'}`} />
            <Card className="p-4">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <HardDrive className="size-4 text-muted-foreground" />
                Storage used
              </div>
              {storage ? (
                <>
                  <div className="mt-2 text-2xl font-bold tracking-tight">{storage.storageUsed}</div>
                  {storage.storageFree && (
                    <div className="mt-0.5 text-xs text-muted-foreground">{storage.storageFree} free</div>
                  )}
                </>
              ) : (
                <div className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
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
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-600 dark:text-amber-400">
          <WifiOff className="mt-0.5 size-4 shrink-0" />
          <span>Global offline mode is active. Internet features are disabled for users.</span>
        </div>
      )}

      {/* Quick actions */}
      <div className="space-y-2.5">
        <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
          <Wifi className="size-4 text-muted-foreground" /> Quick actions
        </h2>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          <QuickAction icon={Users} label="Manage users" onClick={() => onNavigate('users', 'accounts')} />
          <QuickAction icon={Sparkles} label="Companions & briefing" onClick={() => onNavigate('companions', 'characters')} />
          <QuickAction icon={Store} label="Apps & install requests" onClick={() => onNavigate('apps', 'requests')} />
          <QuickAction icon={LayoutGrid} label="Features & models" onClick={() => onNavigate('features', 'chat')} />
          <QuickAction icon={ShieldCheck} label="Security" onClick={() => onNavigate('security', 'styles')} />
          <QuickAction icon={Settings2} label="System & connectivity" onClick={() => onNavigate('system', 'connectivity')} />
        </div>
      </div>
    </div>
  )
}
