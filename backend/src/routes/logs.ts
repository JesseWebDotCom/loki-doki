import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { requireAdmin } from '@/middleware/auth'
import { logRing, logSubscribers } from '@/lib/logger'
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

logs.get('/recent', requireAdmin, (c) => {
  const entries = logRing.map((line) => {
    try { return JSON.parse(line) as Record<string, unknown> }
    catch { return { msg: line } }
  })
  return c.json({ entries })
})

export { logs }
