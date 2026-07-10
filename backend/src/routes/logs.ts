import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { requireAdmin, requireAuth } from '@/middleware/auth'
import { logger, logRing, logSubscribers } from '@/lib/logger'
import { comfyRing, comfySubscribers } from '@/lib/comfyui'
import type { AppEnv } from '@/types'

const logs = new Hono<AppEnv>()

function sseStream(ring: string[], subscribers: Set<(line: string) => void>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (c: any) =>
    streamSSE(c, async (stream) => {
      for (const line of ring) {
        await stream.writeSSE({ event: 'log', data: line })
      }

      let settle!: () => void
      const settled = new Promise<void>((r) => { settle = r })

      const sub = (line: string) => {
        stream.writeSSE({ event: 'log', data: line }).catch(() => {
          subscribers.delete(sub)
          settle()
        })
      }
      subscribers.add(sub)
      stream.onAbort(() => {
        subscribers.delete(sub)
        settle()
      })

      await settled
    })
}

logs.get('/stream',       requireAdmin, sseStream(logRing,   logSubscribers))
logs.get('/comfy/stream', requireAdmin, sseStream(comfyRing, comfySubscribers))

// Browser-side errors (the ErrorBoundary screen, unhandled rejections) land in the same
// log ring the admin log viewer reads, so "Something went wrong" leaves a diagnosable
// trace instead of vanishing with the tab. Client-throttled; sizes clamped again here.
logs.post('/client', requireAuth, async (c) => {
  const user = c.get('user')
  type Body = { kind?: string; message?: string; stack?: string; componentStack?: string; path?: string }
  const b = await c.req.json<Body>().catch(() => ({} as Body))
  const kind = String(b.kind ?? 'client').slice(0, 40)
  const message = String(b.message ?? '').slice(0, 1000)
  if (!message) return c.json({ ok: false }, 400)
  const detail = [
    b.path && `path=${String(b.path).slice(0, 200)}`,
    b.stack && `\n${String(b.stack).slice(0, 4000)}`,
    b.componentStack && `\ncomponent stack:${String(b.componentStack).slice(0, 2000)}`,
  ].filter(Boolean).join(' ')
  logger.error(`[client:${kind}] user=${user.id} ${message} ${detail}`)
  return c.json({ ok: true })
})

logs.get('/recent', requireAdmin, (c) => {
  const entries = logRing.map((line) => {
    try { return JSON.parse(line) as Record<string, unknown> }
    catch { return { msg: line } }
  })
  return c.json({ entries })
})

export { logs }
