import { useEffect, useRef, useState } from 'react'
import RFB from '@novnc/novnc'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'
import { getVncCreds, getRdpCreds, wsUrl, type RemoteHost } from './api'
import { connectRdp, type RdpController } from './rdpClient'

// A single VNC (noVNC) or RDP (IronRDP WASM) remote-desktop surface. Mounts once per session
// tab and stays alive while the tab exists.
export function DisplayPane({ host, kind }: { host: RemoteHost; kind: 'vnc' | 'rdp' }) {
  const [status, setStatus] = useState<'connecting' | 'connected' | 'closed'>('connecting')
  const vncContainerRef = useRef<HTMLDivElement>(null)
  const rdpCanvasRef = useRef<HTMLCanvasElement>(null)
  const rfbRef = useRef<InstanceType<typeof RFB> | null>(null)
  const rdpRef = useRef<RdpController | null>(null)

  useEffect(() => {
    let cancelled = false
    async function go() {
      try {
        if (kind === 'vnc') {
          const { password } = await getVncCreds(host.id)
          const target = vncContainerRef.current
          if (!target || cancelled) return
          const rfb = new RFB(target, wsUrl(`/vnc?host=${encodeURIComponent(host.id)}`), { credentials: { password } })
          rfb.scaleViewport = true
          rfb.addEventListener('connect', () => setStatus('connected'))
          rfb.addEventListener('disconnect', () => setStatus('closed'))
          rfb.addEventListener('securityfailure', () => toast.error('VNC authentication failed'))
          rfbRef.current = rfb
        } else {
          const creds = await getRdpCreds(host.id)
          const canvas = rdpCanvasRef.current
          if (!canvas || cancelled) return
          rdpRef.current = await connectRdp({
            canvas,
            proxyWsUrl: wsUrl(`/rdp?host=${encodeURIComponent(host.id)}`),
            destination: `${host.hostname}:${host.rdp?.port ?? 3389}`,
            username: creds.username,
            password: creds.password,
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
  }, [host, kind])

  return (
    <div className="relative h-full w-full bg-black">
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
    </div>
  )
}
