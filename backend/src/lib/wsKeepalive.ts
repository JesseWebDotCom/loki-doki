import type { ServerWebSocket } from 'bun'

// Supplemental WS keepalive for the long-lived relay sockets (VNC/RDP desktops,
// SSH/host-shell/coding terminals), which go completely silent while the user just
// looks at a static screen — noVNC sends one framebuffer-update request and waits.
//
// Bun itself already pings each client shortly before its own idleTimeout (see the
// websocket config in index.ts), so this is NOT what keeps Bun from reaping the
// socket. It exists for everything else on the path that judges the connection by
// traffic: a TLS reverse proxy in front (nginx kills tunnels quiet for 60s by
// default), NAT/AP idle tables on the LAN. Pings are control frames the browser
// answers automatically, and they never inject bytes into the relayed protocol
// stream (fabricating a data frame would corrupt RFB/RDP framing).

const PING_INTERVAL_MS = 30_000

/** Start pinging the browser on an upgraded socket so intermediaries see steady
 *  traffic while the session is quiet. Call with the hono WSContext once the
 *  connection is accepted (after auth); invoke the returned stop() from onClose. */
export function startWsKeepalive(ws: { raw?: unknown }): () => void {
  const raw = ws.raw as ServerWebSocket | undefined
  if (typeof raw?.ping !== 'function') return () => { /* nothing started */ }
  const timer = setInterval(() => {
    try { raw.ping() } catch { /* socket gone; onClose will stop us */ }
  }, PING_INTERVAL_MS)
  return () => clearInterval(timer)
}
