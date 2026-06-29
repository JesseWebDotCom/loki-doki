import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { requireAuth } from '@/middleware/auth'
import { registerBrowserSession, type BrowserCommand } from '@/lib/pod/browserSession'
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

export { browserSessionRoute }
