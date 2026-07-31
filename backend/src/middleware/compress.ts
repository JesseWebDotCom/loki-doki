// gzip for JSON API responses. Search/browse payloads run tens-to-hundreds of KB of
// highly repetitive JSON; gzip cuts them ~5-10x for a fraction of a millisecond of CPU.
//
// Deliberately narrow: only fully-buffered `application/json` 200s are touched. SSE
// (text/event-stream), images, video/HLS bodies and anything already content-encoded pass
// through untouched — those are streams we must not buffer (and compressing media bytes is
// wasted work anyway). The content-type gate is what guarantees the body is one of Hono's
// buffered c.json() responses, so reading it here is safe.

import { createMiddleware } from 'hono/factory'

// Below this, gzip overhead (headers + a dictionary that never warms up) isn't worth it.
const MIN_BYTES = 1024

export const gzipJson = createMiddleware(async (c, next) => {
  await next()
  const res = c.res
  if (res.status !== 200) return
  if (res.headers.get('content-encoding')) return
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) return
  if (!/\bgzip\b/i.test(c.req.header('accept-encoding') ?? '')) return

  const body = new Uint8Array(await res.arrayBuffer())
  if (body.byteLength <= MIN_BYTES) {
    // Too small to bother — but the body was consumed above, so rewrap it as-is.
    c.res = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
    return
  }
  const headers = new Headers(res.headers)
  headers.delete('content-length')   // stale after compression; Bun recomputes it
  headers.set('content-encoding', 'gzip')
  headers.set('vary', 'accept-encoding')
  c.res = new Response(Bun.gzipSync(body), { status: res.status, statusText: res.statusText, headers })
})
