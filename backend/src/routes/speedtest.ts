import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'

const speedtest = new Hono<AppEnv>()

// Hard caps so a request can never ask the server to push or read an
// unbounded amount of data.
const MAX_DOWNLOAD = 200 * 1024 * 1024 // 200 MB
const DEFAULT_DOWNLOAD = 25 * 1024 * 1024 // 25 MB
const CHUNK = 256 * 1024 // 256 KB per enqueued chunk

// One random, read-only payload reused for every chunk of every download.
// It is filled once and never mutated, so it is safe to enqueue the same
// view repeatedly. Random bytes keep any intermediary from compressing the
// stream and inflating the measured throughput.
const PAYLOAD = new Uint8Array(CHUNK)
for (let off = 0; off < PAYLOAD.length; off += 65536) {
  crypto.getRandomValues(PAYLOAD.subarray(off, Math.min(off + 65536, PAYLOAD.length)))
}

const NO_STORE = 'no-store, no-cache, must-revalidate, max-age=0'

// GET /api/speedtest/ping — tiny round-trip target for latency/jitter.
speedtest.get('/ping', requireAuth, (c) => {
  c.header('Cache-Control', NO_STORE)
  return c.body(null, 204)
})

// GET /api/speedtest/download?bytes=N — stream N bytes of incompressible data.
speedtest.get('/download', requireAuth, (c) => {
  const requested = Number.parseInt(c.req.query('bytes') ?? '', 10)
  const total = Math.min(
    Math.max(Number.isFinite(requested) ? requested : DEFAULT_DOWNLOAD, 1),
    MAX_DOWNLOAD,
  )

  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close()
        return
      }
      const size = Math.min(CHUNK, total - sent)
      controller.enqueue(size === CHUNK ? PAYLOAD : PAYLOAD.subarray(0, size))
      sent += size
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(total),
      'Cache-Control': NO_STORE,
      // Disable proxy buffering so bytes flow as they are produced.
      'X-Accel-Buffering': 'no',
    },
  })
})

// POST /api/speedtest/upload — drain the request body and report the size.
speedtest.post('/upload', requireAuth, async (c) => {
  let received = 0
  const body = c.req.raw.body
  if (body) {
    const reader = body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
    }
  } else {
    received = (await c.req.arrayBuffer()).byteLength
  }
  c.header('Cache-Control', NO_STORE)
  return c.json({ received })
})

export { speedtest }
