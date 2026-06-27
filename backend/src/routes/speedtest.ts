import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
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

// ── Server → Internet speed test (SSE stream) ───────────────────────────────
//
// Runs a download-only speed test FROM the server TO Cloudflare's edge, using
// the same LibreSpeed methodology (grace period + multi-stream measure) as the
// client-side tests. Upload is omitted — server egress to Cloudflare is not a
// meaningful metric for the home-server use case.

const SI_PING_COUNT = 9
const SI_DL_STREAMS = 6
const SI_DL_BYTES = 25 * 1024 * 1024
const SI_GRACE_DL = 1200
const SI_MEASURE_DL = 6000
const SI_OVERHEAD = 1.06
const SI_TICK_MS = 120

speedtest.get('/server-internet/stream', requireAuth, async (c) => {
  return streamSSE(c, async (stream) => {
    // ── Ping ─────────────────────────────────────────────────────────────────
    const samples: number[] = []
    for (let i = 0; i < SI_PING_COUNT; i++) {
      const rnd = Math.random().toString(36).slice(2)
      const start = performance.now()
      try {
        const res = await fetch(`https://speed.cloudflare.com/__down?bytes=0&r=${rnd}`, {
          signal: AbortSignal.timeout(5000),
        })
        await res.arrayBuffer()
      } catch { continue }
      const rtt = performance.now() - start
      if (i > 0) samples.push(rtt)
      await stream.writeSSE({
        event: 'progress',
        data: JSON.stringify({
          phase: 'ping', mbps: 0, frac: (i + 1) / SI_PING_COUNT,
          pingMs: samples.length ? Math.min(...samples) : 0,
          jitterMs: 0, downloadMbps: 0, uploadMbps: 0,
        }),
      })
    }

    const pingMs = samples.length ? Math.min(...samples) : 0
    let jitter = 0
    for (let i = 1; i < samples.length; i++) jitter += Math.abs(samples[i]! - samples[i - 1]!)
    const jitterMs = samples.length > 1 ? jitter / (samples.length - 1) : 0

    // ── Download (parallel streams) ───────────────────────────────────────────
    const controller = new AbortController()
    let total = 0
    let streamsDone = false

    const doStream = async () => {
      while (!streamsDone) {
        try {
          const rnd = Math.random().toString(36).slice(2)
          const res = await fetch(
            `https://speed.cloudflare.com/__down?bytes=${SI_DL_BYTES}&r=${rnd}`,
            { signal: controller.signal },
          )
          if (!res.body) {
            const buf = await res.arrayBuffer()
            total += buf.byteLength
            continue
          }
          const reader = res.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) total += value.byteLength
          }
        } catch {
          if (streamsDone) return
        }
      }
    }

    const dlPromises = Array.from({ length: SI_DL_STREAMS }, () => doStream())

    const startWall = performance.now()
    let graceOver = false
    let measureStart = 0
    let base = 0
    let downloadMbps = 0

    for (;;) {
      await new Promise<void>((r) => setTimeout(r, SI_TICK_MS))
      const now = performance.now()
      if (!graceOver) {
        if (now - startWall >= SI_GRACE_DL) { graceOver = true; measureStart = now; base = total }
        await stream.writeSSE({
          event: 'progress',
          data: JSON.stringify({
            phase: 'download', mbps: 0,
            frac: (now - startWall) / (SI_GRACE_DL + SI_MEASURE_DL),
            pingMs, jitterMs, downloadMbps: 0, uploadMbps: 0,
          }),
        })
      } else {
        const secs = (now - measureStart) / 1000
        downloadMbps = secs > 0 ? ((total - base) * 8 / secs / 1e6) * SI_OVERHEAD : 0
        await stream.writeSSE({
          event: 'progress',
          data: JSON.stringify({
            phase: 'download', mbps: downloadMbps,
            frac: Math.min((now - startWall) / (SI_GRACE_DL + SI_MEASURE_DL), 1),
            pingMs, jitterMs, downloadMbps, uploadMbps: 0,
          }),
        })
        if (now - measureStart >= SI_MEASURE_DL) break
      }
    }

    streamsDone = true
    controller.abort()
    await Promise.allSettled(dlPromises)

    await stream.writeSSE({
      event: 'done',
      data: JSON.stringify({
        phase: 'done', mbps: downloadMbps, frac: 1,
        pingMs, jitterMs, downloadMbps, uploadMbps: 0,
      }),
    })
  })
})

export { speedtest }
