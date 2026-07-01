import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { requireAuth } from '@/middleware/auth'
import { registerBrowserSession, resolveCommandAck, type BrowserCommand } from '@/lib/pod/browserSession'
import type { AppEnv } from '@/types'

const browserSessionRoute = new Hono<AppEnv>()

browserSessionRoute.get('/', requireAuth, (c) => {
  const user = c.get('user')
  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    const send = (cmd: BrowserCommand) => {
      void stream.writeSSE({ event: 'command', data: JSON.stringify(cmd) }).catch(() => {})
    }
    const unregister = registerBrowserSession(user.id, send)
    try {
      while (!stream.closed) {
        await stream.sleep(30_000)
        if (stream.closed) break
        await stream.writeSSE({ event: 'ping', data: '' }).catch(() => {})
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

export { browserSessionRoute }
