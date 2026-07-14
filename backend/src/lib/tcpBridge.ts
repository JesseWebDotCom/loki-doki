import { connect } from 'node:net'

// A dumb, protocol-agnostic byte relay between a browser WebSocket and a raw TCP socket
// on a homelab host, the websockify-equivalent that backs the VNC (noVNC) and RDP
// (IronRDP WASM) admin proxies. It knows nothing about RFB/RDP; the browser-side WASM/JS
// client speaks the real protocol and this just moves bytes. The caller (a requireAdmin,
// registry-validated WS route) is responsible for only ever pointing it at a host that
// exists in homelab_hosts, never an arbitrary client-supplied address (SSRF).

interface MinimalWs {
  send: (data: string | ArrayBuffer | Uint8Array<ArrayBuffer>) => void
  close: (code?: number, reason?: string) => void
}

export interface TcpBridge {
  /** Bytes from the browser → TCP host. Queued until the socket is connected. */
  write(data: ArrayBuffer | Uint8Array | string): void
  /** Tear down the TCP socket (call from the WS onClose). */
  close(): void
}

export function openTcpBridge(ws: MinimalWs, host: string, port: number): TcpBridge {
  const socket = connect({ host, port })
  let connected = false
  const preOpen: Buffer[] = []

  socket.on('connect', () => {
    connected = true
    for (const b of preOpen) socket.write(b)
    preOpen.length = 0
  })
  // TCP → browser: forward the raw bytes as a binary frame (copy into a plain
  // ArrayBuffer-backed view so the WS type accepts it).
  socket.on('data', (buf: Buffer) => { try { ws.send(new Uint8Array(buf)) } catch { /* client gone */ } })
  socket.on('close', () => { try { ws.close() } catch { /* already closed */ } })
  socket.on('error', () => { try { ws.close(1011, 'tcp bridge error') } catch { /* already closed */ } })

  return {
    write(data) {
      const buf = typeof data === 'string'
        ? Buffer.from(data)
        : Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data))
      if (connected) { try { socket.write(buf) } catch { /* socket gone */ } }
      else preOpen.push(buf)
    },
    close() { try { socket.destroy() } catch { /* already gone */ } },
  }
}
