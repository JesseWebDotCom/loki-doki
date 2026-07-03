// Multi-voice narration sessions: detect speakers in arbitrary text, assign each a
// distinct TTS voice, let the client drive playback via the existing /api/tts/stream
// per turn. See backend/src/lib/narration/session.ts for the orchestration.

import { Hono } from 'hono'
import { createReadStream, statSync } from 'node:fs'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { mediaAssets } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { buildSessionFromText, getSession, updateSpeakerVoice } from '@/lib/narration/session'
import { enqueueNarrationRender } from '@/lib/narration/render'
import { acquireRead, blobAbsPath, releaseRead } from '@/lib/content/store'
import type { AppEnv } from '@/types'

export const narration = new Hono<AppEnv>()
narration.use('*', requireAuth)

interface CreateSessionBody {
  text?: string
  title?: string
  sourceType?: 'paste' | 'upload' | 'bookmark' | 'chat_document'
  sourceRef?: string
}

narration.post('/sessions', async (c) => {
  const user = c.get('user')
  const body = (await c.req.json()) as CreateSessionBody
  if (!body.text?.trim()) return c.json({ code: 'empty_text' }, 400)

  const session = await buildSessionFromText({
    userId: user.id,
    text: body.text,
    title: body.title,
    sourceType: body.sourceType,
    sourceRef: body.sourceRef,
  })
  return c.json({ session })
})

narration.get('/sessions/:id', async (c) => {
  const session = await getSession(c.req.param('id'))
  if (!session) return c.json({ code: 'not_found' }, 404)
  return c.json({ session })
})

narration.patch('/sessions/:sessionId/speakers/:speakerId', async (c) => {
  const { sessionId, speakerId } = c.req.param()
  const body = (await c.req.json()) as { voiceId?: string; speechRate?: number }
  try {
    await updateSpeakerVoice(sessionId, speakerId, body)
  } catch (err) {
    return c.json({ code: 'not_found', error: String(err) }, 404)
  }
  const session = await getSession(sessionId)
  return c.json({ session })
})

// Kick off (or reuse) a full MP3/WAV render job — the slow path, contrast with
// live playback which never needs a finished file. Poll GET /sessions/:id/export/:format/download.
narration.post('/sessions/:id/export', async (c) => {
  const sessionId = c.req.param('id')
  const body = (await c.req.json().catch(() => ({}))) as { format?: string }
  const format = body.format === 'wav' ? 'wav' : 'mp3'
  try {
    const { assetId, jobId } = await enqueueNarrationRender(sessionId, format)
    return c.json({ assetId, jobId, ready: jobId === null })
  } catch (err) {
    return c.json({ code: 'export_failed', error: String(err) }, 400)
  }
})

// Lightweight poll target while a render job is in flight — avoids repeatedly
// hitting the (potentially large) download route just to check readiness.
narration.get('/sessions/:sessionId/export/:format/status', async (c) => {
  const { sessionId, format } = c.req.param()
  if (format !== 'mp3' && format !== 'wav') return c.json({ code: 'bad_format' }, 400)
  const [asset] = await db.select({ status: mediaAssets.status, error: mediaAssets.error }).from(mediaAssets).where(and(
    eq(mediaAssets.sourceType, 'narration'), eq(mediaAssets.sourceId, sessionId),
    eq(mediaAssets.kind, 'audio'), eq(mediaAssets.format, format),
  )).limit(1)
  if (!asset) return c.json({ status: 'pending' })
  return c.json({ status: asset.status, error: asset.error })
})

// Serve the rendered file with clamped Range support (seek without re-buffering).
// `pin` holds an in-flight read on the blob so GC can't unlink it mid-stream.
function streamBlob(c: { req: { header(name: string): string | undefined } }, absPath: string, contentType: string, pin: string): Response {
  let stat: ReturnType<typeof statSync>
  try { stat = statSync(absPath) } catch { return Response.json({ error: 'File missing' }, { status: 404 }) }

  const attach = (stream: ReturnType<typeof createReadStream>) => {
    acquireRead(pin)
    const release = () => releaseRead(pin)
    stream.once('close', release)
    stream.once('error', release)
    return stream
  }

  const rangeHeader = c.req.header('range')
  const rangeMatch = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null
  if (rangeMatch) {
    const size = stat.size
    let start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0
    let end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : size - 1
    if (Number.isNaN(start) || start < 0) start = 0
    if (Number.isNaN(end) || end >= size) end = size - 1
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    }
    return new Response(attach(createReadStream(absPath, { start, end })) as any, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Content-Type': contentType,
      },
    })
  }

  return new Response(attach(createReadStream(absPath)) as any, {
    headers: { 'Content-Type': contentType, 'Content-Length': String(stat.size), 'Accept-Ranges': 'bytes' },
  })
}

narration.get('/sessions/:sessionId/export/:format/download', async (c) => {
  const { sessionId, format } = c.req.param()
  if (format !== 'mp3' && format !== 'wav') return c.json({ code: 'bad_format' }, 400)

  const [asset] = await db.select().from(mediaAssets).where(and(
    eq(mediaAssets.sourceType, 'narration'), eq(mediaAssets.sourceId, sessionId),
    eq(mediaAssets.kind, 'audio'), eq(mediaAssets.format, format),
  )).limit(1)
  if (!asset || asset.status !== 'ready' || !asset.blobHash) return c.json({ code: 'not_ready' }, 404)

  const absPath = await blobAbsPath(asset.blobHash)
  return streamBlob(c, absPath, format === 'mp3' ? 'audio/mpeg' : 'audio/wav', asset.blobHash)
})
