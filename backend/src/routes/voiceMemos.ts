import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'
import { join } from 'node:path'
import { mkdir, writeFile, rm, readFile, stat, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { eq, and, desc } from 'drizzle-orm'
import { db } from '@/db'
import { voiceMemos } from '@/db/schema'
import { dataDir } from '@/lib/download'
import { ffmpegBin } from '@/lib/ffmpeg'
import { transcribeWav } from '@/lib/whisper'
import { logger } from '@/lib/logger'

const memosDir = (userId: string) => join(dataDir, 'voice-memos', userId)

/** Transcode arbitrary uploaded audio to 16 kHz mono WAV via ffmpeg (returns bytes). */
async function toWav(input: Uint8Array): Promise<Uint8Array> {
  const tmpIn = join(dataDir, 'voice-memos', `_tmp_${randomUUID()}`)
  await mkdir(join(dataDir, 'voice-memos'), { recursive: true })
  await writeFile(tmpIn, input)
  try {
    const proc = Bun.spawn([ffmpegBin(), '-i', tmpIn, '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1'], {
      stdout: 'pipe', stderr: 'ignore',
    })
    const wav = new Uint8Array(await new Response(proc.stdout).arrayBuffer())
    await proc.exited
    if (wav.byteLength < 45) throw new Error('ffmpeg produced no audio')
    return wav
  } finally {
    await rm(tmpIn, { force: true }).catch(() => {})
  }
}

const voiceMemosRoute = new Hono<AppEnv>()

// POST /api/voice/memos — multipart { audio, duration_ms, session_id? }
voiceMemosRoute.post('/', requireAuth, async (c) => {
  const user = c.get('user')
  const form = await c.req.formData().catch(() => null)
  const audio = form?.get('audio')
  if (!(audio instanceof File) || audio.size === 0) return c.json({ error: 'audio file required' }, 400)
  const durationMs = Number(form?.get('duration_ms') ?? 0) || 0
  const sessionId = (form?.get('session_id') as string | null)?.trim() || null

  const raw = new Uint8Array(await audio.arrayBuffer())
  let wav: Uint8Array
  try {
    wav = await toWav(raw)
  } catch (e) {
    return c.json({ error: `Could not process audio: ${e}` }, 400)
  }

  const id = randomUUID()
  const dir = memosDir(user.id)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${id}.wav`)
  const tmp = `${path}.tmp`
  await writeFile(tmp, wav)
  await rename(tmp, path)

  // Best-effort transcription — never fail the upload if whisper is cold/down.
  let transcript: string | null = null
  try {
    const text = (await transcribeWav(wav)).trim()
    transcript = text || null
  } catch (e) {
    logger.warn(`[voice-memos] transcription failed: ${e}`)
  }

  const now = new Date()
  await db.insert(voiceMemos).values({
    id, userId: user.id, sessionId, path, mime: 'audio/wav',
    durationMs, transcript, createdAt: now, updatedAt: now,
  })

  return c.json({ id, sessionId, durationMs, transcript, createdAt: now.getTime() })
})

// GET /api/voice/memos — list current user's memos
voiceMemosRoute.get('/', requireAuth, async (c) => {
  const user = c.get('user')
  const rows = await db
    .select({
      id: voiceMemos.id, sessionId: voiceMemos.sessionId, durationMs: voiceMemos.durationMs,
      transcript: voiceMemos.transcript, createdAt: voiceMemos.createdAt,
    })
    .from(voiceMemos)
    .where(eq(voiceMemos.userId, user.id))
    .orderBy(desc(voiceMemos.createdAt))
  return c.json({ memos: rows.map((r) => ({ ...r, createdAt: r.createdAt.getTime() })) })
})

// GET /api/voice/memos/:id — stream the WAV (ownership-checked)
voiceMemosRoute.get('/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const [row] = await db.select().from(voiceMemos)
    .where(and(eq(voiceMemos.id, c.req.param('id')), eq(voiceMemos.userId, user.id))).limit(1)
  if (!row || !existsSync(row.path)) return c.json({ error: 'not_found' }, 404)
  const buf = await readFile(row.path)
  const size = (await stat(row.path)).size
  return c.body(buf, 200, { 'Content-Type': row.mime, 'Content-Length': String(size) })
})

// DELETE /api/voice/memos/:id
voiceMemosRoute.delete('/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const [row] = await db.select().from(voiceMemos)
    .where(and(eq(voiceMemos.id, c.req.param('id')), eq(voiceMemos.userId, user.id))).limit(1)
  if (!row) return c.json({ error: 'not_found' }, 404)
  await rm(row.path, { force: true }).catch(() => {})
  await db.delete(voiceMemos).where(eq(voiceMemos.id, row.id))
  return c.json({ ok: true })
})

export { voiceMemosRoute }
