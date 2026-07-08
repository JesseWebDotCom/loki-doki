// Shared Plex-server connect UI (PIN sign-in + manual URL/token entry) - used by both
// AdminPlexTab and the PlexSetupWizard so the flow exists exactly once.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Server, ExternalLink } from 'lucide-react'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { savePlexConfig, startPlexPin, pollPlexPin, discoverPlexServers, type PlexServer } from '@/lib/plex/api'

interface PlexServerConnectProps {
  hasToken: boolean
  initialBaseUrl: string
  /** Called after a successful save (connected or not) so the parent can re-check state. */
  onSaved?: (ok: boolean, serverName: string | null) => void
  /** Compact mode drops the Card chrome (for embedding inside a wizard step). */
  compact?: boolean
}

export function PlexServerConnect({ hasToken, initialBaseUrl, onSaved, compact }: PlexServerConnectProps) {
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl)
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [pin, setPin] = useState<{ code: string; linkUrl: string } | null>(null)
  const [linking, setLinking] = useState(false)
  const [servers, setServers] = useState<PlexServer[]>([])
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => () => { if (pollTimer.current) clearInterval(pollTimer.current) }, [])

  const save = useCallback(async (patch: { baseUrl?: string; token?: string }) => {
    setSaving(true)
    try {
      const r = await savePlexConfig(patch)
      toast.success(r.ok ? `Connected to ${r.serverName ?? 'Plex'}` : 'Saved, but could not reach the server')
      onSaved?.(r.ok, r.serverName)
    } finally {
      setSaving(false)
    }
  }, [onSaved])

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

  const signIn = (
    <div className="space-y-3">
      {pin ? (
        <div className="space-y-2 rounded-card border border-border bg-muted/50 px-4 py-3">
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
            <Spinner size="sm" className="text-current" /> Waiting for approval…
          </p>
        </div>
      ) : (
        <Button variant="outline" onClick={beginLink} disabled={linking}>
          {linking ? <Spinner size="sm" className="text-current mr-1.5" /> : <Server className="size-4 mr-1.5" />}
          Sign in with Plex
        </Button>
      )}
      {servers.length > 1 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Multiple servers found, choose one:</p>
          <div className="divide-y divide-border overflow-hidden rounded-card border border-border">
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
    </div>
  )

  const manual = (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>Server URL</Label>
        <Input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="http://192.168.1.10:32400" />
      </div>
      <div className="space-y-1.5">
        <Label>
          X-Plex-Token{' '}
          {hasToken && <span className="text-muted-foreground font-normal">(set, leave blank to keep)</span>}
        </Label>
        <Input value={token} onChange={e => setToken(e.target.value)} placeholder="xxxxxxxxxxxxxxxxxxxx" type="password" />
      </div>
      <Button
        onClick={() => save({ baseUrl, ...(token ? { token } : {}) })}
        disabled={saving || !baseUrl.trim()}>
        {saving ? <Spinner size="sm" className="text-current mr-1.5" /> : null}
        Save &amp; test
      </Button>
    </div>
  )

  if (compact) {
    return (
      <div className="space-y-5">
        {signIn}
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Or enter the server URL and token directly:</p>
          {manual}
        </div>
      </div>
    )
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Sign in with Plex</CardTitle>
          <CardDescription>Approve a code on plex.tv, no token to copy.</CardDescription>
        </CardHeader>
        <CardContent>{signIn}</CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Manual configuration</CardTitle>
          <CardDescription>Enter the server URL and token directly.</CardDescription>
        </CardHeader>
        <CardContent>{manual}</CardContent>
      </Card>
    </>
  )
}
