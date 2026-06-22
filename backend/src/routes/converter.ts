import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { join } from 'node:path'
import { mkdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { eq, and, desc } from 'drizzle-orm'
import type { AppEnv } from '@/types'
import { requireAuth } from '@/middleware/auth'
import { db } from '@/db'
import { conversions } from '@/db/schema'
import { dataDir } from '@/lib/download'
import * as genQueue from '@/lib/genQueue'
import { resolveUserPath } from '@/lib/storage/paths'
import { convert, capabilities, ConversionError } from '@/lib/converter/manager'

const converter = new Hono<AppEnv>()

// Throwaway location for uploaded source files — the manager deletes each after its job.
const TMP_DIR = join(dataDir, 'tmp', 'converter')

// Minimal extension → MIME map for the download response. Unknowns fall back to a generic
// binary type, which still downloads correctly via Content-Disposition.
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  bmp: 'image/bmp', tiff: 'image/tiff', tif: 'image/tiff', gif: 'image/gif',
  avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac',
  ogg: 'audio/ogg', opus: 'audio/opus', m4a: 'audio/mp4', aiff: 'audio/aiff', wma: 'audio/x-ms-wma',
  mp4: 'video/mp4', mkv: 'video/x-matroska', mov: 'video/quicktime', webm: 'video/webm',
  avi: 'video/x-msvideo', m4v: 'video/x-m4v', wmv: 'video/x-ms-wmv', flv: 'video/x-flv',
}

// GET /api/converter/capabilities — per-family input/output format lists (vips-aware).
// Drives the frontend format picker.
converter.get('/capabilities', requireAuth, async (c) => {
  return c.json(await capabilities())
})

// GET /api/converter/recent — the caller's recent conversions for the history list.
converter.get('/recent', requireAuth, async (c) => {
  const user = c.get('user')
  const rows = await db.select().from(conversions)
    .where(eq(conversions.userId, user.id))
    .orderBy(desc(conversions.createdAt))
    .limit(50)
  return c.json({ conversions: rows })
})

// POST /api/converter/convert — multipart: file + targetFormat (+ optional quality).
// Saves the upload to a temp path, enqueues the job, returns { conversionId, jobId }.
converter.post('/convert', requireAuth, async (c) => {
  const user = c.get('user')
  const form = await c.req.formData()
  const file = form.get('file') as File | null
  const targetFormat = (form.get('targetFormat') as string | null)?.trim()
  const qualityRaw = form.get('quality') as string | null

  if (!file) return c.json({ error: 'file required' }, 400)
  if (!targetFormat) return c.json({ error: 'targetFormat required' }, 400)

  const quality = qualityRaw ? Math.min(100, Math.max(1, parseInt(qualityRaw, 10))) : undefined
  const srcName = file.name || 'upload'

  await mkdir(TMP_DIR, { recursive: true })
  const srcPath = join(TMP_DIR, `${crypto.randomUUID()}-${srcName.replace(/[^\w.\-]/g, '_')}`)
  await Bun.write(srcPath, Buffer.from(await file.arrayBuffer()))

  try {
    const { conversionId, jobId } = await convert({
      userId: user.id,
      firstName: user.firstName,
      srcPath,
      srcName,
      targetFormat,
      quality,
      cleanupSrc: true,
    })
    return c.json({ conversionId, jobId })
  } catch (err) {
    // Validation failure (unsupported pair) — no job was created, so clean up the upload now.
    await unlink(srcPath).catch(() => {})
    if (err instanceof ConversionError) return c.json({ error: err.message }, 400)
    throw err
  }
})

// GET /api/converter/stream/:jobId — SSE progress (start → done|error) via the shared
// genQueue tail primitive. Disconnect never cancels the job.
converter.get('/stream/:jobId', requireAuth, async (c) => {
  const user = c.get('user')
  const jobId = c.req.param('jobId')
  const job = genQueue.get(jobId)
  if (!job || job.userId !== user.id) return c.json({ error: 'Job not found' }, 404)
  return streamSSE(c, async (stream) => {
    await genQueue.subscribeAndTail(stream, job, 0)
  })
})

// POST /api/converter/cancel/:jobId — explicit cancel (owner only).
converter.post('/cancel/:jobId', requireAuth, async (c) => {
  const user = c.get('user')
  const ok = genQueue.cancel(c.req.param('jobId'), user.id)
  return c.json({ ok })
})

// GET /api/converter/artifacts/:id — download the converted file.
converter.get('/artifacts/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(conversions)
    .where(and(eq(conversions.id, id), eq(conversions.userId, user.id)))
    .limit(1)

  if (!row) return c.json({ error: 'Not found' }, 404)
  if (row.state !== 'ready' || !row.relPath) return c.json({ error: 'Not ready', state: row.state }, 409)

  const abs = await resolveUserPath(row.relPath)
  if (!existsSync(abs)) return c.json({ error: 'File missing' }, 410)

  return new Response(Bun.file(abs), {
    headers: {
      'Content-Type': MIME[row.outputFormat] ?? 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${row.outputName.replace(/"/g, '')}"`,
      'Cache-Control': 'private, max-age=86400',
    },
  })
})

export { converter }
