// Create studio API: projects (EDL documents with autosave + GC pinning), the media
// bin (merged libraries + uploads), Range streaming for the editor's preview player,
// and exports through the durable 'studio-render' compute job.

import { Hono } from 'hono'
import { createReadStream } from 'node:fs'
import { stat, readFile } from 'node:fs/promises'
import { and, desc, eq, notInArray } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db } from '@/db'
import { downloadJobs, studioMedia, studioProjectAssets, studioProjects } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { DEFAULT_EDL, edlAssetIds, edlDurationSec, parseEdl } from '@/lib/videostudio/edl'
import { assetBlobPath, ingestUpload, listBin, userOwnsAsset, assetThumbPath, MAX_UPLOAD_BYTES } from '@/lib/videostudio/assets'
import { EXPORT_PRESETS } from '@/lib/videostudio/render/run'
import { enqueueStudioRender } from '@/lib/downloadJobs'
import { convert, ConversionError } from '@/lib/converter/manager'
import type { AppEnv } from '@/types'

const studioRoute = new Hono<AppEnv>()
studioRoute.use('*', requireAuth)

// ── Projects ─────────────────────────────────────────────────────────────────────

studioRoute.get('/projects', async (c) => {
  const user = c.get('user')
  const rows = await db.select({
    id: studioProjects.id, name: studioProjects.name, durationSec: studioProjects.durationSec,
    createdAt: studioProjects.createdAt, updatedAt: studioProjects.updatedAt,
  }).from(studioProjects)
    .where(eq(studioProjects.userId, user.id))
    .orderBy(desc(studioProjects.updatedAt))
  return c.json({ projects: rows })
})

studioRoute.post('/projects', async (c) => {
  const user = c.get('user')
  const body: { name?: string } = await c.req.json().catch(() => ({}))
  const id = randomUUID()
  const now = new Date()
  await db.insert(studioProjects).values({
    id, userId: user.id, name: (body.name ?? '').trim() || 'Untitled project',
    edlJson: JSON.stringify(DEFAULT_EDL), durationSec: 0, createdAt: now, updatedAt: now,
  })
  return c.json({ ok: true, id })
})

studioRoute.get('/projects/:id', async (c) => {
  const user = c.get('user')
  const [row] = await db.select().from(studioProjects)
    .where(and(eq(studioProjects.id, c.req.param('id')), eq(studioProjects.userId, user.id))).limit(1)
  if (!row) return c.json({ error: 'not found' }, 404)
  return c.json({ project: { ...row, edl: JSON.parse(row.edlJson) } })
})

// Autosave: validates the EDL, recomputes duration, and re-diffs the GC pin rows.
studioRoute.put('/projects/:id', async (c) => {
  const user = c.get('user')
  const projectId = c.req.param('id')
  const [row] = await db.select({ id: studioProjects.id }).from(studioProjects)
    .where(and(eq(studioProjects.id, projectId), eq(studioProjects.userId, user.id))).limit(1)
  if (!row) return c.json({ error: 'not found' }, 404)

  const body: { name?: string; edl?: unknown } = await c.req.json().catch(() => ({}))
  const patch: Record<string, unknown> = { updatedAt: new Date() }
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim()

  if (body.edl !== undefined) {
    let edl
    try {
      edl = parseEdl(JSON.stringify(body.edl))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'invalid EDL' }, 400)
    }
    patch.edlJson = JSON.stringify(edl)
    patch.durationSec = edlDurationSec(edl)

    const assetIds = edlAssetIds(edl)
    for (const assetId of assetIds) {
      if (!(await userOwnsAsset(user.id, assetId))) return c.json({ error: 'timeline references media you do not own' }, 403)
      await db.insert(studioProjectAssets).values({ projectId, assetId }).onConflictDoNothing()
    }
    await db.delete(studioProjectAssets).where(and(
      eq(studioProjectAssets.projectId, projectId),
      ...(assetIds.length ? [notInArray(studioProjectAssets.assetId, assetIds)] : []),
    ))
  }

  await db.update(studioProjects).set(patch).where(eq(studioProjects.id, projectId))
  return c.json({ ok: true })
})

studioRoute.delete('/projects/:id', async (c) => {
  const user = c.get('user')
  await db.delete(studioProjects)
    .where(and(eq(studioProjects.id, c.req.param('id')), eq(studioProjects.userId, user.id)))
  return c.json({ ok: true })   // pin rows cascade; assets reclaim on the next GC sweep
})

// ── Export ───────────────────────────────────────────────────────────────────────

