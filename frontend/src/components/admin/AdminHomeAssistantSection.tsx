import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw, Plus, X, Check, Lock } from 'lucide-react'
import { cn } from '@/lib/cn'

interface HAUser { id: string; nickname?: string; firstName?: string }
interface Grant { domain: string; areaId: string }
interface Area { id: string; name: string }
interface Status {
  configured: boolean
  connected?: boolean
  entities?: number
  areas?: number
  lastSyncMs?: number | null
  lastError?: string | null
}

const ALL = '*'
// Pseudo-domain for locks + entry doors — never covered by 'All devices'.
const SECURITY = 'security'

function timeAgo(ms: number | null | undefined): string {
  if (!ms) return 'never'
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

export function AdminHomeAssistantSection({ users }: { users: HAUser[] }) {
  const [status, setStatus]   = useState<Status | null>(null)
  const [areas, setAreas]     = useState<Area[]>([])
  const [domains, setDomains] = useState<string[]>([])
  const [grants, setGrants]   = useState<Record<string, Grant[]>>({})
  const [syncing, setSyncing] = useState(false)
  const [savingUser, setSavingUser] = useState<Record<string, boolean>>({})
  const [savedUser, setSavedUser]   = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    const [st, cat, gr] = await Promise.all([
      fetch('/api/admin/home-assistant/status', { credentials: 'include' }).then(r => r.json()).catch(() => null),
      fetch('/api/admin/home-assistant/catalog', { credentials: 'include' }).then(r => r.json()).catch(() => null),
      fetch('/api/admin/home-assistant/grants', { credentials: 'include' }).then(r => r.json()).catch(() => ({})),
    ])
    setStatus(st)
    if (cat) { setAreas(cat.areas ?? []); setDomains(cat.domains ?? []) }
    setGrants(gr ?? {})
  }, [])

  useEffect(() => { void load() }, [load])

  async function sync() {
    setSyncing(true)
    await fetch('/api/admin/home-assistant/sync', { method: 'POST', credentials: 'include' }).catch(() => {})
    await load()
    setSyncing(false)
  }

  function setUserGrants(userId: string, next: Grant[]) {
    setGrants(prev => ({ ...prev, [userId]: next }))
    setSavedUser(prev => ({ ...prev, [userId]: false }))
  }
  function addGrant(userId: string) {
    setUserGrants(userId, [...(grants[userId] ?? []), { domain: ALL, areaId: ALL }])
  }
  function addSecurityGrant(userId: string) {
    setUserGrants(userId, [...(grants[userId] ?? []), { domain: SECURITY, areaId: ALL }])
  }
  function updateGrant(userId: string, idx: number, patch: Partial<Grant>) {
    setUserGrants(userId, (grants[userId] ?? []).map((g, i) => i === idx ? { ...g, ...patch } : g))
  }
  function removeGrant(userId: string, idx: number) {
    setUserGrants(userId, (grants[userId] ?? []).filter((_, i) => i !== idx))
  }

  async function saveGrants(userId: string) {
    setSavingUser(prev => ({ ...prev, [userId]: true }))
    await fetch('/api/admin/home-assistant/grants', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ userId, grants: grants[userId] ?? [] }),
    }).catch(() => {})
    setSavingUser(prev => ({ ...prev, [userId]: false }))
    setSavedUser(prev => ({ ...prev, [userId]: true }))
  }

  const connected = status?.configured && status?.connected
  return (
    <div className="space-y-3 border-t border-border/50 pt-3">
      {/* Status */}
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs">
          <p className="font-semibold uppercase tracking-wider text-muted-foreground/60">Connection</p>
          {!status?.configured ? (
            <p className="text-muted-foreground/70 mt-0.5">Enter the URL + token above, then sync.</p>
          ) : connected ? (
            <p className="text-emerald-400 mt-0.5">
              Connected · {status.entities} entities · {status.areas} rooms · synced {timeAgo(status.lastSyncMs)}
            </p>
          ) : (
            <p className="text-red-400 mt-0.5">Not connected{status.lastError ? `: ${status.lastError}` : ''}</p>
          )}
        </div>
        <button type="button" onClick={sync} disabled={syncing}
          className="shrink-0 flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/40 disabled:opacity-50">
          {syncing ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>

      {/* Per-user grants */}
      <div className="space-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
          Control permissions <span className="font-normal normal-case text-muted-foreground/40">— who can control which devices, by area</span>
        </p>
        {users.length === 0 && <p className="text-[11px] text-muted-foreground/50">No non-admin users. Admins can control everything.</p>}
        {users.map(u => {
          const ug = grants[u.id] ?? []
          const general = ug.map((g, i) => [g, i] as const).filter(([g]) => g.domain !== SECURITY)
          const security = ug.map((g, i) => [g, i] as const).filter(([g]) => g.domain === SECURITY)
          const generalDomains = domains.filter(d => d !== 'lock' && d !== SECURITY)
          return (
            <div key={u.id} className="rounded-xl border border-border/60 bg-background/40 p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">{u.nickname || u.firstName || u.id}</span>
                <div className="flex items-center gap-1.5">
                  <button type="button" onClick={() => addGrant(u.id)}
                    className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/40">
                    <Plus className="size-3" /> Grant
                  </button>
                  <button type="button" onClick={() => saveGrants(u.id)} disabled={savingUser[u.id]}
                    className="flex items-center gap-1 rounded-md bg-brand px-2 py-1 text-[11px] text-brand-foreground hover:opacity-90 disabled:opacity-50">
                    {savingUser[u.id] ? <Loader2 className="size-3 animate-spin" /> : savedUser[u.id] ? <Check className="size-3" /> : null}
                    Save
                  </button>
                </div>
              </div>
              {general.length === 0 ? (
                <p className="text-[11px] text-muted-foreground/50">No grants — this user can’t control anything.</p>
              ) : (
                <div className="space-y-1.5">
                  {general.map(([g, i]) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <select value={g.domain} onChange={e => updateGrant(u.id, i, { domain: e.target.value })}
                        className="rounded-md border border-border bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-brand/40">
                        <option value={ALL}>All devices</option>
                        {generalDomains.map(d => <option key={d} value={d}>{d}</option>)}
                        {g.domain === 'lock' && <option value="lock">lock (legacy — use Security)</option>}
                      </select>
                      <span className="text-[11px] text-muted-foreground/50">in</span>
                      <select value={g.areaId} onChange={e => updateGrant(u.id, i, { areaId: e.target.value })}
                        className="rounded-md border border-border bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-brand/40">
                        <option value={ALL}>All rooms</option>
                        {areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                      <button type="button" onClick={() => removeGrant(u.id, i)}
                        className={cn('rounded-md p-1 text-muted-foreground/40 hover:text-red-400 hover:bg-red-500/10')}>
                        <X className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {/* Security — locks + entry doors, explicit-only (never in "All devices") */}
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1 text-[11px] font-medium text-amber-500">
                    <Lock className="size-3" /> Security — locks &amp; entry doors
                  </span>
                  <button type="button" onClick={() => addSecurityGrant(u.id)}
                    className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/40">
                    <Plus className="size-3" /> Add
                  </button>
                </div>
                {security.length === 0 ? (
                  <p className="text-[10px] text-muted-foreground/50">Not granted — "All devices" never includes these.</p>
                ) : (
                  <div className="space-y-1.5">
                    {security.map(([g, i]) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <span className="text-[11px]">Locks &amp; entry doors</span>
                        <span className="text-[11px] text-muted-foreground/50">in</span>
                        <select value={g.areaId} onChange={e => updateGrant(u.id, i, { areaId: e.target.value })}
                          className="rounded-md border border-border bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-brand/40">
                          <option value={ALL}>All rooms</option>
                          {areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                        </select>
                        <button type="button" onClick={() => removeGrant(u.id, i)}
                          className={cn('rounded-md p-1 text-muted-foreground/40 hover:text-red-400 hover:bg-red-500/10')}>
                          <X className="size-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
