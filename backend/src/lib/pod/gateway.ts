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
}

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
    if (n >= chunk.byteLength) { st.out.shift(); continue }
    if (n > 0) st.out[0] = chunk.subarray(n) // partial write — keep the rest at the front
    return // socket buffer full; resume from drain()
  }
}

export function startPodGateway(): void {
  if (process.env.POD_GATEWAY_ENABLED === '0') {
    logger.info('[pod] gateway disabled (POD_GATEWAY_ENABLED=0)')
    return
  }
  const port = parseInt(process.env.POD_GATEWAY_PORT ?? '10700')

  try {
    Bun.listen({
      hostname: '0.0.0.0',
      port,
      socket: {
        open(socket) {
          const st: SocketState = { decoder: new WyomingDecoder(), session: null as unknown as SatelliteSession, out: [] }
          // send() = queue the encoded frame, then flush what the socket will take.
          // Backpressure is held in st.out and resumed on drain — never dropped.
          st.session = new SatelliteSession((ev) => { st.out.push(encodeEvent(ev)); flushSocket(socket, st) })
          conns.set(socket, st)
          registerPod(st.session) // make it reachable by the scheduler / push producers
          logger.info('[pod] satellite connected')
        },
        drain(socket) {
          const st = conns.get(socket)
          if (st) flushSocket(socket, st) // socket writable again — push the backlog
        },
        data(socket, data) {
          const st = conns.get(socket)
          if (!st) return
          for (const ev of st.decoder.push(new Uint8Array(data))) st.session.handle(ev)
        },
        close(socket) {
          const st = conns.get(socket)
          if (st) { unregisterPod(st.session); st.session.close() }
          conns.delete(socket)
          logger.info('[pod] satellite disconnected')
        },
        error(socket, error) {
          logger.warn(`[pod] socket error: ${(error as Error).message}`)
          const st = conns.get(socket)
          if (st) { unregisterPod(st.session); st.session.close() }
          conns.delete(socket)
        },
      },
    })
    logger.info(`[pod] Wyoming gateway listening on tcp://0.0.0.0:${port}`)
  } catch (e) {
    const msg = (e as Error).message
    // Port already held — almost always a previous backend instance that hasn't
    // released :${port} yet (common right after a hot-reload or a SIGKILL). The
    // gateway is optional, so warn and continue instead of logging a scary error.
    if (/EADDRINUSE|address already in use|Failed to listen/i.test(msg)) {
      logger.warn(`[pod] gateway port :${port} already in use — skipping (a previous instance may still hold it; set POD_GATEWAY_ENABLED=0 to disable).`)
    } else {
      logger.error(`[pod] failed to start gateway on :${port}: ${msg}`)
    }
  }
}
