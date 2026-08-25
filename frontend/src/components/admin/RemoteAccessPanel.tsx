import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { ExternalLink, Globe, Laptop, RefreshCw, Smartphone, Unplug } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Peer {
  hostName: string
  dnsName: string | null
  os: string | null
  online: boolean
  ips: string[]
}

interface RemoteAccessStatus {
  installed: boolean
  state: 'not-installed' | 'stopped' | 'needs-login' | 'starting' | 'running' | 'error'
  version: string | null
  authUrl: string | null
  hostName: string | null
  dnsName: string | null
  ips: string[]
  tailnet: string | null
  peers: Peer[]
  error: string | null
  appUrl: string | null
}

async function api(path: string, init?: RequestInit): Promise<RemoteAccessStatus> {
  const r = await fetch(`/api/admin/remote-access${path}`, { credentials: 'include', ...init })
  try {
    return (await r.json()) as RemoteAccessStatus
  } catch {
    throw new Error(`Unexpected response (${r.status}) from /api/admin/remote-access${path}`)
  }
}

function useQr(target: string | null): string | null {
  const [qr, setQr] = useState<string | null>(null)
  useEffect(() => {
    if (!target) {
      setQr(null)
      return
    }
    QRCode.toDataURL(target, { margin: 1, width: 220 }).then(setQr).catch(() => setQr(null))
  }, [target])
  return qr
}

// ── Main component ────────────────────────────────────────────────────────────

export function RemoteAccessPanel() {
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setStatus(await api(''))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not read remote access status')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // While waiting for the operator to finish logging in on another device, poll so
  // the panel flips to connected on its own.
  useEffect(() => {
    if (status?.state !== 'needs-login' && status?.state !== 'starting') return
    const t = window.setInterval(() => { void load() }, 4000)
    return () => window.clearInterval(t)
  }, [status?.state, load])

  const loginQr = useQr(status?.authUrl ?? null)
  const appQr = useQr(status?.appUrl ?? null)

  async function act(path: '/connect' | '/disconnect') {
    setBusy(true)
    try {
      setStatus(await api(path, { method: 'POST' }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'The Tailscale command failed')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div className="flex justify-center py-10"><Spinner /></div>
  if (!status) return <div className="text-sm text-destructive p-5">Could not read remote access status.</div>

  return (
    <div className="p-5 space-y-5">
      {/* ── Status line ── */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className={cn(
            'size-2.5 rounded-full shrink-0',
            status.state === 'running' ? 'bg-success' : status.state === 'error' ? 'bg-destructive' : 'bg-muted-foreground/40',
          )} />
          <div>
            <div className="text-sm font-medium">
              {status.state === 'running' && 'Connected to your tailnet'}
              {status.state === 'needs-login' && 'Waiting for sign-in'}
              {status.state === 'starting' && 'Connecting'}
              {status.state === 'stopped' && 'Tailscale is off'}
              {status.state === 'error' && 'Tailscale is not responding'}
              {status.state === 'not-installed' && 'Tailscale is not installed'}
            </div>
            <div className="text-xs text-muted-foreground">
              {status.state === 'running' && [status.tailnet, status.dnsName].filter(Boolean).join(': ')}
              {status.state === 'error' && status.error}
              {status.state === 'stopped' && 'The server is only reachable on your home network.'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="icon" variant="ghost" aria-label="Refresh status" onClick={() => void load()}>
            <RefreshCw className="size-4" />
          </Button>
          {status.installed && status.state !== 'running' && status.state !== 'error' && (
            <Button size="sm" onClick={() => void act('/connect')} disabled={busy}>
              {busy ? <Spinner className="size-4" /> : <Globe className="size-4" />} Connect
            </Button>
          )}
          {status.state === 'running' && (
            <Button size="sm" variant="outline" onClick={() => void act('/disconnect')} disabled={busy}>
              <Unplug className="size-4" /> Disconnect
            </Button>
          )}
        </div>
      </div>

      {/* ── Not installed: guided setup ── */}
      {!status.installed && (
        <div className="rounded-card border border-border bg-muted/30 p-4 text-sm space-y-2">
          <p>
            Tailscale gives the family private access to MaiPai Home from anywhere, with no
            port forwarding and no traffic leaving your control. Install it once on this
            server, then come back here and press Connect.
          </p>
          <a
            className="inline-flex items-center gap-1.5 text-brand hover:underline"
            href="https://tailscale.com/download"
            target="_blank"
            rel="noreferrer"
          >
            Get Tailscale for this machine <ExternalLink className="size-3.5" />
          </a>
        </div>
      )}

      {/* ── Needs login: QR to authorize ── */}
      {status.state === 'needs-login' && status.authUrl && (
        <div className="rounded-card border border-border bg-card p-4 flex flex-col sm:flex-row gap-4 items-center">
          {loginQr && <img src={loginQr} alt="Tailscale sign-in QR code" className="size-40 rounded-control bg-white p-1" />}
          <div className="text-sm space-y-2">
            <div className="font-medium">Approve this server on your tailnet</div>
            <p className="text-muted-foreground">
              Scan with your phone, or open the link, and sign in to your Tailscale account.
              This panel updates by itself once the server is approved.
            </p>
            <a className="inline-flex items-center gap-1.5 text-brand hover:underline break-all" href={status.authUrl} target="_blank" rel="noreferrer">
              {status.authUrl} <ExternalLink className="size-3.5 shrink-0" />
            </a>
          </div>
        </div>
      )}

      {/* ── Running: phone onboarding + devices ── */}
      {status.state === 'running' && (
        <>
          {status.appUrl && (
            <div className="rounded-card border border-border bg-card p-4 flex flex-col sm:flex-row gap-4 items-center">
              {appQr && <img src={appQr} alt="MaiPai Home tailnet address QR code" className="size-40 rounded-control bg-white p-1" />}
              <div className="text-sm space-y-2">
                <div className="font-medium flex items-center gap-2">
                  <Smartphone className="size-4 text-brand" /> MaiPai Home, from anywhere
                </div>
                <p className="text-muted-foreground">
                  Install Tailscale on each family phone, sign in to the same tailnet,
                  then scan this code to open the app away from home.
                </p>
                <code className="block text-xs text-foreground/80 break-all">{status.appUrl}</code>
              </div>
            </div>
          )}

          {status.peers.length > 0 && (
            <div className="space-y-2">
              <div className="text-sm font-medium flex items-center gap-2">
                <Laptop className="size-4 text-muted-foreground" /> Devices on your tailnet
              </div>
              <div className="rounded-card border border-border divide-y divide-border overflow-hidden">
                {status.peers.map((peer) => (
                  <div key={peer.hostName + (peer.ips[0] ?? '')} className="flex items-center gap-3 px-4 py-2.5 bg-card">
                    <span className={cn('size-2 rounded-full shrink-0', peer.online ? 'bg-success' : 'bg-muted-foreground/40')} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate">{peer.hostName}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {[peer.os, peer.ips[0]].filter(Boolean).join(', ')}
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground">{peer.online ? 'Online' : 'Offline'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
