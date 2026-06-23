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
}

// Bun's socket.data typing is awkward across versions; keep per-connection state
// in a WeakMap instead so this stays version-proof.
const conns = new WeakMap<object, SocketState>()

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
          const session = new SatelliteSession((ev) => socket.write(encodeEvent(ev)))
          conns.set(socket, { decoder: new WyomingDecoder(), session })
          registerPod(session) // make it reachable by the scheduler / push producers
          logger.info('[pod] satellite connected')
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
