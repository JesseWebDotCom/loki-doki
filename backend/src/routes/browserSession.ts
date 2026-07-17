import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { requireAuth } from '@/middleware/auth'
import {
  registerBrowserSession, resolveCommandAck, resolveDockRequest,
  type BrowserCommand, type DockRequest, type DockResult, type SessionEntry,
} from '@/lib/pod/browserSession'
import { getArbitrationIp } from '@/lib/clientMachine'
import type { AppEnv } from '@/types'

const browserSessionRoute = new Hono<AppEnv>()

browserSessionRoute.get('/', requireAuth, (c) => {
  const user = c.get('user')
  // Session metadata for voice arbitration: the Doki Dock desktop app registers with
  // dock=1 (surface=hud for the island window). Older clients/pods send neither —
  // they default to a plain web tab, which is the pre-existing behavior.
  const isDock = c.req.query('dock') === '1'
  const surface = c.req.query('surface') === 'hud' ? 'hud' as const : 'app' as const
  // The tab's stable player-device id. Two features address sessions by it: Listening
  // Together targets THIS session (pushToDeviceSession) instead of "the user's most
  // recent tab", and video casting picks a screen to play on. `label`/`tv` are what the
  // cast picker shows; older clients send none of these and aren't addressable.
  const rawDevice = c.req.query('device')
  const deviceId = rawDevice && /^[a-zA-Z0-9_-]{8,64}$/.test(rawDevice) ? rawDevice : null
  const label = c.req.query('label')?.trim().slice(0, 60) || undefined
  const isTv = c.req.query('tv') === '1'
  const ip = getArbitrationIp(c)
  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    // pushToBrowserSession() can fire `send` from a totally unrelated request at any moment,
    // racing the ping loop's own write below. Two unserialized writeSSE calls on the same
    // stream is what was corrupting the chunked-encoding framing (Vite's dev proxy would then
    // misparse the next response's headers) — queue every write so only one is ever in flight.
    let writeQueue: Promise<unknown> = Promise.resolve()
    const enqueueWrite = (fn: () => Promise<unknown>) => (writeQueue = writeQueue.then(fn, fn))
    const entry: SessionEntry = {
      send: (cmd: BrowserCommand) => {
        enqueueWrite(() => stream.writeSSE({ event: 'command', data: JSON.stringify(cmd) }).catch(() => {}))
      },
      sendVoice: (state: { yield: boolean }) => {
        enqueueWrite(() => stream.writeSSE({ event: 'voice', data: JSON.stringify(state) }).catch(() => {}))
      },
      sendDock: (req: DockRequest) => {
        enqueueWrite(() => stream.writeSSE({ event: 'dock', data: JSON.stringify(req) }).catch(() => {}))
      },
      isDock,
      surface,
      ip,
      lastYield: null,
      deviceId,
      label,
      isTv,
    }
    const unregister = registerBrowserSession(user.id, entry)
    // Graceful close (dock quit, tab closed) unregisters immediately so same-machine web
    // tabs un-yield without waiting for the next ping to notice the dead socket.
    stream.onAbort(unregister)
    try {
      while (!stream.closed) {
        await stream.sleep(30_000)
        if (stream.closed) break
        await enqueueWrite(() => stream.writeSSE({ event: 'ping', data: '' }).catch(() => {}))
      }
    } finally {
      unregister()
    }
  })
})

// The app POSTs here once it has actually HANDLED a command carrying an ackId — that's the
// "the action really fired" confirmation the device's follow-up waits on.
browserSessionRoute.post('/ack', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { ackId?: unknown }
  if (typeof body.ackId === 'string') resolveCommandAck(body.ackId)
  return c.json({ ok: true })
})

// The dock's HUD page POSTs a dock request's result here (file listings etc.), resolving
// the companion tool call awaiting it in sendDockRequest.
browserSessionRoute.post('/dock-result', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { requestId?: unknown; result?: unknown }
  if (typeof body.requestId === 'string' && body.result && typeof body.result === 'object') {
    const r = body.result as Record<string, unknown>
    resolveDockRequest(body.requestId, {
      ok: r.ok === true,
      error: typeof r.error === 'string' ? r.error : undefined,
      data: r.data,
    } satisfies DockResult)
  }
  return c.json({ ok: true })
})

export { browserSessionRoute }
