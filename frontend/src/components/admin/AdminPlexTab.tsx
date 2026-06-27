import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, CheckCircle2, XCircle, Server, ExternalLink, UserCheck, UserX } from 'lucide-react'
import { toast } from '@/lib/toast'
import {
  getPlexConfig,
  savePlexConfig,
  startPlexPin,
  pollPlexPin,
  discoverPlexServers,
  type PlexConfigSummary,
  type PlexServer,
} from '@/lib/plex/api'

const inputCls = 'w-full rounded-xl border border-border bg-card px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40'
const btnCls = 'inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50'

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
    <div className="mx-auto max-w-2xl space-y-8 py-2">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Server className="size-5 text-amber-400" /> Plex
        </h1>
        <p className="text-sm text-muted-foreground">
          Configure the shared Plex Media Server here. Each user then links their own Plex account in
          Settings → Plex (or from the Shows/Movies apps) so their Watchlist and progress stay personal.
        </p>
      </header>

      {/* Connection status */}
      {(connOk !== null || cfg.hasToken) && (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm">
          {connOk === false ? (
            <XCircle className="size-4 text-red-400" />
          ) : (
            <CheckCircle2 className="size-4 text-emerald-400" />
          )}
          {connOk === false
            ? 'Saved, but the server could not be reached.'
            : serverName
              ? `Connected to ${serverName}.`
              : cfg.hasToken
                ? 'A Plex token is configured.'
                : 'Not connected.'}
        </div>
      )}

      {/* One-click sign-in */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Sign in with Plex</h2>
        <p className="text-xs text-muted-foreground">Approve a code on plex.tv — no token to copy.</p>
        {pin ? (
          <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
            <p className="text-sm">
              Enter code <span className="font-mono text-lg font-bold tracking-widest text-amber-300">{pin.code}</span> at{' '}
              <a href="https://plex.tv/link" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
                plex.tv/link <ExternalLink className="size-3" />
              </a>
            </p>
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Waiting for approval…
            </p>
          </div>
        ) : (
          <button onClick={beginLink} disabled={linking} className={`${btnCls} bg-amber-500/15 text-amber-300 hover:bg-amber-500/25`}>
            {linking ? <Loader2 className="size-4 animate-spin" /> : <Server className="size-4" />} Sign in with Plex
          </button>
        )}
        {servers.length > 1 && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Choose a server:</p>
            {servers.map((s) => (
              <button
                key={s.uri}
                onClick={() => save({ baseUrl: s.uri, token })}
                className="flex w-full items-center justify-between rounded-xl border border-border bg-card px-4 py-2.5 text-sm hover:bg-muted"
              >
                <span>{s.name}</span>
                <span className="text-xs text-muted-foreground">{s.local ? 'local' : 'remote'}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Manual entry */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Or enter manually</h2>
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">Server URL</label>
          <input className={inputCls} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://192.168.1.10:32400" />
        </div>
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">X-Plex-Token {cfg.hasToken && <span className="text-emerald-400">(set — leave blank to keep)</span>}</label>
          <input className={inputCls} value={token} onChange={(e) => setToken(e.target.value)} placeholder="xxxxxxxxxxxxxxxxxxxx" type="password" />
        </div>
        <button
          onClick={() => save({ baseUrl, ...(token ? { token } : {}) })}
          disabled={saving || !baseUrl.trim()}
          className={`${btnCls} bg-foreground text-background hover:opacity-90`}
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : null} Save & test
        </button>
      </section>

      {/* Who has linked their own Plex account */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Linked accounts</h2>
        <p className="text-xs text-muted-foreground">
          Each user links their own Plex account in Settings → Plex. Their watchlist and watched-state sync to it.
        </p>
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {cfg.users.map((u) => (
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
      </section>
    </div>
  )
}