studioRoute.post('/projects/:id/export', async (c) => {
  const user = c.get('user')
  const [row] = await db.select().from(studioProjects)
    .where(and(eq(studioProjects.id, c.req.param('id')), eq(studioProjects.userId, user.id))).limit(1)
  if (!row) return c.json({ error: 'not found' }, 404)

  const body: { preset?: string } = await c.req.json().catch(() => ({}))
  const preset = body.preset && EXPORT_PRESETS[body.preset] ? body.preset : '1080p'
  let edl
  try {
    edl = parseEdl(row.edlJson)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'invalid EDL' }, 400)
  }
  if (edl.video.length === 0) return c.json({ error: 'Add at least one clip to the timeline first.' }, 400)

  const exportId = randomUUID()
  const now = new Date()
  await db.insert(studioMedia).values({
    id: exportId, userId: user.id, origin: 'export', kind: 'video',
    title: `${row.name} (${preset})`, assetId: null, status: 'pending',
    durationSec: null, width: null, height: null,
    sourceMeta: JSON.stringify({ projectId: row.id, preset, edlSnapshot: row.edlJson }),
    error: null, createdAt: now, updatedAt: now,
  })
  await enqueueStudioRender(exportId, `Render: ${row.name}`)
  return c.json({ ok: true, exportId })
})

studioRoute.get('/exports/:id', async (c) => {
  const user = c.get('user')
  const [row] = await db.select().from(studioMedia)
    .where(and(eq(studioMedia.id, c.req.param('id')), eq(studioMedia.userId, user.id), eq(studioMedia.origin, 'export'))).limit(1)
  if (!row) return c.json({ error: 'not found' }, 404)
  const [job] = await db.select({ progress: downloadJobs.progress, status: downloadJobs.status }).from(downloadJobs)
    .where(eq(downloadJobs.variantKey, `studio-render:${row.id}`))
    .orderBy(desc(downloadJobs.createdAt)).limit(1)
  return c.json({
    export: { id: row.id, status: row.status, error: row.error, assetId: row.assetId, title: row.title },
    progress: job?.progress ? JSON.parse(job.progress) : null,
  })
})

// ── Media bin ────────────────────────────────────────────────────────────────────

studioRoute.get('/media', async (c) => {
  const user = c.get('user')
  return c.json({ items: await listBin(user.id) })
})

studioRoute.post('/media/upload', async (c) => {
  const user = c.get('user')
  const form = await c.req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File) || file.size === 0) return c.json({ error: 'file required' }, 400)
  if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: 'file too large (4 GB max)' }, 413)
  try {
    const { id } = await ingestUpload(user.id, file.name, new Uint8Array(await file.arrayBuffer()))
    return c.json({ ok: true, id })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'upload failed' }, 400)
  }
})

// Share/unshare a bin video with the household: shared videos appear in other members'
// My Videos Plex libraries (under this owner's show) and stay private otherwise.
studioRoute.patch('/media/:id', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ shared?: boolean; title?: string; description?: string }>().catch(() => ({}) as Record<string, never>)
  const [row] = await db.select().from(studioMedia)
    .where(and(eq(studioMedia.id, c.req.param('id')), eq(studioMedia.userId, user.id)))
    .limit(1)
  if (!row) return c.json({ error: 'not found' }, 404)
  const now = new Date()

  // Rename / describe (independent of sharing). Empty description clears back to null.
  if (typeof body.title === 'string' || typeof body.description === 'string') {
    const patch: Partial<typeof studioMedia.$inferInsert> = { updatedAt: now }
    if (typeof body.title === 'string') patch.title = body.title.trim().slice(0, 200)
    if (typeof body.description === 'string') patch.description = body.description.trim().slice(0, 2000) || null
    await db.update(studioMedia).set(patch).where(eq(studioMedia.id, row.id))
  }

  if (typeof body.shared === 'boolean') {
    if (row.kind !== 'video') return c.json({ error: 'only videos can be shared' }, 400)
    await db.update(studioMedia)
      .set({ sharedAt: body.shared ? now : null, updatedAt: now })
      .where(eq(studioMedia.id, row.id))
    const { fanOutShareChange } = await import('@/lib/videostudio/plexExport')
    void fanOutShareChange(row.id, body.shared).catch(() => {})
    return c.json({ ok: true, sharedAt: body.shared ? now.getTime() : null })
  }
  return c.json({ ok: true, sharedAt: row.sharedAt ? row.sharedAt.getTime() : null })
})

// Delete a studio-owned Mine item (upload / export / recording). Removes the row (its blob
// asset reclaims on the next GC sweep) and pulls any shared copy from members' Plex libraries.
// (AI-generated clips delete via DELETE /api/image/artifacts/:id instead.)
studioRoute.delete('/media/:id', async (c) => {
  const user = c.get('user')
  const [row] = await db.select().from(studioMedia)
    .where(and(eq(studioMedia.id, c.req.param('id')), eq(studioMedia.userId, user.id)))
    .limit(1)
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.sharedAt) {
    const { fanOutMineRemoval } = await import('@/lib/videostudio/plexExport')
    await fanOutMineRemoval(row.id, user.id).catch(() => {})
  }
  await db.delete(studioMedia).where(eq(studioMedia.id, row.id))
  return c.json({ ok: true })
})

