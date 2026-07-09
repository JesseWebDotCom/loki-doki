// Shared HTTP Range file serving — extracted from the pattern repeated across
// routes/music.ts, musicStudio.ts, podcasts.ts, videoStream.ts. New audio/video file
// routes should use this instead of re-implementing the 206/416 dance.

import { createReadStream, statSync } from 'node:fs'
import type { Context } from 'hono'

/** Serve a local file with HTTP Range support (seekable <audio>/<video>). Returns 404 when
 *  the file is missing, 416 for an unsatisfiable range, 206 for partials, 200 otherwise.
 *  `cacheControl` defaults to no-cache (media whose bytes can change per request context);
 *  pass a long max-age for immutable-ish assets like extracted album art. */
export function serveFileRange(c: Context, absPath: string, contentType: string, cacheControl = 'no-cache'): Response {
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(absPath)
  } catch {
    return new Response(JSON.stringify({ error: 'Missing' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
  }

  const range = c.req.header('range')
  const m = range?.match(/^bytes=(\d*)-(\d*)$/)
  if (m) {
    const start = m[1] ? parseInt(m[1], 10) : 0
    const end = m[2] ? parseInt(m[2], 10) : stat.size - 1
    if (start >= stat.size || end >= stat.size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } })
    }
    return new Response(createReadStream(absPath, { start, end }) as unknown as ReadableStream, {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheControl,
      },
    })
  }

  return new Response(createReadStream(absPath) as unknown as ReadableStream, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl,
    },
  })
}
