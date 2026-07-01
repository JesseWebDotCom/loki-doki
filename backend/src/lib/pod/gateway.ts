// Pod gateway — a TCP listener that speaks the Wyoming protocol. Each connecting
// Pod (ESP32 satellite, or the test harness in scripts/pod-test-satellite.ts)
// gets its own SatelliteSession.
//
// Connection direction: the POD connects out to the Host (this server). That's
// firewall-friendly for devices and makes the persistent socket double as the
// push channel for unprompted events (alarms/notifications) in later phases.
//
// NOTE: Wyoming runs over raw TCP, so this is a `Bun.listen` server — separate
// from the Hono/Bun-WS app in index.ts (the `websocket` default-export gotcha
// does not apply here).

import { logger } from '@/lib/logger'
import { WyomingDecoder, encodeEvent } from '@/lib/pod/wyoming'
import { SatelliteSession } from '@/lib/pod/satelliteSession'
import { registerPod, unregisterPod } from '@/lib/pod/registry'

interface SocketState {
  decoder: WyomingDecoder
  session: SatelliteSession
  // Outgoing byte queue. socket.write() accepts only PART of a buffer when the peer
  // (device) is backpressured and returns the count it took; the remainder MUST be
  // retried on `drain` or it's lost. Ignoring this dropped audio chunks + the
  // audio-stop frame on longer replies, corrupting the stream and breaking playback.
  // This is the Bun equivalent of Home Assistant's asyncio writer.write()+drain().
  out: Uint8Array[]
  // Running total of out[]'s bytes (O(1) overflow check — see MAX_QUEUE_BYTES).
  outBytes: number
}

// A device whose TCP connection stays open but stops reading (crashed mid-reply,
// half-open Wi-Fi) would otherwise accumulate an unbounded backlog in `out` — a full
// spoken reply's audio chunks, plus the 30s display refresher, plus alarms — until the
// OS eventually resets the connection. 4 MB is generous headroom over one full reply.
const MAX_QUEUE_BYTES = 4 * 1024 * 1024

// Bun's socket.data typing is awkward across versions; keep per-connection state
// in a WeakMap instead so this stays version-proof.
const conns = new WeakMap<object, SocketState>()

// Flush as much of the queue as the socket accepts; keep the remainder for the next
// `drain`. Never drops bytes — the stream stays intact under backpressure.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function flushSocket(socket: any, st: SocketState): void {
  while (st.out.length > 0) {
    const chunk = st.out[0]!
    let n = 0
    try { n = socket.write(chunk) } catch { return } // socket closing/closed
    if (n >= chunk.byteLength) { st.out.shift(); st.outBytes -= chunk.byteLength; continue }
    if (n > 0) { st.out[0] = chunk.subarray(n); st.outBytes -= n } // partial write — keep the rest at the front
    return // socket buffer full; resume from drain()
  }
}

// Live count of connected satellites (conns is a WeakMap, so it can't be sized).
let connCount = 0

// Observable gateway state — surfaced via gatewayStatus() to Admin → Devices so a
// dropped listener (the classic `bun --hot` reload that silently kills Bun.listen
// while the HTTP API stays up) is VISIBLE instead of a mystery "device won't connect".
interface GatewayState { enabled: boolean; listening: boolean; port: number; error: string; since: number }
const gw: GatewayState = { enabled: true, listening: false, port: 10700, error: '', since: 0 }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any = null

/** Snapshot for the admin UI + health checks. */
export function gatewayStatus(): GatewayState & { connections: number } {
  return { ...gw, connections: connCount }
}

