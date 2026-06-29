import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, CheckCircle2, XCircle, Server, ExternalLink, UserCheck, UserX } from 'lucide-react'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import {
  getPlexConfig,
  savePlexConfig,
  startPlexPin,
  pollPlexPin,
  discoverPlexServers,
  type PlexConfigSummary,
  type PlexServer,
} from '@/lib/plex/api'

export function AdminPlexTab() {
  const [cfg, setCfg] = useState<PlexConfigSummary | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [serverName, setServerName] = useState<string | null>(null)
  const [connOk, setConnOk] = useState<boolean | null>(null)

  // PIN-auth state
  const [pin, setPin] = useState<{ code: string; linkUrl: string } | null>(null)
  const [linking, setLinking] = useState(false)
  const [servers, setServers] = useState<PlexServer[]>([])
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    const d = await getPlexConfig()
    if (!d) {
      toast.error('Could not load Plex settings')
      return
    }
    setCfg(d)
    setBaseUrl(d.baseUrl)
  }, [])

  useEffect(() => {
    void load()
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current)
    }
  }, [load])

  const save = useCallback(
    async (patch: { baseUrl?: string; token?: string }) => {
      setSaving(true)
      try {
        const r = await savePlexConfig(patch)
        setConnOk(r.ok)
        setServerName(r.serverName)
        toast.success(r.ok ? `Connected to ${r.serverName ?? 'Plex'}` : 'Saved — but could not reach the server')
        await load()
      } finally {
        setSaving(false)
      }
    },
    [load],
  )

  // Begin the plex.tv PIN flow: show the code, then poll until the user approves it.
  const beginLink = useCallback(async () => {
    setLinking(true)
    setServers([])
    const p = await startPlexPin()
    if (!p) {
      setLinking(false)
      toast.error('Could not start Plex sign-in')
      return
    }
    setPin({ code: p.code, linkUrl: p.linkUrl })
    window.open(p.linkUrl, '_blank', 'noopener')
    pollTimer.current = setInterval(async () => {
      const authToken = await pollPlexPin(p.id, p.clientId)
      if (!authToken) return
      if (pollTimer.current) clearInterval(pollTimer.current)
      setPin(null)
      setToken(authToken)
      const found = await discoverPlexServers(authToken, p.clientId)
      setServers(found)
      setLinking(false)
      if (found.length === 1) await save({ baseUrl: found[0]!.uri, token: authToken })
      else if (!found.length) toast.error('Signed in, but no servers were found on your account')
    }, 2000)
  }, [save])

  if (!cfg) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex flex-col max-w-3xl">
      {/* Page header */}
      <div className="flex items-start gap-3 p-5 pb-5">
        <div className="rounded-lg bg-muted p-2 shrink-0">
          <Server className="size-5 text-muted-foreground" />
        </div>
        <div>
          <h2 className="text-base font-semibold">Plex</h2>
          <p className="text-sm text-muted-foreground">
            Configure the shared Plex Media Server. Each user then links their own Plex account in
            Settings → Plex so their watchlist and progress stay personal.
          </p>
        </div>
      </div>

      <div className="px-5 space-y-5">
        {/* Connection status */}
        {(connOk !== null || cfg.hasToken) && (
          <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm">
            {connOk === false
              ? <XCircle className="size-4 text-red-400 shrink-0" />
              : <CheckCircle2 className="size-4 text-emerald-400 shrink-0" />}
            <span>
              {connOk === false
                ? 'Saved, but the server could not be reached.'
                : serverName
                  ? `Connected to ${serverName}.`
                  : cfg.hasToken
                    ? 'A Plex token is configured.'
                    : 'Not connected.'}
            </span>
          </div>
        )}

        {/* One-click sign-in */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Sign in with Plex</CardTitle>
            <CardDescription>Approve a code on plex.tv — no token to copy.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {pin ? (
              <div className="space-y-2 rounded-xl border border-border bg-muted/50 px-4 py-3">
                <p className="text-sm">
                  Enter code{' '}
                  <span className="font-mono text-lg font-bold tracking-widest">{pin.code}</span>{' '}
                  at{' '}
                  <a href="https://plex.tv/link" target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1 underline text-brand">
                    plex.tv/link <ExternalLink className="size-3" />
                  </a>
                </p>
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" /> Waiting for approval…
                </p>
              </div>
            ) : (
              <Button variant="outline" onClick={beginLink} disabled={linking}>
                {linking ? <Loader2 className="size-4 animate-spin mr-1.5" /> : <Server className="size-4 mr-1.5" />}
                Sign in with Plex
              </Button>
            )}
            {servers.length > 1 && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">Multiple servers found — choose one:</p>
                <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
                  {servers.map(s => (
                    <button key={s.uri} onClick={() => save({ baseUrl: s.uri, token })}
                      className="flex w-full items-center justify-between px-4 py-2.5 text-sm hover:bg-muted transition-colors text-left">
                      <span>{s.name}</span>
                      <span className="text-xs text-muted-foreground">{s.local ? 'local' : 'remote'}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Manual entry */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Manual configuration</CardTitle>
            <CardDescription>Enter the server URL and token directly.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Server URL</Label>
              <Input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="http://192.168.1.10:32400" />
            </div>
            <div className="space-y-1.5">
              <Label>
                X-Plex-Token{' '}
                {cfg.hasToken && <span className="text-muted-foreground font-normal">(set — leave blank to keep)</span>}
              </Label>
              <Input value={token} onChange={e => setToken(e.target.value)} placeholder="xxxxxxxxxxxxxxxxxxxx" type="password" />
            </div>
            <Button
              onClick={() => save({ baseUrl, ...(token ? { token } : {}) })}
              disabled={saving || !baseUrl.trim()}>
              {saving ? <Loader2 className="size-4 animate-spin mr-1.5" /> : null}
              Save &amp; test
            </Button>
          </CardContent>
        </Card>

        {/* Linked user accounts */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Linked accounts</CardTitle>
            <CardDescription>
              Each user links their own Plex account in Settings → Plex. Their watchlist and watch history sync to it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
              {cfg.users.map(u => (
                <div key={u.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span>{u.name}</span>
                  {u.linked ? (
                    <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
                      <UserCheck className="size-3.5" /> Linked
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <UserX className="size-3.5" /> Not linked
                    </span>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
