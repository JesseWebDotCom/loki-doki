// Home Assistant server connection (URL + long-lived access token) and live
// status, as one self-contained admin block. Mounted by the Admin →
// Integrations → Home Assistant tab and the Home Assistant app settings page,
// both writing the same tool config via the generic tool config API.

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { toast } from '@/lib/toast'

interface Status {
  configured: boolean
  connected?: boolean
  entities?: number
  areas?: number
  lastSyncMs?: number | null
  lastError?: string | null
}

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

export function HomeAssistantConnectionCard() {
  // connection config
  const [baseUrl, setBaseUrl]       = useState('')
  const [apiToken, setApiToken]     = useState('')
  const [tokenSet, setTokenSet]     = useState(false)
  const [savingConn, setSavingConn] = useState(false)

  // status
  const [status, setStatus]   = useState<Status | null>(null)
  const [syncing, setSyncing] = useState(false)

  const loadStatus = useCallback(async () => {
    const st: Status = await fetch('/api/admin/home-assistant/status', opts).then(r => r.json()).catch(() => null)
    setStatus(st)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [allConfigs, st] = await Promise.all([
        fetch('/api/tools/config/global', opts).then(r => r.json()).catch(() => ({})),
        fetch('/api/admin/home-assistant/status', opts).then(r => r.json()).catch(() => null),
      ])
      if (cancelled) return
      const haCfg = (allConfigs as Record<string, Record<string, unknown>>)['homeAssistant'] ?? {}
      if (typeof haCfg['base_url'] === 'string') setBaseUrl(haCfg['base_url'])
      setTokenSet(!!haCfg['api_token'])
      setStatus(st)
    })()
    return () => { cancelled = true }
  }, [])

  async function sync() {
    setSyncing(true)
    try {
      await fetch('/api/admin/home-assistant/sync', { ...opts, method: 'POST' })
      await loadStatus()
    } catch { /* silent */ } finally { setSyncing(false) }
  }

  async function saveConnection() {
    setSavingConn(true)
    try {
      await saveToolConfig('base_url', baseUrl.trim())
      if (apiToken.trim()) {
        await saveToolConfig('api_token', apiToken.trim())
        setTokenSet(true)
      }
      toast.success('Connection saved, syncing…')
      setApiToken('')
      await sync()
    } catch { toast.error('Failed to save') } finally { setSavingConn(false) }
  }

  const connected = status?.configured && status?.connected

  return (
    <div className="space-y-5">
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
              {tokenSet && <span className="text-muted-foreground font-normal">(set, leave blank to keep)</span>}
            </Label>
            <Input
              value={apiToken}
              onChange={e => setApiToken(e.target.value)}
              type="password"
              placeholder={tokenSet ? '••••••••••' : 'Profile → Security → Long-lived access tokens'}
            />
          </div>
          <Button onClick={saveConnection} disabled={savingConn || !baseUrl.trim()}>
            {savingConn ? <Spinner className="text-current mr-1.5" /> : null}
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
                <span className="text-success">
                  Connected · {status.entities} entities · {status.areas} rooms · synced {timeAgo(status.lastSyncMs)}
                </span>
              ) : (
                <span className="text-destructive">
                  Not connected{status?.lastError ? `: ${status.lastError}` : ''}
                </span>
              )}
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={sync} disabled={syncing} className="shrink-0">
            {syncing ? <Spinner size="sm" className="text-current mr-1.5" /> : <RefreshCw className="size-3.5 mr-1.5" />}
            {syncing ? 'Syncing…' : 'Sync now'}
          </Button>
        </CardHeader>
      </Card>
    </div>
  )
}