// The socket behaviour, shared by every (re)bind.
const SOCKET_HANDLERS = {
  open(socket: object) {
    const st: SocketState = { decoder: new WyomingDecoder(), session: null as unknown as SatelliteSession, out: [], outBytes: 0 }
    // send() = queue the encoded frame, then flush what the socket will take.
    // Backpressure is held in st.out and resumed on drain — never dropped, UNLESS the
    // backlog exceeds MAX_QUEUE_BYTES, in which case the connection itself is stalled
    // (not just slow) and we drop it rather than let memory grow without bound.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    st.session = new SatelliteSession((ev) => {
      const frame = encodeEvent(ev)
      if (st.outBytes + frame.byteLength > MAX_QUEUE_BYTES) {
        logger.warn(`[pod] outbound queue exceeded ${MAX_QUEUE_BYTES} bytes — dropping stalled connection`)
        try { (socket as any).end() } catch { /* already gone */ }
        return
      }
      st.out.push(frame); st.outBytes += frame.byteLength
      flushSocket(socket as any, st)
    })
    conns.set(socket, st)
    registerPod(st.session) // make it reachable by the scheduler / push producers
    connCount++
    logger.info(`[pod] satellite connected (${connCount} online)`)
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  drain(socket: any) {
    const st = conns.get(socket)
    if (st) flushSocket(socket, st) // socket writable again — push the backlog
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data(socket: any, data: Uint8Array) {
    const st = conns.get(socket)
    if (!st) return
    for (const ev of st.decoder.push(new Uint8Array(data))) st.session.handle(ev)
  },
  close(socket: object) {
    const st = conns.get(socket)
    if (st) { unregisterPod(st.session); st.session.close() }
    conns.delete(socket)
    connCount = Math.max(0, connCount - 1)
    logger.info(`[pod] satellite disconnected (${connCount} online)`)
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error(socket: any, error: Error) {
    logger.warn(`[pod] socket error: ${error.message}`)
    const st = conns.get(socket)
    if (st) { unregisterPod(st.session); st.session.close() }
    conns.delete(socket)
    connCount = Math.max(0, connCount - 1)
  },
}

/** Bind the listener. Returns true if the gateway is up afterwards. EADDRINUSE is
 *  treated as UP: it means a prior (hot-reload) instance still holds the port and is
 *  serving — devices can connect, so it's healthy, not an error to retry forever. */
function bindGateway(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any
  // A `--hot` reload re-evaluates this module but leaves the PREVIOUS instance's
  // listener holding the port — with STALE socket handlers bound to the old session
  // code. Stop it via a globalThis handle so we can bind FRESH handlers; otherwise
  // every device connection keeps running pre-reload code and server-side fixes
  // (e.g. reply-mode / typed replies) silently never take effect. Force-close so the
  // device drops and reconnects onto the new listener.
  if (g.__podGatewayServer) {
    try { g.__podGatewayServer.stop(true) } catch { /* already gone */ }
    g.__podGatewayServer = null
  }
  try {
    server = Bun.listen({ hostname: '0.0.0.0', port: gw.port, socket: SOCKET_HANDLERS })
    g.__podGatewayServer = server
    gw.listening = true; gw.error = ''; gw.since = Date.now()
    logger.info(`[pod] Wyoming gateway listening on tcp://0.0.0.0:${gw.port}`)
    return true
  } catch (e) {
    const msg = (e as Error).message
    // Port still held (just-stopped listener mid-close, or a foreign process). Mark
    // DOWN so the self-heal watchdog re-binds in a moment — do NOT "treat as up", or
    // we'd leave stale handlers serving devices (the bug this whole block fixes).
    gw.listening = false; gw.error = msg; server = null
    logger.warn(`[pod] gateway bind failed on :${gw.port}: ${msg} — self-heal will retry`)
    return false
  }
}

/** Stop the listener (best-effort) and bind a fresh one. Admin "Restart gateway". */
export function restartPodGateway(): GatewayState & { connections: number } {
  logger.info('[pod] gateway restart requested')
  try { server?.stop?.() } catch { /* already gone */ }
  server = null
  gw.listening = false
  bindGateway()
  return gatewayStatus()
}

// Self-heal watchdog: if the listener is ever down (failed bind, dropped on reload),
// keep retrying so the gateway comes back on its own. Guarded on globalThis so a
// `--hot` reload doesn't stack duplicate timers.
function startGatewayHealer(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any
  if (g.__podGatewayHealer) return
  g.__podGatewayHealer = setInterval(() => {
    if (gw.enabled && !gw.listening) {
      logger.warn('[pod] gateway not listening — self-heal re-bind attempt')
      bindGateway()
    }
  }, 5000)
  g.__podGatewayHealer.unref?.()
}

export function startPodGateway(): void {
  if (process.env.POD_GATEWAY_ENABLED === '0') {
    gw.enabled = false
    logger.info('[pod] gateway disabled (POD_GATEWAY_ENABLED=0)')
    return
  }
  gw.enabled = true
  gw.port = parseInt(process.env.POD_GATEWAY_PORT ?? '10700')
  bindGateway()
  startGatewayHealer()
}
