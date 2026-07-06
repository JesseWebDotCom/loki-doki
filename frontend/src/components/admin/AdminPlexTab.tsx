import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, XCircle, Server, ExternalLink, UserCheck, UserX, AlertTriangle, ChevronDown } from 'lucide-react'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { SkeletonListRows } from '@/components/shared/SkeletonBlocks'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { AdminStorageLocationsTab } from '@/components/admin/AdminStorageLocationsTab'
import { cn } from '@/lib/cn'
import {
  getPlexConfig,
  savePlexConfig,
  startPlexPin,
  pollPlexPin,
  discoverPlexServers,
  type PlexConfigSummary,
  type PlexServer,
} from '@/lib/plex/api'

interface PlexLibrarySection {
  userId: string
  contentType: string
  status: 'pending' | 'provisioning' | 'ready' | 'error'
  error: string | null
}

interface StorageLocation {
  id: string
  name: string
  path: string
  plexPath: string | null
}

export function AdminPlexTab() {
  const [cfg, setCfg] = useState<PlexConfigSummary | null>(null)
  const [librarySections, setLibrarySections] = useState<PlexLibrarySection[]>([])
  const [provisioning, setProvisioning] = useState<Set<string>>(new Set())
  // Whether YouTube's storage location + Plex path mapping are actually set up, the real
  // prerequisite for "Provision" to succeed at all. Checked up front so the button isn't
  // clickable into 3 doomed retries with the failure only visible in the server log.
  const [youtubeStorageReady, setYoutubeStorageReady] = useState<boolean | null>(null)
  const [youtubeStorageIssue, setYoutubeStorageIssue] = useState<string | null>(null)
  const [storageManagerOpen, setStorageManagerOpen] = useState(false)
  const storageManagerAutoOpened = useRef(false)
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
    const secRes = await fetch('/api/plex/admin/library-sections', { credentials: 'include' })
    if (secRes.ok) {
      const secData = await secRes.json() as { sections: PlexLibrarySection[] }
      setLibrarySections(secData.sections ?? [])
    }

    // Same two checks provisionUserLibrary() makes server-side, done here up front so the
    // button reflects reality instead of the user having to fail 3 job attempts to find out.
    // NOTE: no trailing slash on the bare list endpoint. Hono's `.route()` mounts a child
    // `app.get('/')` at exactly the prefix, not prefix + '/' (a distinct, 404-ing path).
    const [locRes, ctRes] = await Promise.all([
      fetch('/api/admin/storage-locations', { credentials: 'include' }),
      fetch('/api/admin/storage-locations/content-types', { credentials: 'include' }),
    ])
    if (locRes.ok && ctRes.ok) {
      const locData = await locRes.json() as { locations: StorageLocation[] }
      const ctData = await ctRes.json() as { assignments: Array<{ contentType: string; storageLocationId: string | null }> }
      const assignment = ctData.assignments.find(a => a.contentType === 'youtube')
      if (!assignment?.storageLocationId) {
        setYoutubeStorageReady(false)
        setYoutubeStorageIssue('YouTube is still on the default local storage, which Plex can never see.')
      } else {
        const loc = locData.locations.find(l => l.id === assignment.storageLocationId)
        if (!loc?.plexPath) {
          setYoutubeStorageReady(false)
          setYoutubeStorageIssue(`"${loc?.name ?? 'YouTube’s storage location'}" has no Plex path mapping set.`)
        } else {
          setYoutubeStorageReady(true)
          setYoutubeStorageIssue(null)
        }
      }
    }
  }, [])

  const provisionYoutube = useCallback(async (userId: string) => {
    setProvisioning(prev => new Set(prev).add(userId))
    try {
      await fetch('/api/plex/admin/provision', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, contentType: 'youtube' }),
      })
      toast.success('Provisioning started, check back shortly for status')
      // The job runs in the background; poll once after a few seconds so a quick success shows up.
      setTimeout(() => { void load() }, 4000)
    } finally {
      setProvisioning(prev => { const next = new Set(prev); next.delete(userId); return next })
    }
  }, [load])

  useEffect(() => {
    void load()
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current)
    }
  }, [load])

  // Open the embedded manager automatically the first time we learn setup isn't done yet.
  // Only once, so a user who deliberately collapses it later isn't fought on every re-check.
  useEffect(() => {
    if (youtubeStorageReady === false && !storageManagerAutoOpened.current) {
      storageManagerAutoOpened.current = true
      setStorageManagerOpen(true)
    }
  }, [youtubeStorageReady])

  const save = useCallback(
    async (patch: { baseUrl?: string; token?: string }) => {
      setSaving(true)
      try {
        const r = await savePlexConfig(patch)
        setConnOk(r.ok)
        setServerName(r.serverName)
        toast.success(r.ok ? `Connected to ${r.serverName ?? 'Plex'}` : 'Saved, but could not reach the server')
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
    return <SkeletonListRows count={4} className="p-5" />
  }

  return (
    <div className="flex flex-col max-w-3xl">
      {/* Page header */}
      <div className="flex items-start gap-3 p-5 pb-5">
        <div className="rounded-control bg-muted p-2 shrink-0">
          <Server className="size-5 text-muted-foreground" />
        </div>
        <div>
          <h2 className="text-title">Plex</h2>
          <p className="text-sm text-muted-foreground">
            Configure the shared Plex Media Server. Each user then links their own Plex account in
            Settings → Plex so their watchlist and progress stay personal.
          </p>
        </div>
      </div>

      <div className="px-5 space-y-5">
        {/* Connection status */}
        {(connOk !== null || cfg.hasToken) && (
          <div className="flex items-center gap-2 rounded-card border border-border bg-card px-4 py-3 text-sm">
            {connOk === false
              ? <XCircle className="size-4 text-destructive shrink-0" />
              : <CheckCircle2 className="size-4 text-success shrink-0" />}
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
            <CardDescription>Approve a code on plex.tv, no token to copy.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
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
                {cfg.hasToken && <span className="text-muted-foreground font-normal">(set, leave blank to keep)</span>}
              </Label>
              <Input value={token} onChange={e => setToken(e.target.value)} placeholder="xxxxxxxxxxxxxxxxxxxx" type="password" />
            </div>
            <Button
              onClick={() => save({ baseUrl, ...(token ? { token } : {}) })}
              disabled={saving || !baseUrl.trim()}>
              {saving ? <Spinner size="sm" className="text-current mr-1.5" /> : null}
              Save &amp; test
            </Button>
          </CardContent>
        </Card>

        {/* YouTube → Plex export prerequisites. The manager lives right here, not in
            another admin section, since Plex is the only thing that needs it today. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">YouTube library storage</CardTitle>
            <CardDescription>
              Add a network location Plex can see and give it a Plex path mapping below, that's
              the only step. It's automatically used for YouTube's export once mapped.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {youtubeStorageReady == null ? (
              <Spinner size="sm" className="text-muted-foreground" />
            ) : youtubeStorageReady ? (
              <div className="flex items-center gap-2 text-sm text-success">
                <CheckCircle2 className="size-4 shrink-0" /> Storage location and Plex path mapping are configured.
              </div>
            ) : (
              <div className="flex items-start gap-2 text-sm text-warning">
                <AlertTriangle className="size-4 shrink-0 mt-0.5" />
                <span>{youtubeStorageIssue}</span>
              </div>
            )}

            <button
              type="button"
              onClick={() => setStorageManagerOpen(o => !o)}
              className="flex w-full items-center justify-between rounded-control border border-border px-3 py-2 text-sm hover:bg-muted/50"
            >
              <span>{storageManagerOpen ? 'Hide' : 'Manage'} storage locations</span>
              <ChevronDown className={cn('size-4 transition-transform', storageManagerOpen && 'rotate-180')} />
            </button>
            {storageManagerOpen && (
              <div className="rounded-card border border-border">
                <AdminStorageLocationsTab onChange={load} />
              </div>
            )}
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
            <div className="divide-y divide-border overflow-hidden rounded-card border border-border">
              {cfg.users.map(u => {
                const section = librarySections.find(s => s.userId === u.id && s.contentType === 'youtube')
                return (
                  <div key={u.id} className="flex flex-col gap-1.5 px-4 py-2.5 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span>{u.name}</span>
                      <div className="flex items-center gap-3">
                        {u.linked ? (
                          <span className="inline-flex items-center gap-1.5 text-xs text-success">
                            <UserCheck className="size-3.5" /> Linked
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                            <UserX className="size-3.5" /> Not linked
                          </span>
                        )}
                        {u.linked && (
                          <>
                            {section?.status === 'ready' && <span className="text-xs text-success">YouTube library ready</span>}
                            {(!section || section.status === 'error') && (
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={provisioning.has(u.id) || !youtubeStorageReady}
                                title={!youtubeStorageReady ? 'Fix the storage setup above first' : undefined}
                                onClick={() => provisionYoutube(u.id)}
                              >
                                {provisioning.has(u.id) && <Spinner size="sm" className="text-current mr-1" />}
                                {section?.status === 'error' ? 'Retry' : 'Provision YouTube library'}
                              </Button>
                            )}
                            {(section?.status === 'pending' || section?.status === 'provisioning') && (
                              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                                <Spinner size="sm" /> Provisioning…
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                    {section?.status === 'error' && section.error && (
                      <p className="text-xs text-destructive">{section.error}</p>
                    )}
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