// Range-capable source streaming for the editor's preview player.
studioRoute.get('/media/:assetId/stream', async (c) => {
  const user = c.get('user')
  const assetId = c.req.param('assetId')
  if (!(await userOwnsAsset(user.id, assetId))) return c.json({ error: 'not found' }, 404)
  const src = await assetBlobPath(assetId)
  if (!src) return c.json({ error: 'not found' }, 404)

  const contentType = /^(mp3)$/.test(src.format) ? 'audio/mpeg'
    : /^(m4a|aac)$/.test(src.format) ? 'audio/mp4'
    : /^(png)$/.test(src.format) ? 'image/png'
    : /^(jpg|jpeg)$/.test(src.format) ? 'image/jpeg'
    : 'video/mp4'
  const fileStat = await stat(src.path)
  const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec((c.req.header('range') ?? '').trim())
  if (rangeMatch) {
    const size = fileStat.size
    let start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0
    let end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : size - 1
    if (Number.isNaN(start) || start < 0) start = 0
    if (Number.isNaN(end) || end >= size) end = size - 1
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    const stream = createReadStream(src.path, { start, end })
    return new Response(stream as unknown as BodyInit, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Content-Type': contentType,
      },
    })
  }
  const buf = await readFile(src.path)
  return new Response(buf, {
    headers: { 'Content-Type': contentType, 'Content-Length': String(fileStat.size), 'Accept-Ranges': 'bytes' },
  })
})

// Playability check for a bin asset: uploads can be mkv/mov/webm/hevc which not every
// browser decodes. Returns { compatible: true } or the transcode-entry descriptor
// (status/progress/streamUrl) — see lib/mediacompat. `want=audio` yields an audio-only
// rendition (lock-screen background playback).
studioRoute.get('/media/:assetId/compat', async (c) => {
  const user = c.get('user')
  const assetId = c.req.param('assetId')
  if (!(await userOwnsAsset(user.id, assetId))) return c.json({ error: 'not found' }, 404)
  const src = await assetBlobPath(assetId)
  if (!src) return c.json({ error: 'not found' }, 404)
  if (/^(png|jpg|jpeg|webp)$/.test(src.format)) return c.json({ compatible: true, kind: 'image' })
  const { ensureCompat, compatPayload } = await import('@/lib/mediacompat/store')
  const want = c.req.query('want') === 'audio' ? 'audio' as const : 'auto' as const
  try {
    return c.json(compatPayload(await ensureCompat(src.path, want)))
  } catch {
    return c.json({ error: 'not found' }, 404)
  }
})

// Export a bin video to another format (animated WebP / GIF / a different video container) via
// the shared converter. Runs on the blob in place (cleanupSrc: false — never delete the shared
// blob); progress + download reuse the converter's /stream and /artifacts endpoints.
studioRoute.post('/media/:assetId/export-as', async (c) => {
  const user = c.get('user')
  const assetId = c.req.param('assetId')
  if (!(await userOwnsAsset(user.id, assetId))) return c.json({ error: 'not found' }, 404)
  const src = await assetBlobPath(assetId)
  if (!src) return c.json({ error: 'This video is not ready to export yet' }, 409)

  const body = await c.req.json<{ format?: string; name?: string }>().catch(() => ({} as { format?: string; name?: string }))
  const format = body.format?.trim()
  if (!format) return c.json({ error: 'format required' }, 400)

  // srcName only drives the input-ext detection + output base name; the blob path is read as-is.
  const base = (body.name?.trim() || 'video').replace(/[^\w.\- ]/g, '_')
  try {
    const { conversionId, jobId } = await convert({
      userId: user.id,
      firstName: user.firstName,
      srcPath: src.path,
      srcName: `${base}.${src.format}`,
      targetFormat: format,
      cleanupSrc: false,
    })
    return c.json({ conversionId, jobId })
  } catch (err) {
    if (err instanceof ConversionError) return c.json({ error: err.message }, 400)
    throw err
  }
})

studioRoute.get('/media/:assetId/thumb', async (c) => {
  const user = c.get('user')
  const assetId = c.req.param('assetId')
  if (!(await userOwnsAsset(user.id, assetId))) return c.json({ error: 'not found' }, 404)
  const path = await assetThumbPath(assetId)
  if (!path) return c.json({ error: 'not found' }, 404)
  const buf = await readFile(path)
  return new Response(buf, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' } })
})

export { studioRoute }
