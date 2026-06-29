// Standalone Admin → Integrations → Home Assistant tab. Includes connection
// configuration (URL + token, saved via the generic tool config API) and
// per-user (domain × area) access grants.

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Home, RefreshCw, Plus, X, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'

interface HAUser  { id: string; nickname?: string; firstName?: string; role?: string }
interface Grant   { domain: string; areaId: string }
interface Area    { id: string; name: string }
interface Status  {
  configured: boolean
  connected?: boolean
  entities?: number
  areas?: number
  lastSyncMs?: number | null
  lastError?: string | null
}

const ALL = '*'
const opts: RequestInit = { credentials: 'include' }

function timeAgo(ms: number | null | undefined): string {
  if (!ms) return 'never'
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60)   return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

async function saveToolConfig(key: string, value: unknown) {
  await fetch('/api/tools/config/global', {
    ...opts, method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toolId: 'homeAssistant', key, value }),
  })
}

export function AdminHomeAssistantTab() {
  // connection config
  const [baseUrl, setBaseUrl]       = useState('')
  const [apiToken, setApiToken]     = useState('')
  const [tokenSet, setTokenSet]     = useState(false)
  const [savingConn, setSavingConn] = useState(false)

  // status
  const [status, setStatus]   = useState<Status | null>(null)
  const [syncing, setSyncing] = useState(false)

  // catalog + grants
  const [areas, setAreas]     = useState<Area[]>([])
  const [domains, setDomains] = useState<string[]>([])
  const [grants, setGrants]   = useState<Record<string, Grant[]>>({})
  const [users, setUsers]     = useState<HAUser[]>([])
  const [savingUser, setSavingUser] = useState<Record<string, boolean>>({})
  const [savedUser, setSavedUser]   = useState<Record<string, boolean>>({})

  const loadStatus = useCallback(async () => {
    const st: Status = await fetch('/api/admin/home-assistant/status', opts).then(r => r.json()).catch(() => null)
    setStatus(st)
  }, [])

  const load = useCallback(async () => {
    const [allConfigs, st, cat, gr, us] = await Promise.all([
      fetch('/api/tools/config/global', opts).then(r => r.json()).catch(() => ({})),
      fetch('/api/admin/home-assistant/status', opts).then(r => r.json()).catch(() => null),
      fetch('/api/admin/home-assistant/catalog', opts).then(r => r.json()).catch(() => null),
      fetch('/api/admin/home-assistant/grants', opts).then(r => r.json()).catch(() => ({})),
      fetch('/api/users', opts).then(r => r.json()).catch(() => []),
    ])
    const haCfg = (allConfigs as Record<string, Record<string, unknown>>)['homeAssistant'] ?? {}
    if (typeof haCfg['base_url'] === 'string') setBaseUrl(haCfg['base_url'])
    setTokenSet(!!haCfg['api_token'])
    setStatus(st)
    if (cat) { setAreas(cat.areas ?? []); setDomains(cat.domains ?? []) }
    setGrants(gr ?? {})
    if (Array.isArray(us)) setUsers((us as HAUser[]).filter(u => u.role !== 'admin'))
  }, [])

  useEffect(() => { void load() }, [load])

  async function saveConnection() {
    setSavingConn(true)
    try {
      await saveToolConfig('base_url', baseUrl.trim())
      if (apiToken.trim()) await saveToolConfig('api_token', apiToken.trim())
      toast.success('Connection saved — syncing…')
      setApiToken('')
      await sync()
    } catch { toast.error('Failed to save') } finally { setSavingConn(false) }
  }

  async function sync() {
    setSyncing(true)
    try {
      await fetch('/api/admin/home-assistant/sync', { ...opts, method: 'POST' })
      await loadStatus()
      const cat = await fetch('/api/admin/home-assistant/catalog', opts).then(r => r.json()).catch(() => null)
      if (cat) { setAreas(cat.areas ?? []); setDomains(cat.domains ?? []) }
    } catch { /* silent */ } finally { setSyncing(false) }
  }

  function setUserGrants(userId: string, next: Grant[]) {
    setGrants(prev => ({ ...prev, [userId]: next }))
    setSavedUser(prev => ({ ...prev, [userId]: false }))
  }
  function addGrant(userId: string) {
    setUserGrants(userId, [...(grants[userId] ?? []), { domain: ALL, areaId: ALL }])
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
      ...opts, method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, grants: grants[userId] ?? [] }),
    }).catch(() => {})
    setSavingUser(prev => ({ ...prev, [userId]: false }))
    setSavedUser(prev => ({ ...prev, [userId]: true }))
  }

  const connected = status?.configured && status?.connected

  return (
    <div className="flex flex-col max-w-3xl">
      {/* Page header */}
      <div className="flex items-start gap-3 p-5 pb-5">
        <div className="rounded-lg bg-muted p-2 shrink-0">
          <Home className="size-5 text-muted-foreground" />
        </div>
        <div>
          <h2 className="text-base font-semibold">Home Assistant</h2>
          <p className="text-sm text-muted-foreground">
            Control smart-home devices — lights, switches, locks, thermostats, and scenes — via the companion.
            Configure the connection here and grant users access to specific devices and rooms.
          </p>
        </div>
      </div>

      <div className="px-5 space-y-5">
        {/* Connection */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Connection</CardTitle>
            <CardDescription>Where your Home Assistant server lives.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Home Assistant URL</Label>
              <Input
                value={baseUrl}
                onChange={e => setBaseUrl(e.target.value)}
                placeholder="http://homeassistant.local:8123"
              />
            </div>
            <div className="space-y-1.5">
              <Label>
                Long-Lived Access Token{' '}
                {tokenSet && <span className="text-muted-foreground font-normal">(set — leave blank to keep)</span>}
              </Label>
              <Input
                value={apiToken}
                onChange={e => setApiToken(e.target.value)}
                type="password"
                placeholder={tokenSet ? '••••••••••' : 'Profile → Security → Long-lived access tokens'}
              />
            </div>
            <Button onClick={saveConnection} disabled={savingConn || !baseUrl.trim()}>
              {savingConn ? <Loader2 className="size-4 animate-spin mr-1.5" /> : null}
              Save &amp; connect
            </Button>
          </CardContent>
        </Card>

        {/* Status */}
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-sm">Status</CardTitle>
              <CardDescription className="mt-1">
                {!status?.configured ? (
                  'Enter the URL and token above, then save.'
                ) : connected ? (
                  <span className="text-emerald-500">
                    Connected · {status.entities} entities · {status.areas} rooms · synced {timeAgo(status.lastSyncMs)}
                  </span>
                ) : (
                  <span className="text-red-400">
                    Not connected{status?.lastError ? `: ${status.lastError}` : ''}
                  </span>
                )}
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={sync} disabled={syncing} className="shrink-0">
              {syncing ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : <RefreshCw className="size-3.5 mr-1.5" />}
              {syncing ? 'Syncing…' : 'Sync now'}
            </Button>
          </CardHeader>
        </Card>

        {/* Per-user grants */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Control permissions</CardTitle>
            <CardDescription>
              Choose which users can control which devices. Leave a user with no grants and they can't control anything.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {users.length === 0 ? (
              <p className="text-sm text-muted-foreground">No non-admin users. Admins can control everything.</p>
            ) : (
              users.map(u => {
                const ug = grants[u.id] ?? []
                return (
                  <div key={u.id} className="rounded-xl border border-border bg-background/40 p-3 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{u.nickname || u.firstName || u.id}</span>
                      <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => addGrant(u.id)}>
                          <Plus className="size-3.5 mr-1" />Grant
                        </Button>
                        <Button size="sm" onClick={() => saveGrants(u.id)} disabled={savingUser[u.id]}>
                          {savingUser[u.id] ? <Loader2 className="size-3.5 animate-spin mr-1" /> : savedUser[u.id] ? <Check className="size-3.5 mr-1" /> : null}
                          Save
                        </Button>
                      </div>
                    </div>
                    {ug.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No grants — this user can't control anything.</p>
                    ) : (
                      <div className="space-y-2">
                        {ug.map((g, i) => (
                          <div key={i} className="flex items-center gap-2 flex-wrap">
                            <select value={g.domain} onChange={e => updateGrant(u.id, i, { domain: e.target.value })}
                              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40">
                              <option value={ALL}>All devices</option>
                              {domains.map(d => <option key={d} value={d}>{d}</option>)}
                            </select>
                            <span className="text-xs text-muted-foreground">in</span>
                            <select value={g.areaId} onChange={e => updateGrant(u.id, i, { areaId: e.target.value })}
                              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40">
                              <option value={ALL}>All rooms</option>
                              {areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                            </select>
                            <button type="button" onClick={() => removeGrant(u.id, i)}
                              className={cn('rounded-md p-1.5 text-muted-foreground/50 hover:text-red-400 hover:bg-red-500/10 transition-colors')}>
                              <X className="size-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
