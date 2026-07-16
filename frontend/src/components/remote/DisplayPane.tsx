import { useEffect, useRef, useState } from 'react'
import RFB from '@novnc/novnc'
import { Maximize, Minimize } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'
import { useFullscreenToggle } from '@/hooks/use-fullscreen-toggle'
import { getVncCreds, getRdpCreds, wsUrl, type RemoteHost } from './api'
import { connectRdp, type RdpController } from './rdpClient'

// Where a desktop pane connects: an accessible host, or THIS server's loopback desktop
// (admin-only, PIN-authorized) carrying a single-use WS token + the creds the client needs.
export type DisplayTarget =
  | { mode: 'host'; host: RemoteHost }
  | { mode: 'self'; token: string; vncPassword?: string; rdp?: { username: string; password: string; security: string } }

// A single VNC (noVNC) or RDP (IronRDP WASM) remote-desktop surface. Mounts once per session
// tab and stays alive while the tab exists; it connects a single time on mount (the target
// never changes for a given session), so parent re-renders never tear down the live session.
export function DisplayPane({ target, kind }: { target: DisplayTarget; kind: 'vnc' | 'rdp' }) {
  const [status, setStatus] = useState<'connecting' | 'connected' | 'closed'>('connecting')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const paneRef = useRef<HTMLDivElement>(null)
  const vncContainerRef = useRef<HTMLDivElement>(null)
  const rdpCanvasRef = useRef<HTMLCanvasElement>(null)
  const rfbRef = useRef<InstanceType<typeof RFB> | null>(null)
  const rdpRef = useRef<RdpController | null>(null)
  const toggleFullscreen = useFullscreenToggle(paneRef)

  useEffect(() => {
    let cancelled = false
    async function go() {
      try {
        if (kind === 'vnc') {
          const password = target.mode === 'self' ? (target.vncPassword ?? '') : (await getVncCreds(target.host.id)).password
          const url = target.mode === 'self'
            ? wsUrl(`/vnc?self=${encodeURIComponent(target.token)}`)
            : wsUrl(`/vnc?host=${encodeURIComponent(target.host.id)}`)
          const el = vncContainerRef.current
          if (!el || cancelled) return
          const rfb = new RFB(el, url, { credentials: { password } })
          rfb.scaleViewport = true
          rfb.addEventListener('connect', () => setStatus('connected'))
          rfb.addEventListener('disconnect', () => setStatus('closed'))
          rfb.addEventListener('securityfailure', () => toast.error('VNC authentication failed'))
          rfbRef.current = rfb
        } else {
          const creds = target.mode === 'self'
            ? { username: target.rdp?.username ?? '', password: target.rdp?.password ?? '' }
            : await getRdpCreds(target.host.id)
          // The RDCleanPath proxy ignores the client destination and connects to its bound
          // host/port, so for self mode this string is only nominal (127.0.0.1:3389).
          const destination = target.mode === 'self' ? '127.0.0.1:3389' : `${target.host.hostname}:${target.host.rdp?.port ?? 3389}`
          const proxyWsUrl = target.mode === 'self'
            ? wsUrl(`/rdp?self=${encodeURIComponent(target.token)}`)
            : wsUrl(`/rdp?host=${encodeURIComponent(target.host.id)}`)
          const canvas = rdpCanvasRef.current
          if (!canvas || cancelled) return
          rdpRef.current = await connectRdp({
            canvas, proxyWsUrl, destination, username: creds.username, password: creds.password,
          }, () => setStatus('closed'))
          setStatus('connected')
        }
      } catch (e) {
        if (!cancelled) { toast.error(`Connection failed: ${e instanceof Error ? e.message : e}`); setStatus('closed') }
      }
    }
    void go()
    return () => {
      cancelled = true
      try { rfbRef.current?.disconnect() } catch { /* ignore */ }
      try { rdpRef.current?.disconnect() } catch { /* ignore */ }
      rfbRef.current = null
      rdpRef.current = null
    }
    // Connect once on mount; the session's target/kind are fixed for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Track native fullscreen so the toggle button reflects the current state and swaps its icon.
  useEffect(() => {
    type FsDoc = Document & { webkitFullscreenElement?: Element }
    const onChange = () => {
      const doc = document as FsDoc
      const el = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null
      setIsFullscreen(!!el && el === paneRef.current)
    }
    document.addEventListener('fullscreenchange', onChange)
    document.addEventListener('webkitfullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      document.removeEventListener('webkitfullscreenchange', onChange)
    }
  }, [])

  return (
    <div ref={paneRef} className="group relative h-full w-full bg-black">
      <div ref={vncContainerRef} className="h-full w-full" style={{ display: kind === 'vnc' ? 'block' : 'none' }} />
      <canvas ref={rdpCanvasRef} tabIndex={0} width={1280} height={720}
        className="mx-auto max-h-full max-w-full outline-none" style={{ display: kind === 'rdp' ? 'block' : 'none' }} />
      {status === 'connecting' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-sm text-white/70">
          <Spinner /> Connecting…
        </div>
      )}
      {status === 'closed' && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-white/60">Session closed.</div>
      )}
      <Button
        variant="ghost" size="icon"
        onClick={toggleFullscreen}
        title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        className="absolute right-3 top-3 z-10 bg-black/50 text-white/80 opacity-0 transition hover:bg-black/70 hover:text-white focus-visible:opacity-100 group-hover:opacity-100">
        {isFullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
      </Button>
    </div>
  )
}
