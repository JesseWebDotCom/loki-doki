import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Plus, X, Check, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { StatusDot } from '@/components/shared/StatusDot'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'

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
  const [confirmRemove, setConfirmRemove] = useState<{ userId: string; idx: number; label: string } | null>(null)

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
          <p className="text-overline text-muted-foreground/60">Connection</p>
          {!status?.configured ? (
            <p className="text-muted-foreground/70 mt-0.5">Enter the URL + token above, then sync.</p>
          ) : connected ? (
            <p className="flex items-center gap-1.5 text-success mt-0.5">
              <StatusDot status="ok" />
              Connected · {status.entities} entities · {status.areas} rooms · synced {timeAgo(status.lastSyncMs)}
            </p>
          ) : (
            <p className="flex items-center gap-1.5 text-destructive mt-0.5">
              <StatusDot status="error" />
              Not connected{status.lastError ? `: ${status.lastError}` : ''}
            </p>
          )}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={sync} disabled={syncing}
          className="shrink-0 gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          {syncing ? <Spinner size="sm" /> : <RefreshCw className="size-3" />}
          {syncing ? 'Syncing…' : 'Sync now'}
        </Button>
      </div>

      {/* Per-user grants */}
      <div className="space-y-2">
        <p className="text-overline text-muted-foreground/60">
          Control permissions <span className="font-normal normal-case tracking-normal text-muted-foreground/40">: who can control which devices, by area</span>
        </p>
        {users.length === 0 && <p className="text-[11px] text-muted-foreground/50">No non-admin users. Admins can control everything.</p>}
        {users.map(u => {
          const ug = grants[u.id] ?? []
          const general = ug.map((g, i) => [g, i] as const).filter(([g]) => g.domain !== SECURITY)
          const security = ug.map((g, i) => [g, i] as const).filter(([g]) => g.domain === SECURITY)
          const generalDomains = domains.filter(d => d !== 'lock' && d !== SECURITY)
          return (
            <div key={u.id} className="rounded-card border border-border/60 bg-background/40 p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">{u.nickname || u.firstName || u.id}</span>
                <div className="flex items-center gap-1.5">
                  <Button type="button" variant="outline" size="sm" onClick={() => addGrant(u.id)}
                    className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground">
                    <Plus className="size-3" /> Grant
                  </Button>
                  <Button type="button" size="sm" onClick={() => saveGrants(u.id)} disabled={savingUser[u.id]}
                    className="h-7 gap-1 px-2 text-[11px]">
                    {savingUser[u.id] ? <Spinner size="sm" className="text-current" /> : savedUser[u.id] ? <Check className="size-3" /> : null}
                    Save
                  </Button>
                </div>
              </div>
              {general.length === 0 ? (
                <p className="text-[11px] text-muted-foreground/50">No grants, this user can’t control anything.</p>
              ) : (
                <div className="space-y-1.5">
                  {general.map(([g, i]) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <select value={g.domain} onChange={e => updateGrant(u.id, i, { domain: e.target.value })}
                        className="rounded-control border border-border bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-brand/40">
                        <option value={ALL}>All devices</option>
                        {generalDomains.map(d => <option key={d} value={d}>{d}</option>)}
                        {g.domain === 'lock' && <option value="lock">lock (legacy, use Security)</option>}
                      </select>
                      <span className="text-[11px] text-muted-foreground/50">in</span>
                      <select value={g.areaId} onChange={e => updateGrant(u.id, i, { areaId: e.target.value })}
                        className="rounded-control border border-border bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-brand/40">
                        <option value={ALL}>All rooms</option>
                        {areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                      <Button type="button" variant="ghost" size="icon-sm"
                        onClick={() => setConfirmRemove({ userId: u.id, idx: i, label: g.domain === ALL ? 'All devices' : g.domain })}
                        className="text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10" aria-label="Remove grant">
                        <X className="size-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {/* Security: locks + entry doors, explicit-only (never in "All devices") */}
              <div className="rounded-card border border-warning/30 bg-warning/5 p-2 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1 text-[11px] font-medium text-warning">
                    <Lock className="size-3" /> Security, locks &amp; entry doors
                  </span>
                  <Button type="button" variant="outline" size="sm" onClick={() => addSecurityGrant(u.id)}
                    className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground">
                    <Plus className="size-3" /> Add
                  </Button>
                </div>
                {security.length === 0 ? (
                  <p className="text-[10px] text-muted-foreground/50">Not granted. "All devices" never includes these.</p>
                ) : (
                  <div className="space-y-1.5">
                    {security.map(([g, i]) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <span className="text-[11px]">Locks &amp; entry doors</span>
                        <span className="text-[11px] text-muted-foreground/50">in</span>
                        <select value={g.areaId} onChange={e => updateGrant(u.id, i, { areaId: e.target.value })}
                          className="rounded-control border border-border bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-brand/40">
                          <option value={ALL}>All rooms</option>
                          {areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                        </select>
                        <Button type="button" variant="ghost" size="icon-sm"
                          onClick={() => setConfirmRemove({ userId: u.id, idx: i, label: 'locks & entry doors' })}
                          className="text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10" aria-label="Remove security grant">
                          <X className="size-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <ConfirmDialog
        open={!!confirmRemove}
        onOpenChange={(o) => { if (!o) setConfirmRemove(null) }}
        title="Remove this grant?"
        description={confirmRemove ? `This revokes access to ${confirmRemove.label}. Remember to hit Save to apply the change.` : undefined}
        confirmLabel="Remove"
        destructive
        onConfirm={() => { if (confirmRemove) removeGrant(confirmRemove.userId, confirmRemove.idx); setConfirmRemove(null) }}
      />
    </div>
  )
}
